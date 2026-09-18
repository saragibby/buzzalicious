import { Platform, Role } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { seedAll } from '../../prisma/seed/index';
import { brandId, userId, workspaceId } from '../../prisma/seed/workspaces';
import { createApp } from '../../src/http/app';
import {
  requireBrandAccess,
  requireWorkspaceAccess,
} from '../../src/modules/identity/authorization';
import { disconnectPrisma, getPrisma, type Db } from '../../src/platform/db';
import {
  TenantScopeViolationError,
  UnscopedTenantAccessError,
  withTenantScope,
} from '../../src/platform/tenancy';
import { ForbiddenError, NotFoundError } from '../../src/platform/errors';
import { hasTestDatabase } from '../env';

/**
 * Tenancy isolation, asserted against the real two-tenant seed.
 *
 * The thing these tests exist to prevent is subtle: a scoping bug and a correct denial
 * look identical from the outside if the assertion is "the list came back empty". An
 * empty list is what a *broken* filter returns too — and in production the difference is
 * whether another client's brand is visible.
 *
 * So every denial here asserts a thrown `NotFoundError` or a genuine HTTP status, never
 * an absent row. Two boundaries are covered because they fail differently:
 *
 *  - **cross-brand**, inside one workspace — the scope resolved but pointed at the wrong
 *    brand, which is what a handler passing the wrong id looks like;
 *  - **cross-workspace** — the user has no membership at all, which is what a leaked or
 *    guessed id looks like.
 *
 * Both answer 404, deliberately and identically. A 403 would confirm the id exists,
 * turning any brand id into an enumeration oracle against every other tenant.
 */

const RISE = {
  workspaceId: workspaceId('rise-and-shore'),
  brandId: brandId('rise-and-shore'),
  ownerId: userId('owner@riseandshore.example'),
};

const TAXDEDUX = {
  workspaceId: workspaceId('taxdedux'),
  brandId: brandId('taxdedux'),
  ownerId: userId('owner@taxdedux.example'),
};

const SHARED_ADMIN_ID = userId('sara@buzzalicious.example');

describe.skipIf(!hasTestDatabase)('tenancy isolation', () => {
  let db: Db;

  beforeAll(async () => {
    db = getPrisma();
    await seedAll(db);
  }, 120_000);

  afterAll(async () => {
    await disconnectPrisma();
  });

  describe('positive control', () => {
    // Without this, every denial test below could be passing because the whole fixture is
    // wrong rather than because the boundary works.
    it('lets a workspace owner read their own brand', async () => {
      const access = await requireBrandAccess(RISE.ownerId, RISE.brandId);

      expect(access.brand.id).toBe(RISE.brandId);
      expect(access.workspaceId).toBe(RISE.workspaceId);
      expect(access.role).toBe(Role.OWNER);
    });

    it('sees every brand in its own workspace, and only those', async () => {
      const { db: scoped } = await requireWorkspaceAccess(RISE.ownerId, RISE.workspaceId);
      const brands = await scoped.brand.findMany({});

      expect(brands.length).toBeGreaterThan(0);
      for (const brand of brands) {
        expect(brand.workspaceId).toBe(RISE.workspaceId);
      }
    });
  });

  describe('cross-workspace denial', () => {
    it('refuses a workspace the user is not a member of', async () => {
      await expect(
        requireWorkspaceAccess(RISE.ownerId, TAXDEDUX.workspaceId),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('refuses a brand in a workspace the user is not a member of', async () => {
      await expect(requireBrandAccess(RISE.ownerId, TAXDEDUX.brandId)).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });

    it('answers identically for a real other-tenant brand and one that does not exist', async () => {
      const real = await requireBrandAccess(RISE.ownerId, TAXDEDUX.brandId).catch(
        (error: NotFoundError) => error,
      );
      const imaginary = await requireBrandAccess(
        RISE.ownerId,
        '00000000-0000-4000-8000-000000000000',
      ).catch((error: NotFoundError) => error);

      // Byte-identical on purpose. Any difference — status, message, timing class — tells
      // an attacker which ids are real in a tenant they cannot see.
      expect(real).toBeInstanceOf(NotFoundError);
      expect(imaginary).toBeInstanceOf(NotFoundError);
      expect((real as NotFoundError).status).toBe((imaginary as NotFoundError).status);
      expect((real as NotFoundError).message).toBe((imaginary as NotFoundError).message);
    });

    it('cannot read another tenant\u2019s brand even with a valid scope and the right id', async () => {
      const { db: scoped } = await requireWorkspaceAccess(RISE.ownerId, RISE.workspaceId);

      // The id is real and correct; the scope is real and correct. It is the combination
      // that must not resolve.
      const leaked = await scoped.brand.findUnique({ where: { id: TAXDEDUX.brandId } });
      expect(leaked).toBeNull();
    });

    it('cannot write across the boundary either', async () => {
      const { db: scoped } = await requireWorkspaceAccess(RISE.ownerId, RISE.workspaceId);

      // Prisma raises "record not found" because the injected scope makes the row
      // unmatchable — the failure is structural, not a check someone remembered to write.
      await expect(
        scoped.brand.update({
          where: { id: TAXDEDUX.brandId },
          data: { name: 'Should never happen' },
        }),
      ).rejects.toThrow();

      const untouched = await db.brand.findUnique({ where: { id: TAXDEDUX.brandId } });
      expect(untouched?.name).not.toBe('Should never happen');
    });
  });

  describe('cross-brand denial', () => {
    // Deliberately no fixtures. The seed gives each workspace one brand, so the sharp
    // version of this test uses the shared admin — a real user who is a member of *both*
    // tenants — and proves that brand scope is narrower than their membership. Creating a
    // second brand here instead would be a row in a database the seed tests count, and a
    // fixture that races another file is worse than a slightly indirect assertion.

    it('narrows to one brand even for a user entitled to several', async () => {
      const { db: scoped } = await requireBrandAccess(SHARED_ADMIN_ID, RISE.brandId);

      const visible = await scoped.brand.findMany({});
      expect(visible.map((brand) => brand.id)).toEqual([RISE.brandId]);
    });

    it('refuses to answer a query that filters to a different brand', async () => {
      const { db: scoped } = await requireBrandAccess(SHARED_ADMIN_ID, RISE.brandId);

      // Note the failure mode: not `null`, but a throw. `Brand.id` *is* the scope field
      // under a brand scope, so asking for a different id is a contradiction rather than
      // a miss — and the extension says so instead of returning an empty result that
      // reads as "no such brand". The shared admin can reach this brand through the other
      // workspace; they cannot reach it through this scope.
      await expect(
        scoped.brand.findUnique({ where: { id: TAXDEDUX.brandId } }),
      ).rejects.toBeInstanceOf(TenantScopeViolationError);
    });

    it('scopes a brand\u2019s assets to that brand', async () => {
      const { db: scoped } = await requireBrandAccess(RISE.ownerId, RISE.brandId);

      const assets = await scoped.asset.findMany({});
      expect(assets.length).toBeGreaterThan(0);
      for (const asset of assets) {
        expect(asset.brandId).toBe(RISE.brandId);
      }
    });

    it('cannot reach another brand\u2019s assets by id', async () => {
      const { db: scoped } = await requireBrandAccess(SHARED_ADMIN_ID, RISE.brandId);

      const foreign = await db.asset.findFirst({ where: { brandId: TAXDEDUX.brandId } });
      expect(foreign).not.toBeNull();

      // A real id, a real user, a real scope — and still nothing, because the scope is
      // ANDed in rather than merged, so the caller's filter cannot displace it.
      expect(await scoped.asset.findUnique({ where: { id: foreign!.id } })).toBeNull();
    });
  });

  describe('the default is closed', () => {
    it('throws rather than reading a tenant model with no scope', async () => {
      const unscoped = withTenantScope(db, null);

      // Not "returns nothing" — throws. A query that forgot its scope has to be loud,
      // because a silently global read is indistinguishable from a correct one until it
      // is in front of the wrong customer.
      await expect(unscoped.brand.findMany({})).rejects.toBeInstanceOf(UnscopedTenantAccessError);
      await expect(unscoped.asset.findMany({})).rejects.toBeInstanceOf(UnscopedTenantAccessError);
    });

    it('still serves platform-wide models with no scope', async () => {
      const unscoped = withTenantScope(db, null);

      // Categories are global by ADR-0010. Fail-closed must not mean fail-always.
      expect((await unscoped.businessCategory.findMany({ take: 1 })).length).toBe(1);
    });
  });

  describe('role denial is 403, not 404', () => {
    let memberId: string;

    beforeAll(async () => {
      // A MEMBER of Rise & Shore. Distinct from the cross-tenant case on purpose: this
      // user *can* see the workspace, so hiding its existence would be theatre.
      const user = await db.user.upsert({
        where: { email: 'w3-member@riseandshore.example' },
        update: {},
        create: { email: 'w3-member@riseandshore.example', name: 'W3 Member' },
      });
      memberId = user.id;

      await db.membership.upsert({
        where: { userId_workspaceId: { userId: memberId, workspaceId: RISE.workspaceId } },
        update: { role: Role.MEMBER },
        create: { userId: memberId, workspaceId: RISE.workspaceId, role: Role.MEMBER },
      });
    });

    it('admits a member without a role requirement', async () => {
      const access = await requireWorkspaceAccess(memberId, RISE.workspaceId);
      expect(access.role).toBe(Role.MEMBER);
    });

    it('forbids a member from an admin-only action', async () => {
      const error = await requireWorkspaceAccess(memberId, RISE.workspaceId, {
        minimumRole: Role.ADMIN,
      }).catch((caught: ForbiddenError) => caught);

      // 403, not 404. Telling a genuine member "no such workspace" when they are looking
      // at it in the switcher is a bug report, not a security control.
      expect(error).toBeInstanceOf(ForbiddenError);
      expect((error as ForbiddenError).status).toBe(403);
    });

    it('forbids a member from deleting a brand', async () => {
      await expect(
        requireBrandAccess(memberId, RISE.brandId, { minimumRole: Role.ADMIN }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  describe('over HTTP', () => {
    // The service-level tests above prove the boundary. These prove the boundary is what
    // an unauthenticated or wrongly-scoped request actually hits, rather than something
    // the routes bypass.
    it('answers 401 when nobody is signed in', async () => {
      const response = await request(createApp()).get(`/api/brands/${RISE.brandId}`);
      expect(response.status).toBe(401);
    });

    it('answers 401, not 404, for an unauthenticated request to another tenant', async () => {
      // Ordering matters: authentication is resolved before tenancy, so an anonymous
      // caller learns nothing at all about which ids exist.
      const response = await request(createApp()).get(`/api/brands/${TAXDEDUX.brandId}`);
      expect(response.status).toBe(401);
    });
  });

  describe('multi-workspace membership', () => {
    it('resolves each workspace independently for a user in both', async () => {
      // The shared admin is in both tenants. A scope cached per user rather than per
      // request would show up here and nowhere else.
      const rise = await requireWorkspaceAccess(SHARED_ADMIN_ID, RISE.workspaceId);
      const taxdedux = await requireWorkspaceAccess(SHARED_ADMIN_ID, TAXDEDUX.workspaceId);

      expect(rise.workspaceId).toBe(RISE.workspaceId);
      expect(taxdedux.workspaceId).toBe(TAXDEDUX.workspaceId);

      const riseBrands = await rise.db.brand.findMany({});
      const taxdeduxBrands = await taxdedux.db.brand.findMany({});

      expect(riseBrands.every((brand) => brand.workspaceId === RISE.workspaceId)).toBe(true);
      expect(taxdeduxBrands.every((brand) => brand.workspaceId === TAXDEDUX.workspaceId)).toBe(
        true,
      );
    });

    it('still refuses a workspace nobody is a member of', async () => {
      await expect(
        requireWorkspaceAccess(SHARED_ADMIN_ID, '00000000-0000-4000-8000-000000000000'),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });
  describe('scoping composes with encryption at rest', () => {
    // The two guarantees are proved separately elsewhere: encryption.test.ts writes
    // through the unscoped client, and everything above this scopes without writing a
    // secret. Nothing crossed the seam between them, and that seam is one `as unknown as`
    // away from being defeated — `tenancy.ts` already contains such a cast where a
    // `findUnique` is re-dispatched as a `findFirst`. If a refactor broke encryption
    // there, every test in both files would stay green.
    //
    // `withTenantScope` accepting only `Db` — the encryption-extended client — is what
    // makes the composition safe by typing rather than by convention. This asserts the
    // consequence, from the scoped path, against the raw column.
    const PLAINTEXT_TOKEN = 'scoped-write-plaintext-do-not-store-like-this';
    const EXTERNAL_ID = 'w3-scoped-encryption-fixture';
    let accountId: string;

    beforeAll(async () => {
      const { db: scoped } = await requireBrandAccess(RISE.ownerId, RISE.brandId);

      const account = await scoped.socialAccount.create({
        data: {
          brandId: RISE.brandId,
          platform: Platform.LINKEDIN,
          externalId: EXTERNAL_ID,
          accessToken: PLAINTEXT_TOKEN,
          scopes: [],
        },
      });

      accountId = account.id;
    });

    afterAll(async () => {
      await db.socialAccount.deleteMany({ where: { id: accountId } });
    });

    it('stores ciphertext when the write goes through a scoped client', async () => {
      const [row] = await db.$queryRaw<{ accessToken: string }[]>`
        SELECT "accessToken" FROM social_accounts WHERE id = ${accountId}
      `;

      expect(row?.accessToken).toBeTruthy();
      expect(row?.accessToken).not.toContain(PLAINTEXT_TOKEN);
      expect(row?.accessToken).toMatch(/^v1\.k1\./);
    });

    it('still decrypts transparently when read back through the scope', async () => {
      const { db: scoped } = await requireBrandAccess(RISE.ownerId, RISE.brandId);
      const account = await scoped.socialAccount.findUniqueOrThrow({ where: { id: accountId } });

      expect(account.accessToken).toBe(PLAINTEXT_TOKEN);
    });
  });
});
