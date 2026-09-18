import { Prisma } from '@prisma/client';
import type { Db } from './db';

/**
 * Tenant scoping for the Prisma client.
 *
 * ADR-0010 makes every client a `Workspace`, which means a query that forgets its
 * `workspaceId` is not a slow query — it is a cross-tenant data leak. The ADR is explicit
 * that this "must be enforced, not remembered", so this module makes the scoped client the
 * only thing an HTTP route is ever handed, and injects the tenant filter itself.
 *
 * Two failure modes are closed here, and they are different:
 *
 *  - **A route that forgets to scope.** Impossible: `requireWorkspace`/`requireBrand`
 *    attach `req.scope`, and that is the only client a handler can reach. A guarded
 *    client built with a `null` scope throws on any tenant-owned model, so the mistake is
 *    loud rather than global.
 *  - **A route that scopes to the wrong tenant.** A `where` that names a tenant field with
 *    a value different from the active scope throws rather than quietly returning nothing.
 *    An empty result and a denial look identical in a passing test and are very different
 *    in production.
 *
 * This layers on top of the encryption extension in `prisma-encryption.ts`; `$extends`
 * composes, and the scoped client is still the encrypting client. Nothing here may be
 * typed as `PrismaClient` — that would silently drop both layers.
 */

export type TenantScope =
  | { readonly kind: 'workspace'; readonly workspaceId: string }
  | { readonly kind: 'brand'; readonly workspaceId: string; readonly brandId: string };

type Filter = Record<string, unknown>;

interface ScopeRule {
  /** Filter fragment constraining this model to one brand. */
  readonly brand: (brandId: string) => Filter;
  /** Filter fragment constraining this model to one workspace. */
  readonly workspace: (workspaceId: string) => Filter;
  /**
   * Column to stamp onto `create` data, and which part of the scope supplies it. Absent
   * for models reached only through a relation — there is no column to stamp, and the
   * parent row they point at was itself fetched through a scoped client.
   */
  readonly createField?: { readonly field: string; readonly from: 'brandId' | 'workspaceId' };
}

const byBrandColumn: ScopeRule = {
  brand: (brandId) => ({ brandId }),
  workspace: (workspaceId) => ({ brand: { workspaceId } }),
  createField: { field: 'brandId', from: 'brandId' },
};

/**
 * Every model whose rows belong to exactly one tenant.
 *
 * Absent from this list, and deliberately so: `User`, `Workspace` and `Membership` (the
 * identity graph, which authorization has to read *before* a scope exists) and
 * `Template`, `Trend`, `TrendSignal`, `TrendCategoryScore`, `BusinessCategory` (global by
 * ADR-0010 — the pooled signal is the product).
 */
export const TENANT_MODELS = {
  // A brand is identified by its own primary key under a brand scope.
  Brand: {
    brand: (brandId) => ({ id: brandId }),
    workspace: (workspaceId) => ({ workspaceId }),
    createField: { field: 'workspaceId', from: 'workspaceId' },
  },

  Asset: byBrandColumn,
  SocialAccount: byBrandColumn,
  PersonaLayer: byBrandColumn,
  Post: byBrandColumn,
  ShortLink: byBrandColumn,

  // `brandId` is nullable: telemetry can exist without a brand. Under a brand scope that
  // means rows for this brand only; a null-brand row belongs to no tenant and is
  // deliberately invisible to a brand-scoped read.
  AiGeneration: {
    brand: (brandId) => ({ brandId }),
    workspace: (workspaceId) => ({ brand: { workspaceId } }),
    createField: { field: 'brandId', from: 'brandId' },
  },

  // A credential with a null `brandId` is shared across the workspace (docs/10), so a
  // brand-scoped read must see both it and the brand's own. Still workspace-bound.
  PlatformCredential: {
    brand: (brandId) => ({ OR: [{ brandId }, { brandId: null }] }),
    workspace: (workspaceId) => ({ workspaceId }),
    createField: { field: 'workspaceId', from: 'workspaceId' },
  },

  // Reached through a relation. These carry no tenant column of their own, so they are
  // filtered through their parent and stamped by whoever supplies the parent id.
  PostTarget: {
    brand: (brandId) => ({ post: { brandId } }),
    workspace: (workspaceId) => ({ post: { brand: { workspaceId } } }),
  },
  Rendition: {
    brand: (brandId) => ({ post: { brandId } }),
    workspace: (workspaceId) => ({ post: { brand: { workspaceId } } }),
  },
  PostMetric: {
    brand: (brandId) => ({ postTarget: { post: { brandId } } }),
    workspace: (workspaceId) => ({ postTarget: { post: { brand: { workspaceId } } } }),
  },
  LinkClick: {
    brand: (brandId) => ({ shortLink: { brandId } }),
    workspace: (workspaceId) => ({ shortLink: { brand: { workspaceId } } }),
  },
  CredentialAccessLog: {
    brand: (brandId) => ({ credential: { OR: [{ brandId }, { brandId: null }] } }),
    workspace: (workspaceId) => ({ credential: { workspaceId } }),
  },

  // In-flight OAuth authorizations (W6). Reached through the credential they will use for
  // the code exchange, so they inherit that model's shape exactly — including the
  // workspace-shared (`brandId: null`) credential being visible to a brand-scoped read,
  // because connecting an account under a shared app is the ordinary case.
  //
  // The callback itself arrives unauthenticated from the platform and looks a handshake up
  // through the *unscoped* client; that is genuine system work, and the row's own
  // `credentialId` is what re-establishes the tenant afterwards.
  OAuthHandshake: {
    // The handshake's OWN brandId, not its credential's. A workspace-shared credential
    // has `brandId: null` and every brand in the workspace connects through it, so routing
    // this through the credential makes each brand's in-flight handshake — including its
    // encrypted request-token secret — visible to every sibling brand. The handshake is
    // initiated by one brand for one brand; that column is the authority.
    brand: (brandId) => ({ brandId }),
    workspace: (workspaceId) => ({ credential: { workspaceId } }),
  },

  // The usage meter (ADR-0011). Workspace-owned: the workspace is the billing entity, so
  // an unscoped read here would show one client another's spend. `UsageEvent.brandId` is
  // nullable because platform-global work has no brand, which makes it the same shape as
  // AiGeneration above — a null-brand row is deliberately invisible to a brand-scoped read.
  //
  // Emitting from system work (a job, a curation run) goes through the unscoped client, as
  // the UnscopedTenantAccessError message says it should; `emitUsage` binds the workspace
  // explicitly from its input either way.
  UsageEvent: {
    brand: (brandId) => ({ brandId }),
    workspace: (workspaceId) => ({ workspaceId }),
    createField: { field: 'workspaceId', from: 'workspaceId' },
  },
  // Rollups are workspace-level, never brand-level. Under a brand scope the constraint is
  // still the owning workspace, reached through the brand — an empty fragment here would
  // AND to nothing and show one client every other client's spend.
  UsagePeriodRollup: {
    brand: (brandId) => ({ workspace: { brands: { some: { id: brandId } } } }),
    workspace: (workspaceId) => ({ workspaceId }),
    createField: { field: 'workspaceId', from: 'workspaceId' },
  },
} as const satisfies Record<string, ScopeRule>;

export type TenantModel = keyof typeof TENANT_MODELS;

export function isTenantModel(model: string | undefined): model is TenantModel {
  return model !== undefined && model in TENANT_MODELS;
}

/** A tenant-owned model was queried through a client that carries no scope. */
export class UnscopedTenantAccessError extends Error {
  constructor(model: string, operation: string) {
    super(
      `Refusing to run ${model}.${operation}() without a tenant scope. "${model}" rows belong ` +
        `to exactly one workspace (ADR-0010), so an unscoped query would read across ` +
        `tenants. Use the scoped client from requireWorkspace/requireBrand, or — if this ` +
        `genuinely is cross-tenant system work such as an aggregation job — say so ` +
        `explicitly by using the unscoped client from platform/db.ts.`,
    );
    this.name = 'UnscopedTenantAccessError';
  }
}

/** A query named a tenant field with a value the active scope does not permit. */
export class TenantScopeViolationError extends Error {
  constructor(model: string, field: string, requested: unknown, allowed: string) {
    super(
      `${model}.${field} was filtered to ${JSON.stringify(requested)}, but this client is ` +
        `scoped to ${allowed}. Refusing rather than returning an empty result: an empty ` +
        `result reads as "no such row" and hides the access-control mistake.`,
    );
    this.name = 'TenantScopeViolationError';
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date)
  );
}

/**
 * Compound-unique shorthand — `where: { workspaceId_slug: { workspaceId, slug } }` — is
 * accepted by `findUnique` but not by `findFirst`, so flatten it before rewriting the
 * operation. No field in this schema contains an underscore, which is what makes the key
 * shape unambiguous.
 */
function flattenCompoundUniqueKeys(where: Filter): Filter {
  const result: Filter = {};

  for (const [key, value] of Object.entries(where)) {
    if (key.includes('_') && isPlainObject(value)) {
      Object.assign(result, value);
      continue;
    }
    result[key] = value;
  }

  return result;
}

/** The tenant columns a caller might name directly, mapped to the scope value allowed. */
function allowedColumnValues(scope: TenantScope, model: TenantModel): Map<string, string> {
  const allowed = new Map<string, string>();

  if (model === 'Brand') {
    allowed.set('workspaceId', scope.workspaceId);
    if (scope.kind === 'brand') allowed.set('id', scope.brandId);
    return allowed;
  }

  if (model === 'PlatformCredential') {
    allowed.set('workspaceId', scope.workspaceId);
    return allowed;
  }

  if (scope.kind === 'brand' && 'createField' in TENANT_MODELS[model]) {
    const rule = TENANT_MODELS[model] as ScopeRule;
    if (rule.createField?.field === 'brandId') allowed.set('brandId', scope.brandId);
  }

  return allowed;
}

/**
 * Reject a filter that pins a tenant column to something outside the scope.
 *
 * Only top-level equality is checked, and that is on purpose: this is a guard against the
 * plausible mistake — `where: { brandId: req.body.brandId }` — not an attempt to prove
 * anything about arbitrary nested filters. Those are still constrained, because the
 * injected fragment is AND-ed with whatever the caller wrote.
 */
function assertNoConflictingFilter(model: TenantModel, scope: TenantScope, where: unknown): void {
  if (!isPlainObject(where)) return;

  for (const [field, value] of allowedColumnValues(scope, model)) {
    const requested = where[field];
    if (requested === undefined) continue;

    const literal =
      typeof requested === 'string'
        ? requested
        : isPlainObject(requested) && typeof requested.equals === 'string'
          ? requested.equals
          : undefined;

    if (literal !== undefined && literal !== value) {
      throw new TenantScopeViolationError(model, field, requested, value);
    }
  }
}

function scopeFilterFor(model: TenantModel, scope: TenantScope): Filter {
  const rule: ScopeRule = TENANT_MODELS[model];
  return scope.kind === 'brand' ? rule.brand(scope.brandId) : rule.workspace(scope.workspaceId);
}

/**
 * AND the scope onto the caller's filter rather than merging keys.
 *
 * Merging would let a caller's key silently win — the exact bug this module exists to
 * prevent — and AND-ing composes correctly with `OR`, which `PlatformCredential` uses.
 *
 * `preserveTopLevel` keeps the caller's own keys where they were and AND-s the scope
 * fragment alongside them. That is semantically identical — Prisma AND-s top-level keys
 * with `AND` clauses — but it is *not* interchangeable for `update`, `delete` and
 * `upsert`: a `WhereUniqueInput` must carry at least one unique field at the top level,
 * and wrapping the whole filter in `AND` buries it. See `UNIQUE_WRITE_OPERATIONS`.
 */
function applyScopeToWhere(
  model: TenantModel,
  scope: TenantScope,
  where: unknown,
  options: { preserveTopLevel?: boolean } = {},
): Filter {
  assertNoConflictingFilter(model, scope, where);
  const fragment = scopeFilterFor(model, scope);

  if (!isPlainObject(where) || Object.keys(where).length === 0) return fragment;

  if (options.preserveTopLevel) {
    const { AND: existing, ...rest } = where;
    const clauses = existing === undefined ? [] : Array.isArray(existing) ? existing : [existing];
    return { ...rest, AND: [...clauses, fragment] };
  }

  return { AND: [where, fragment] };
}

function stampCreateData(model: TenantModel, scope: TenantScope, data: unknown): unknown {
  const rule: ScopeRule = TENANT_MODELS[model];
  const createField = rule.createField;
  if (!createField) return data;

  const value =
    createField.from === 'brandId'
      ? scope.kind === 'brand'
        ? scope.brandId
        : undefined
      : scope.workspaceId;

  // A workspace-scoped client creating a brand-owned row has no brand to stamp; the
  // caller must name one, and the relation filter still binds it to the workspace.
  if (value === undefined) return data;

  if (Array.isArray(data)) {
    return data.map((entry) => stampCreateData(model, scope, entry));
  }
  if (!isPlainObject(data)) return data;

  const existing = data[createField.field];
  if (typeof existing === 'string' && existing !== value) {
    throw new TenantScopeViolationError(model, createField.field, existing, value);
  }

  // A nested relation connect (`brand: { connect: ... }`) is the caller's own business;
  // stamping the scalar alongside it makes Prisma reject the payload outright.
  const relation = createField.field.replace(/Id$/, '');
  if (relation in data) return data;

  return { ...data, [createField.field]: value };
}

const READ_OPERATIONS = new Set([
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
]);

/**
 * `update`, `delete` and `upsert` accept extra non-unique filters in Prisma 5
 * (extendedWhereUnique), so the scope can be injected directly. A cross-tenant id then
 * raises Prisma's "record not found", which is the correct outcome.
 *
 * The injection must leave the caller's unique field at the *top level* of the `where`.
 * Prisma requires at least one unique field there, and an `AND`-wrapped filter has none —
 * `db.post.update({ where: { AND: [{ id }, { brandId }] } })` is rejected outright with
 * "Argument `where` of type PostWhereUniqueInput needs at least one of `id` arguments".
 *
 * This was wrong until W5 and nothing caught it, because the unit test asserted the shape
 * this module produced rather than a shape Prisma accepts, and no test ever executed a
 * scoped `update` against a database. Every scoped update and soft delete in the app
 * failed at runtime, including `updateBrand` and `deleteBrand`. `tests/db/tenancy.test.ts`
 * now runs the real calls.
 */
const UNIQUE_WRITE_OPERATIONS = new Set(['update', 'delete', 'upsert']);

const BULK_WRITE_OPERATIONS = new Set(['updateMany', 'deleteMany']);

const CREATE_OPERATIONS = new Set(['create', 'createMany', 'createManyAndReturn']);

const FIND_UNIQUE_REWRITES: Record<string, 'findFirst' | 'findFirstOrThrow'> = {
  findUnique: 'findFirst',
  findUniqueOrThrow: 'findFirstOrThrow',
};

/** Prisma delegates are the camel-cased model name: `Brand` -> `db.brand`. */
export function delegateName(model: TenantModel): string {
  return model.charAt(0).toLowerCase() + model.slice(1);
}

type FindFirstDelegate = Record<
  string,
  {
    findFirst: (args: unknown) => Promise<unknown>;
    findFirstOrThrow: (args: unknown) => Promise<unknown>;
  }
>;

/**
 * What the extension should do with one call. Separated from the extension itself so the
 * whole decision table is testable without a database — which matters, because this is
 * the code that decides whether one tenant can read another's rows.
 */
export type ScopePlan =
  | { readonly action: 'passthrough'; readonly args: unknown }
  | { readonly action: 'query'; readonly args: unknown }
  | {
      readonly action: 'rewrite';
      readonly delegate: string;
      readonly operation: 'findFirst' | 'findFirstOrThrow';
      readonly args: unknown;
    };

/**
 * Decide how one Prisma call must be rewritten for the active scope.
 *
 * Throws rather than returning a plan when the call cannot be made safe: no scope at all,
 * or a filter that contradicts the scope.
 */
export function planScopedCall(
  model: string | undefined,
  operation: string,
  args: unknown,
  scope: TenantScope | null,
): ScopePlan {
  if (!isTenantModel(model)) {
    return { action: 'passthrough', args };
  }

  if (scope === null) {
    throw new UnscopedTenantAccessError(model, operation);
  }

  if (!isPlainObject(args)) {
    return { action: 'query', args };
  }

  const rewritten = FIND_UNIQUE_REWRITES[operation];

  if (rewritten) {
    // `findUnique` rejects any non-unique field in its `where`, so the scope cannot be
    // injected into it. It becomes a `findFirst` instead.
    const where = isPlainObject(args.where) ? flattenCompoundUniqueKeys(args.where) : {};
    return {
      action: 'rewrite',
      delegate: delegateName(model),
      operation: rewritten,
      args: { ...args, where: applyScopeToWhere(model, scope, where) },
    };
  }

  if (READ_OPERATIONS.has(operation) || BULK_WRITE_OPERATIONS.has(operation)) {
    return {
      action: 'query',
      args: { ...args, where: applyScopeToWhere(model, scope, args.where) },
    };
  }

  if (UNIQUE_WRITE_OPERATIONS.has(operation)) {
    const patched: Record<string, unknown> = {
      ...args,
      where: applyScopeToWhere(model, scope, args.where, { preserveTopLevel: true }),
    };
    if ('create' in patched) {
      patched.create = stampCreateData(model, scope, patched.create);
    }
    return { action: 'query', args: patched };
  }

  if (CREATE_OPERATIONS.has(operation)) {
    return { action: 'query', args: { ...args, data: stampCreateData(model, scope, args.data) } };
  }

  return { action: 'query', args };
}

/**
 * Build the scoping extension.
 *
 * `scope` of `null` produces a *guarded* client: global models work, and any tenant-owned
 * model throws. That is what a route gets if it is ever wired without a scope resolver,
 * and it is what makes "forgot to scope" a visible failure instead of a silent one.
 *
 * `baseDb` is the unscoped application client, needed only to re-dispatch `findUnique`.
 * Going through the base rather than the scoped client avoids re-entering this extension
 * and AND-ing the same scope on twice; the base client is still the encrypting one, so
 * nothing is lost by the detour.
 */
export function createTenantScopeExtension(scope: TenantScope | null, baseDb: Db) {
  return Prisma.defineExtension({
    name: 'buzzalicious-tenant-scope',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const plan = planScopedCall(model, operation, args, scope);

          if (plan.action === 'rewrite') {
            const delegate = (baseDb as unknown as FindFirstDelegate)[plan.delegate];
            return delegate[plan.operation](plan.args);
          }

          return query(plan.args as typeof args);
        },
      },
    },
  });
}

/**
 * Wrap the application client so every tenant-owned query carries its scope.
 *
 * Pass `null` for the guarded-unscoped client described above.
 */
export function withTenantScope(db: Db, scope: TenantScope | null) {
  return db.$extends(createTenantScopeExtension(scope, db));
}

/** The scoped client's type. Services take this, never `Db` and never `PrismaClient`. */
export type ScopedDb = ReturnType<typeof withTenantScope>;
