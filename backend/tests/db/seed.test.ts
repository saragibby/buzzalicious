import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CredentialMode, MediaType, PostStatus, Role } from '@prisma/client';
import { disconnectPrisma, getPrisma, type Db } from '../../src/platform/db';
import { seedAll, WORKSPACES } from '../../prisma/seed/index';
import { SHARED_ADMIN } from '../../prisma/seed/workspaces';
import { SEND_TIME_SLOTS } from '../../src/modules/brand/category.schemas';
import { hasTestDatabase } from '../env';

/**
 * The seed is infrastructure, not decoration: W3, W4, W6, W7 and W9 all develop against it
 * rather than hand-building fixtures. These tests pin the properties those workstreams are
 * entitled to assume, so a future edit to the seed cannot quietly remove them.
 */
describe.skipIf(!hasTestDatabase)('seed', () => {
  let db: Db;

  beforeAll(async () => {
    db = getPrisma();
    await seedAll(db);
  }, 120_000);

  afterAll(async () => {
    await disconnectPrisma();
  });

  it('is re-runnable without duplicating anything', async () => {
    const before = await counts(db);
    await seedAll(db);
    const after = await counts(db);

    // Developers re-run the seed constantly. If it is not idempotent it is a trap that
    // costs a database reset every time.
    expect(after).toEqual(before);
  }, 120_000);

  it('separates the two sample clients into their own workspaces', async () => {
    const workspaces = await db.workspace.findMany({
      where: { slug: { in: WORKSPACES.map((w) => w.slug) } },
      include: { brands: true },
    });

    // Two tenants, not two brands in one tenant — otherwise nothing ever exercises the
    // isolation boundary that ADR-0010 exists to draw.
    expect(workspaces).toHaveLength(2);
    for (const workspace of workspaces) {
      expect(workspace.brands.length).toBeGreaterThan(0);
    }
  });

  it('makes the configured shared user an admin of every sample workspace', async () => {
    const admin = await db.user.findUniqueOrThrow({
      where: { email: SHARED_ADMIN.email },
      include: { memberships: true },
    });

    expect(admin.memberships).toHaveLength(WORKSPACES.length);
    expect(admin.memberships.every((membership) => membership.role === Role.ADMIN)).toBe(true);
  });

  it('stores only obviously fake credentials', async () => {
    const rows = await db.$queryRaw<{ directToken: string | null; appSecret: string | null }[]>`
      SELECT "directToken", "appSecret" FROM platform_credentials
    `;
    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      for (const value of [row.directToken, row.appSecret]) {
        if (value === null) continue;
        expect(value).toMatch(/^v1\./);
      }
    }

    const credential = await db.platformCredential.findFirstOrThrow({
      where: { mode: CredentialMode.DIRECT_TOKEN },
      select: { id: true },
    });
    const decrypted = await db.platformCredential.findUniqueOrThrow({
      where: { id: credential.id },
    });
    // Anyone who finds one of these in a log should be able to tell at a glance that it
    // is not a real token worth trying against a platform API.
    expect(decrypted.directToken).toContain('seed-fake');
  });

  it('covers every send-time slot for every seeded brand', async () => {
    const brands = await db.brand.findMany({
      where: { workspace: { slug: { in: WORKSPACES.map((w) => w.slug) } } },
      select: { id: true, slug: true },
    });

    for (const brand of brands) {
      const slots = await db.post.findMany({
        where: { brandId: brand.id, scheduleSlot: { not: null } },
        distinct: ['scheduleSlot'],
        select: { scheduleSlot: true },
      });
      const covered = new Set(slots.map((post) => post.scheduleSlot));

      // Send-time learning (docs/06) scores eight buckets. A seed that misses one means
      // W9 develops a ranking that has never seen an empty-versus-sparse comparison.
      for (const slot of SEND_TIME_SLOTS) {
        expect(covered, `${brand.slug} is missing ${slot}`).toContain(slot);
      }
    }
  });

  it('gives the two brands different histories to learn from', async () => {
    const [a, b] = await db.brand.findMany({
      where: { workspace: { slug: { in: WORKSPACES.map((w) => w.slug) } } },
      orderBy: { slug: 'asc' },
      select: { id: true },
    });
    const shape = async (brandId: string) => {
      const posts = await db.post.groupBy({
        by: ['scheduleSlot'],
        where: { brandId },
        _count: true,
      });
      return Object.fromEntries(posts.map((row) => [row.scheduleSlot, row._count]));
    };

    // Identical histories would let a broken recommender look correct.
    expect(await shape(a!.id)).not.toEqual(await shape(b!.id));
  });

  it('includes text-only posts with no renditions at all', async () => {
    const textPosts = await db.post.findMany({
      where: { mediaType: MediaType.TEXT },
      include: { renditions: true },
    });

    // X and Threads text posts are a real shape the publish pipeline must tolerate. If
    // every seeded post has an image, the first time anyone discovers otherwise is in
    // production.
    expect(textPosts.length).toBeGreaterThan(0);
    for (const post of textPosts) {
      expect(post.renditions).toHaveLength(0);
    }
  });

  it('schedules across a DST boundary so the same wall time is two different instants', async () => {
    const scheduled = await db.post.findMany({
      where: { scheduledAt: { not: null }, scheduledLocal: { not: null } },
      select: { scheduledAt: true, scheduledLocal: true, scheduledTz: true },
    });

    const byWallTime = new Map<string, Set<number>>();
    for (const post of scheduled) {
      const wallTime = `${post.scheduledTz}@${post.scheduledLocal!.slice(11)}`;
      const offsets = byWallTime.get(wallTime) ?? new Set<number>();
      const local = Date.parse(`${post.scheduledLocal!}Z`);
      offsets.add(local - post.scheduledAt!.getTime());
      byWallTime.set(wallTime, offsets);
    }

    // "9am local" is not one instant. Something in the seed has to prove that, or the
    // scheduler's DST handling is untested until a November morning goes wrong.
    const crossesDst = [...byWallTime.values()].some((offsets) => offsets.size > 1);
    expect(crossesDst).toBe(true);
  });

  it('agrees with itself about first-party link clicks, and excludes crawlers', async () => {
    const posts = await db.post.findMany({
      where: { status: PostStatus.PUBLISHED, shortLinks: { some: {} } },
      take: 5,
      include: { shortLinks: true, targets: { include: { metrics: true } } },
    });
    expect(posts.length).toBeGreaterThan(0);

    for (const post of posts) {
      const linkIds = post.shortLinks.map((link) => link.id);
      const targets = post.targets.filter((target) => target.metrics.length > 0);
      // Only compare posts whose whole snapshot window has elapsed, otherwise the final
      // figure legitimately lags the click rows.
      if (targets.some((target) => target.metrics.length < 3)) continue;

      const reported = targets.reduce(
        (total, target) => total + Math.max(...target.metrics.map((m) => m.linkClicks ?? 0)),
        0,
      );
      const real = await db.linkClick.count({
        where: { shortLinkId: { in: linkIds }, isBot: false },
      });

      // First-party numbers are ours. If the snapshot disagrees with the rows it was
      // derived from, W9 cannot tell a bug from a data problem.
      expect(reported).toBe(real);
    }

    // Link-preview crawlers hit every short link on publish. The seed has to contain them,
    // or nothing ever exercises the filtering the outcome signal depends on (docs/06).
    expect(await db.linkClick.count({ where: { isBot: true } })).toBeGreaterThan(0);
  });

  it('leaves published posts in the past', async () => {
    const future = await db.post.count({
      where: { status: PostStatus.PUBLISHED, scheduledAt: { gt: new Date() } },
    });
    expect(future).toBe(0);
  });
});

async function counts(db: Db) {
  const [categories, templates, trends, workspaces, brands, posts, targets, metrics, clicks] =
    await Promise.all([
      db.businessCategory.count(),
      db.template.count(),
      db.trend.count(),
      db.workspace.count(),
      db.brand.count(),
      db.post.count(),
      db.postTarget.count(),
      db.postMetric.count(),
      db.linkClick.count(),
    ]);
  return { categories, templates, trends, workspaces, brands, posts, targets, metrics, clicks };
}
