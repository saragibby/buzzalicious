import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Platform, Role } from '@prisma/client';
import { disconnectPrisma, getPrisma, type Db } from '../../src/platform/db';
import { hasTestDatabase } from '../env';

/**
 * The parts of the schema that are load-bearing promises to other workstreams: tenancy
 * isolation, cascade behaviour, and the uniqueness constraints downstream code will rely
 * on instead of checking for duplicates itself.
 *
 * Each test builds and tears down its own workspace, because these run against the same
 * database as the seed and a test that deletes shared fixtures is a landmine.
 */
describe.skipIf(!hasTestDatabase)('schema constraints', () => {
  let db: Db;
  const created: string[] = [];

  async function makeWorkspace(name: string) {
    const workspace = await db.workspace.create({
      data: { name, slug: `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
    });
    created.push(workspace.id);
    return workspace;
  }

  beforeAll(() => {
    db = getPrisma();
  });

  afterAll(async () => {
    await db.workspace.deleteMany({ where: { id: { in: created } } });
    await disconnectPrisma();
  });

  it('deletes a workspace’s entire object graph with it', async () => {
    const workspace = await makeWorkspace('cascade');
    const brand = await db.brand.create({
      data: {
        workspaceId: workspace.id,
        name: 'Cascade brand',
        slug: 'cascade',
        palette: {},
        typography: {},
        voiceGuide: {},
      },
    });
    const post = await db.post.create({ data: { brandId: brand.id, title: 'Cascade post' } });
    const target = await db.postTarget.create({
      data: { postId: post.id, platform: Platform.X },
    });

    await db.workspace.delete({ where: { id: workspace.id } });

    // Offboarding a client has to actually remove their data, and it should not depend on
    // application code remembering every table.
    expect(await db.brand.findUnique({ where: { id: brand.id } })).toBeNull();
    expect(await db.post.findUnique({ where: { id: post.id } })).toBeNull();
    expect(await db.postTarget.findUnique({ where: { id: target.id } })).toBeNull();
  });

  it('allows one target per platform per post', async () => {
    const workspace = await makeWorkspace('unique-target');
    const brand = await db.brand.create({
      data: {
        workspaceId: workspace.id,
        name: 'Target brand',
        slug: 'target',
        palette: {},
        typography: {},
        voiceGuide: {},
      },
    });
    const post = await db.post.create({ data: { brandId: brand.id } });

    await db.postTarget.create({ data: { postId: post.id, platform: Platform.INSTAGRAM } });

    // The publish pipeline retries. Without this constraint a retry that re-creates the
    // target instead of updating it double-posts to a real audience.
    await expect(
      db.postTarget.create({ data: { postId: post.id, platform: Platform.INSTAGRAM } }),
    ).rejects.toThrow();
  });

  it('keeps workspace slugs unique across tenants', async () => {
    const workspace = await makeWorkspace('slug');
    await expect(
      db.workspace.create({ data: { name: 'Impostor', slug: workspace.slug } }),
    ).rejects.toThrow();
  });

  it('keeps brand slugs unique only within their workspace', async () => {
    const a = await makeWorkspace('slug-a');
    const b = await makeWorkspace('slug-b');
    const data = { name: 'Same name', slug: 'shared', palette: {}, typography: {}, voiceGuide: {} };

    await db.brand.create({ data: { ...data, workspaceId: a.id } });
    // Two clients are allowed to name a brand the same thing. Scoping the constraint to
    // the workspace is the difference between multi-tenant and first-come-first-served.
    await expect(db.brand.create({ data: { ...data, workspaceId: b.id } })).resolves.toBeTruthy();
  });

  it('admits a user to one workspace only once', async () => {
    const workspace = await makeWorkspace('membership');
    const user = await db.user.create({
      data: { email: `member-${Date.now()}@example.test`, name: 'Member' },
    });

    await db.membership.create({
      data: { userId: user.id, workspaceId: workspace.id, role: Role.OWNER },
    });
    await expect(
      db.membership.create({
        data: { userId: user.id, workspaceId: workspace.id, role: Role.MEMBER },
      }),
    ).rejects.toThrow();

    await db.membership.deleteMany({ where: { userId: user.id } });
    await db.user.delete({ where: { id: user.id } });
  });

  it('leaves a post standing when the template it used is deleted', async () => {
    const workspace = await makeWorkspace('template-setnull');
    const brand = await db.brand.create({
      data: {
        workspaceId: workspace.id,
        name: 'Template brand',
        slug: 'template',
        palette: {},
        typography: {},
        voiceGuide: {},
      },
    });
    const template = await db.template.create({
      data: {
        name: 'Disposable',
        slug: `disposable-${Date.now()}`,
        archetype: 'tip',
        layout: {},
        slotSchema: {},
        supportedRatios: [],
      },
    });
    const post = await db.post.create({
      data: { brandId: brand.id, templateId: template.id, templateVersion: 1 },
    });

    await db.template.delete({ where: { id: template.id } });

    // Retiring a template must not erase the posts made with it — those carry the
    // outcome history the recommendation loop learns from.
    const survivor = await db.post.findUnique({ where: { id: post.id } });
    expect(survivor).not.toBeNull();
    expect(survivor?.templateId).toBeNull();
  });
});

describe.skipIf(!hasTestDatabase)('tenancy boundary', () => {
  /**
   * ADR-0010: trends and templates are shared platform-wide, everything user-owned is
   * scoped to a workspace. Asserting it against `information_schema` rather than the
   * Prisma types catches a column added straight to a migration.
   */
  it('puts workspaceId on tenant-owned tables and keeps it off shared ones', async () => {
    const db = getPrisma();
    const rows = await db.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name IN ('workspaceId', 'brandId')
      GROUP BY table_name
    `;
    const tenantScoped = new Set(rows.map((row) => row.table_name));

    // Shared, platform-wide data. A workspace or brand column appearing on any of these
    // would mean a trend or a template had quietly become per-client, which is the
    // decision ADR-0010 exists to prevent drifting.
    for (const table of [
      'business_categories',
      'trends',
      'trend_signals',
      'trend_category_scores',
      'template_category_tags',
    ]) {
      expect(tenantScoped).not.toContain(table);
    }

    // Everything a client owns reaches a workspace, either directly or through a brand.
    for (const table of ['brands', 'platform_credentials', 'assets', 'posts', 'social_accounts']) {
      expect(tenantScoped).toContain(table);
    }

    // Templates are global by default and workspace-scoped when a client makes their own,
    // so the column exists but is nullable.
    const [templateColumn] = await db.$queryRaw<{ is_nullable: string }[]>`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'templates' AND column_name = 'workspaceId'
    `;
    expect(templateColumn?.is_nullable).toBe('YES');

    await disconnectPrisma();
  });
});
