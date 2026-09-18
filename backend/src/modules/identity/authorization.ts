import { Role, type Brand, type Membership, type Workspace } from '@prisma/client';
import { getPrisma, type Db } from '../../platform/db';
import { ForbiddenError, NotFoundError } from '../../platform/errors';
import { withTenantScope, type ScopedDb, type TenantScope } from '../../platform/tenancy';

/**
 * Authorization: what a signed-in user may reach.
 *
 * Deliberately here rather than in `http/`. `requireAuth` answers "is anyone signed in?";
 * everything below answers "may *this* user act on *this* workspace or brand", and that is
 * policy. Keeping it in the module means it can be tested without HTTP, and means a route
 * cannot quietly invent its own variant of the rule.
 *
 * ## Denial semantics
 *
 * | Situation | Response |
 * |---|---|
 * | No session | 401 — `requireAuth`, upstream of this |
 * | Not a member of the workspace | **404** |
 * | Brand does not exist | **404** |
 * | Member, but the role is too low | **403** |
 *
 * Non-membership is a 404 on purpose. A 403 would confirm that the id exists, which turns
 * a brand id into an oracle: iterate ids, keep the ones that answer 403, and you have
 * enumerated every tenant on the platform. A user who is not a member should not be able
 * to tell "exists, not yours" from "does not exist" — because from their side those are
 * the same thing. 403 is reserved for the case where the user can already see the
 * workspace, so its existence is not a secret and the honest answer is "not with that
 * role".
 */

/** Ascending authority. A check is "at least this". */
const ROLE_RANK: Record<Role, number> = {
  [Role.MEMBER]: 1,
  [Role.ADMIN]: 2,
  [Role.OWNER]: 3,
};

export function roleSatisfies(actual: Role, minimum: Role): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[minimum];
}

export interface WorkspaceAccess {
  readonly userId: string;
  readonly workspaceId: string;
  readonly role: Role;
  readonly scope: TenantScope;
  /** Pre-scoped client. The only one a request handler should ever touch. */
  readonly db: ScopedDb;
}

export interface BrandAccess extends WorkspaceAccess {
  readonly brandId: string;
  readonly brand: Brand;
}

export type MembershipWithWorkspace = Membership & { workspace: Workspace };

/** Every workspace the user belongs to. Drives the switcher. */
export async function listMemberships(
  userId: string,
  db: Db = getPrisma(),
): Promise<MembershipWithWorkspace[]> {
  return db.membership.findMany({
    where: { userId },
    include: { workspace: true },
    orderBy: { workspace: { name: 'asc' } },
  });
}

async function findMembership(
  userId: string,
  workspaceId: string,
  db: Db,
): Promise<Membership | null> {
  return db.membership.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
  });
}

/**
 * Resolve a workspace scope, or refuse.
 *
 * `Membership` is global rather than tenant-owned precisely so this can run: resolving a
 * scope cannot itself require a scope.
 */
export async function requireWorkspaceAccess(
  userId: string,
  workspaceId: string,
  options: { minimumRole?: Role; db?: Db } = {},
): Promise<WorkspaceAccess> {
  const db = options.db ?? getPrisma();
  const membership = await findMembership(userId, workspaceId, db);

  if (!membership) {
    throw new NotFoundError('Workspace');
  }

  if (options.minimumRole && !roleSatisfies(membership.role, options.minimumRole)) {
    throw new ForbiddenError(
      `This action requires the ${options.minimumRole.toLowerCase()} role or higher.`,
    );
  }

  const scope: TenantScope = { kind: 'workspace', workspaceId };

  return {
    userId,
    workspaceId,
    role: membership.role,
    scope,
    db: withTenantScope(db, scope),
  };
}

/**
 * Resolve a brand scope, or refuse.
 *
 * The brand is read through the *unscoped* client, and that is not an oversight — it is
 * the one read that cannot be scoped, because the scope is what it is being used to
 * determine. It is contained here, it selects nothing but the tenancy fields needed to
 * make the decision, and its result is never returned to a caller who fails the
 * membership check below. Every subsequent query goes through `access.db`.
 */
export async function requireBrandAccess(
  userId: string,
  brandId: string,
  options: { minimumRole?: Role; db?: Db } = {},
): Promise<BrandAccess> {
  const db = options.db ?? getPrisma();

  const brand = await db.brand.findFirst({
    where: { id: brandId, deletedAt: null },
  });

  // Identical response to "exists but belongs to another tenant", below. That is the
  // point: the two must be indistinguishable from outside.
  if (!brand) {
    throw new NotFoundError('Brand');
  }

  const membership = await findMembership(userId, brand.workspaceId, db);

  if (!membership) {
    throw new NotFoundError('Brand');
  }

  if (options.minimumRole && !roleSatisfies(membership.role, options.minimumRole)) {
    throw new ForbiddenError(
      `This action requires the ${options.minimumRole.toLowerCase()} role or higher.`,
    );
  }

  const scope: TenantScope = {
    kind: 'brand',
    workspaceId: brand.workspaceId,
    brandId: brand.id,
  };

  return {
    userId,
    workspaceId: brand.workspaceId,
    brandId: brand.id,
    brand,
    role: membership.role,
    scope,
    db: withTenantScope(db, scope),
  };
}
