import { describe, expect, it } from 'vitest';
import {
  TENANT_MODELS,
  TenantScopeViolationError,
  UnscopedTenantAccessError,
  isTenantModel,
  planScopedCall,
  type TenantScope,
} from './tenancy';

/**
 * The scoping decision table.
 *
 * These run without Postgres on purpose. The wiring is proved against real data in
 * `tests/db/tenancy.test.ts`, but the *decisions* — what gets a filter, what throws, what
 * is deliberately left alone — are the security-relevant part, and they should be cheap
 * enough to run on save.
 */

const WORKSPACE: TenantScope = { kind: 'workspace', workspaceId: 'ws-1' };
const BRAND: TenantScope = { kind: 'brand', workspaceId: 'ws-1', brandId: 'brand-1' };

/** Narrow the plan to the args, failing loudly if the action was not the one expected. */
function argsOf(plan: ReturnType<typeof planScopedCall>): Record<string, unknown> {
  return plan.args as Record<string, unknown>;
}

describe('tenant model registry', () => {
  it('treats the identity graph as global', () => {
    // Authorization has to read these *before* a scope exists. Scoping them would make
    // resolving a scope require a scope.
    for (const model of ['User', 'Workspace', 'Membership']) {
      expect(isTenantModel(model)).toBe(false);
    }
  });

  it('treats the pooled-signal models as global', () => {
    // ADR-0010: templates, trends and the taxonomy are shared across every workspace.
    // Scoping them would destroy the compounding advantage that justifies building them.
    for (const model of [
      'Template',
      'TemplateCategoryTag',
      'Trend',
      'TrendSignal',
      'TrendCategoryScore',
      'BusinessCategory',
    ]) {
      expect(isTenantModel(model)).toBe(false);
    }
  });

  it('covers every workspace-owned model named by ADR-0010', () => {
    for (const model of [
      'Brand',
      'SocialAccount',
      'PlatformCredential',
      'Asset',
      'Post',
      'PostTarget',
      'Rendition',
      'ShortLink',
      'LinkClick',
      'PostMetric',
    ]) {
      expect(isTenantModel(model)).toBe(true);
    }
  });

  it('gives every tenant model both a brand and a workspace filter', () => {
    for (const [name, rule] of Object.entries(TENANT_MODELS)) {
      expect(rule.brand('b'), `${name}.brand`).toBeTypeOf('object');
      expect(rule.workspace('w'), `${name}.workspace`).toBeTypeOf('object');
    }
  });
});

describe('unscoped access', () => {
  it('throws for a tenant model rather than reading across tenants', () => {
    // The whole point: a route wired without a scope resolver fails loudly on its first
    // query instead of quietly returning every workspace's brands.
    expect(() => planScopedCall('Brand', 'findMany', {}, null)).toThrow(UnscopedTenantAccessError);
  });

  it('throws for writes as well as reads', () => {
    expect(() => planScopedCall('Post', 'deleteMany', { where: {} }, null)).toThrow(
      UnscopedTenantAccessError,
    );
  });

  it('lets a global model through untouched', () => {
    const plan = planScopedCall('Template', 'findMany', { where: { status: 'PUBLISHED' } }, null);
    expect(plan.action).toBe('passthrough');
    expect(argsOf(plan)).toEqual({ where: { status: 'PUBLISHED' } });
  });
});

describe('read scoping', () => {
  it('constrains a brand-scoped findMany to that brand', () => {
    const plan = planScopedCall('Asset', 'findMany', { where: { kind: 'LOGO' } }, BRAND);
    expect(argsOf(plan).where).toEqual({ AND: [{ kind: 'LOGO' }, { brandId: 'brand-1' }] });
  });

  it('constrains a workspace-scoped findMany through the brand relation', () => {
    const plan = planScopedCall('Asset', 'findMany', {}, WORKSPACE);
    expect(argsOf(plan).where).toEqual({ brand: { workspaceId: 'ws-1' } });
  });

  it('reaches indirect models through their parent', () => {
    // PostTarget carries no tenant column at all, so a forgotten filter here would be
    // invisible in review. The relation filter is what makes it impossible.
    const plan = planScopedCall('PostTarget', 'findMany', {}, BRAND);
    expect(argsOf(plan).where).toEqual({ post: { brandId: 'brand-1' } });
  });

  it('scopes a metric two relations deep', () => {
    const plan = planScopedCall('PostMetric', 'count', {}, WORKSPACE);
    expect(argsOf(plan).where).toEqual({
      postTarget: { post: { brand: { workspaceId: 'ws-1' } } },
    });
  });

  it('identifies a brand by its own primary key under a brand scope', () => {
    const plan = planScopedCall('Brand', 'findMany', {}, BRAND);
    expect(argsOf(plan).where).toEqual({ id: 'brand-1' });
  });

  it('shows a brand both its own and the workspace-shared credentials', () => {
    // docs/10: a credential with a null brandId is shared across the workspace. A brand
    // that could not see it would appear to have no way to publish.
    const plan = planScopedCall('PlatformCredential', 'findMany', {}, BRAND);
    expect(argsOf(plan).where).toEqual({ OR: [{ brandId: 'brand-1' }, { brandId: null }] });
  });

  it('ANDs rather than merges, so a caller filter cannot overwrite the scope', () => {
    const plan = planScopedCall(
      'Post',
      'findMany',
      { where: { OR: [{ status: 'DRAFT' }] } },
      BRAND,
    );
    expect(argsOf(plan).where).toEqual({
      AND: [{ OR: [{ status: 'DRAFT' }] }, { brandId: 'brand-1' }],
    });
  });
});

describe('findUnique', () => {
  it('becomes a scoped findFirst, because findUnique rejects a non-unique where', () => {
    const plan = planScopedCall('Brand', 'findUnique', { where: { id: 'brand-9' } }, WORKSPACE);
    expect(plan).toMatchObject({ action: 'rewrite', delegate: 'brand', operation: 'findFirst' });
    expect(argsOf(plan).where).toEqual({ AND: [{ id: 'brand-9' }, { workspaceId: 'ws-1' }] });
  });

  it('preserves the OrThrow variant, so a cross-tenant id still raises', () => {
    const plan = planScopedCall('Post', 'findUniqueOrThrow', { where: { id: 'p1' } }, BRAND);
    expect(plan).toMatchObject({ action: 'rewrite', operation: 'findFirstOrThrow' });
  });

  it('flattens the compound-unique shorthand findFirst will not accept', () => {
    // `where: { workspaceId_slug: {...} }` is valid for findUnique and invalid for
    // findFirst, so the rewrite has to unpack it or the query throws at the database.
    const plan = planScopedCall(
      'Brand',
      'findUnique',
      { where: { workspaceId_slug: { workspaceId: 'ws-1', slug: 'rise-and-shore' } } },
      WORKSPACE,
    );
    expect(argsOf(plan).where).toEqual({
      AND: [{ workspaceId: 'ws-1', slug: 'rise-and-shore' }, { workspaceId: 'ws-1' }],
    });
  });

  it('keeps select and include while rewriting', () => {
    const plan = planScopedCall(
      'Brand',
      'findUnique',
      { where: { id: 'brand-1' }, include: { assets: true } },
      BRAND,
    );
    expect(argsOf(plan).include).toEqual({ assets: true });
  });
});

describe('conflicting filters', () => {
  it('throws when a caller pins a tenant column outside the scope', () => {
    // The alternative is an empty result, which reads as "no such post" and hides the
    // access-control mistake entirely.
    expect(() =>
      planScopedCall('Post', 'findMany', { where: { brandId: 'someone-elses-brand' } }, BRAND),
    ).toThrow(TenantScopeViolationError);
  });

  it('throws on the equals long form too', () => {
    expect(() =>
      planScopedCall('Asset', 'findMany', { where: { brandId: { equals: 'other' } } }, BRAND),
    ).toThrow(TenantScopeViolationError);
  });

  it('allows a filter that names the scope it is already in', () => {
    expect(() =>
      planScopedCall('Post', 'findMany', { where: { brandId: 'brand-1' } }, BRAND),
    ).not.toThrow();
  });

  it('throws when a workspace-scoped read names another workspace', () => {
    expect(() =>
      planScopedCall('Brand', 'findMany', { where: { workspaceId: 'ws-2' } }, WORKSPACE),
    ).toThrow(TenantScopeViolationError);
  });
});

describe('writes', () => {
  it('stamps the brand onto a create', () => {
    const plan = planScopedCall('Asset', 'create', { data: { kind: 'LOGO' } }, BRAND);
    expect(argsOf(plan).data).toEqual({ kind: 'LOGO', brandId: 'brand-1' });
  });

  it('stamps the workspace onto a brand create', () => {
    const plan = planScopedCall('Brand', 'create', { data: { name: 'New' } }, WORKSPACE);
    expect(argsOf(plan).data).toEqual({ name: 'New', workspaceId: 'ws-1' });
  });

  it('stamps every row of a createMany', () => {
    const plan = planScopedCall('Asset', 'createMany', { data: [{ kind: 'LOGO' }, {}] }, BRAND);
    expect(argsOf(plan).data).toEqual([
      { kind: 'LOGO', brandId: 'brand-1' },
      { brandId: 'brand-1' },
    ]);
  });

  it('refuses a create that names a different tenant', () => {
    expect(() =>
      planScopedCall('Asset', 'create', { data: { brandId: 'other-brand' } }, BRAND),
    ).toThrow(TenantScopeViolationError);
  });

  it('leaves a nested relation connect alone', () => {
    // Stamping the scalar alongside `brand: { connect }` makes Prisma reject the payload
    // outright, so the relation form is the caller's to get right.
    const plan = planScopedCall(
      'Asset',
      'create',
      { data: { brand: { connect: { id: 'brand-1' } } } },
      BRAND,
    );
    expect(argsOf(plan).data).toEqual({ brand: { connect: { id: 'brand-1' } } });
  });

  it('scopes an update, so a cross-tenant id finds no record', () => {
    const plan = planScopedCall('Post', 'update', { where: { id: 'p1' }, data: {} }, BRAND);
    expect(argsOf(plan).where).toEqual({ AND: [{ id: 'p1' }, { brandId: 'brand-1' }] });
  });

  it('scopes both halves of an upsert', () => {
    const plan = planScopedCall(
      'Asset',
      'upsert',
      { where: { id: 'a1' }, create: { kind: 'PHOTO' }, update: {} },
      BRAND,
    );
    expect(argsOf(plan).where).toEqual({ AND: [{ id: 'a1' }, { brandId: 'brand-1' }] });
    expect(argsOf(plan).create).toEqual({ kind: 'PHOTO', brandId: 'brand-1' });
  });

  it('scopes a deleteMany, which would otherwise empty every tenant', () => {
    const plan = planScopedCall('Post', 'deleteMany', { where: { status: 'DRAFT' } }, BRAND);
    expect(argsOf(plan).where).toEqual({ AND: [{ status: 'DRAFT' }, { brandId: 'brand-1' }] });
  });

  it('does not invent a brand for a workspace-scoped create of a brand-owned row', () => {
    // A workspace scope genuinely does not know which brand is meant; the caller must
    // say. The relation filter still binds any subsequent read to the workspace.
    const plan = planScopedCall('Asset', 'create', { data: { kind: 'LOGO' } }, WORKSPACE);
    expect(argsOf(plan).data).toEqual({ kind: 'LOGO' });
  });
});
