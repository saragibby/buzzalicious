import { Role } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import type { Db } from '../../platform/db';
import { ForbiddenError, NotFoundError } from '../../platform/errors';
import { requireBrandAccess, requireWorkspaceAccess, roleSatisfies } from './authorization';

/**
 * Denial semantics, without a database.
 *
 * The same rules are proved against the two seeded tenants in `tests/db/tenancy.test.ts`.
 * These cover the decision itself — in particular that "exists but is not yours" and
 * "does not exist" are indistinguishable, which is the property that stops a brand id
 * being an enumeration oracle.
 */

interface FakeBrand {
  id: string;
  workspaceId: string;
  deletedAt: Date | null;
}

interface FakeMembership {
  userId: string;
  workspaceId: string;
  role: Role;
}

/**
 * A stand-in for the two queries authorization makes. `$extends` returns a sentinel: this
 * suite is about the decision, and the scoping extension has its own tests.
 */
function fakeDb(options: { brands?: FakeBrand[]; memberships?: FakeMembership[] } = {}): Db {
  const brands = options.brands ?? [];
  const memberships = options.memberships ?? [];

  return {
    brand: {
      findFirst: ({ where }: { where: { id: string; deletedAt: null } }) =>
        Promise.resolve(brands.find((b) => b.id === where.id && b.deletedAt === null) ?? null),
    },
    membership: {
      findUnique: ({
        where,
      }: {
        where: { userId_workspaceId: { userId: string; workspaceId: string } };
      }) => {
        const { userId, workspaceId } = where.userId_workspaceId;
        return Promise.resolve(
          memberships.find((m) => m.userId === userId && m.workspaceId === workspaceId) ?? null,
        );
      },
    },
    $extends: () => ({ scoped: true }),
  } as unknown as Db;
}

const OWNER_OF_WS1: FakeMembership = { userId: 'user-1', workspaceId: 'ws-1', role: Role.OWNER };
const BRAND_IN_WS1: FakeBrand = { id: 'brand-1', workspaceId: 'ws-1', deletedAt: null };
const BRAND_IN_WS2: FakeBrand = { id: 'brand-2', workspaceId: 'ws-2', deletedAt: null };

describe('roleSatisfies', () => {
  it('reads as "at least this role"', () => {
    expect(roleSatisfies(Role.OWNER, Role.MEMBER)).toBe(true);
    expect(roleSatisfies(Role.ADMIN, Role.ADMIN)).toBe(true);
    expect(roleSatisfies(Role.MEMBER, Role.ADMIN)).toBe(false);
  });
});

describe('requireWorkspaceAccess', () => {
  it('resolves a scope for a member', async () => {
    const access = await requireWorkspaceAccess('user-1', 'ws-1', {
      db: fakeDb({ memberships: [OWNER_OF_WS1] }),
    });

    expect(access.scope).toEqual({ kind: 'workspace', workspaceId: 'ws-1' });
    expect(access.role).toBe(Role.OWNER);
  });

  it('answers 404, not 403, for a workspace the user does not belong to', async () => {
    // A 403 here would confirm the workspace exists, which is exactly the fact a
    // non-member should not be able to learn.
    await expect(
      requireWorkspaceAccess('outsider', 'ws-1', { db: fakeDb({ memberships: [OWNER_OF_WS1] }) }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('answers 403 when the user is a member but outranked', async () => {
    // The workspace's existence is not a secret from someone already inside it, so the
    // honest answer is "not with that role".
    await expect(
      requireWorkspaceAccess('user-2', 'ws-1', {
        minimumRole: Role.ADMIN,
        db: fakeDb({
          memberships: [{ userId: 'user-2', workspaceId: 'ws-1', role: Role.MEMBER }],
        }),
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('requireBrandAccess', () => {
  it('resolves a brand scope for a member of its workspace', async () => {
    const access = await requireBrandAccess('user-1', 'brand-1', {
      db: fakeDb({ brands: [BRAND_IN_WS1], memberships: [OWNER_OF_WS1] }),
    });

    expect(access.scope).toEqual({ kind: 'brand', workspaceId: 'ws-1', brandId: 'brand-1' });
    expect(access.brandId).toBe('brand-1');
  });

  it('denies a brand in another workspace', async () => {
    await expect(
      requireBrandAccess('user-1', 'brand-2', {
        db: fakeDb({ brands: [BRAND_IN_WS1, BRAND_IN_WS2], memberships: [OWNER_OF_WS1] }),
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('denies a brand that exists identically to one that does not', async () => {
    // The crux. If these two answers differed in any observable way, iterating ids would
    // enumerate every tenant on the platform.
    const db = fakeDb({ brands: [BRAND_IN_WS1, BRAND_IN_WS2], memberships: [OWNER_OF_WS1] });

    const otherTenant = await requireBrandAccess('user-1', 'brand-2', { db }).catch(
      (error: unknown) => error,
    );
    const nonexistent = await requireBrandAccess('user-1', 'no-such-brand', { db }).catch(
      (error: unknown) => error,
    );

    expect(otherTenant).toBeInstanceOf(NotFoundError);
    expect(nonexistent).toBeInstanceOf(NotFoundError);
    expect((otherTenant as NotFoundError).message).toBe((nonexistent as NotFoundError).message);
    expect((otherTenant as NotFoundError).status).toBe((nonexistent as NotFoundError).status);
  });

  it('treats a soft-deleted brand as gone', async () => {
    await expect(
      requireBrandAccess('user-1', 'brand-1', {
        db: fakeDb({
          brands: [{ ...BRAND_IN_WS1, deletedAt: new Date() }],
          memberships: [OWNER_OF_WS1],
        }),
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('enforces the minimum role within a workspace the user can see', async () => {
    await expect(
      requireBrandAccess('user-2', 'brand-1', {
        minimumRole: Role.ADMIN,
        db: fakeDb({
          brands: [BRAND_IN_WS1],
          memberships: [{ userId: 'user-2', workspaceId: 'ws-1', role: Role.MEMBER }],
        }),
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
