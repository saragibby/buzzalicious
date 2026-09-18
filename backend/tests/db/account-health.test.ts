import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectPrisma, getPrisma, type Db } from '../../src/platform/db';
import { withTenantScope } from '../../src/platform/tenancy';
import {
  createSystemAccountReader,
  runHealthSweep,
  type SystemAccountReader,
} from '../../src/modules/publish/health.service';
import { revokeCredential } from '../../src/modules/publish/revocation.service';
import { listConnections } from '../../src/modules/publish/connection.service';
import type { AdapterRegistry } from '../../src/modules/publish/adapter.registry';
import type {
  AccountHealth,
  PlatformAdapter,
  TokenSet,
} from '../../src/modules/publish/adapter.types';
import { X_SPEC } from '../../src/modules/publish/x/x.adapter';
import { hasTestDatabase } from '../env';

/**
 * The health sweep and credential revocation, against a real database.
 *
 * These two are grouped because they share the most dangerous property in the workstream:
 * **both act across tenants and both write.** The sweep selects candidates from every
 * workspace by design; revocation fans out to accounts and targets through an
 * `updateMany` whose result count nobody reads.
 *
 * So every assertion here is on the **identity and status of specific rows read back**,
 * with rows that must not change present as controls. Never a count, and never an empty
 * result: an empty `{}` scope fragment is *no filter* rather than a deny, so it leaks more
 * rows than the correct one, and both "expect 0" and "expect 1 changed" pass underneath
 * that bug.
 */

interface Fixture {
  workspaceId: string;
  brandId: string;
  credentialId: string;
  accountId: string;
}

/** A fake adapter. Nothing in this file may reach a social platform. */
function fakeAdapter(behaviour: {
  validate?: () => Promise<AccountHealth>;
  refresh?: () => Promise<TokenSet>;
}): { registry: AdapterRegistry; validated: string[]; refreshed: string[] } {
  const validated: string[] = [];
  const refreshed: string[] = [];

  const adapter = {
    platform: 'X' as const,
    specs: X_SPEC,
    getAuthUrl: async () => 'https://example.test/auth',
    connect: async () => [],
    refresh: async (_c: unknown, account: { externalId: string; tokens: TokenSet }) => {
      refreshed.push(account.externalId);
      if (behaviour.refresh) return behaviour.refresh();
      return { ...account.tokens, accessToken: `refreshed-${randomUUID()}` };
    },
    validate: async (_c: unknown, account: { externalId: string }) => {
      validated.push(account.externalId);
      if (behaviour.validate) return behaviour.validate();
      return { status: 'ACTIVE' as const, checkedAt: new Date() };
    },
    introspect: async () => ({
      status: 'ACTIVE' as const,
      grantedScopes: [],
      capabilities: {},
      summary: 'ok',
      checkedAt: new Date(),
    }),
    publish: async () => ({ externalPostId: 'x', publishedAt: new Date() }),
    fetchMetrics: async () => ({ collectedAt: new Date() }),
  } as unknown as PlatformAdapter;

  return { registry: { X: adapter }, validated, refreshed };
}

describe.skipIf(!hasTestDatabase)('account health and revocation', () => {
  let db: Db;
  const workspaceIds: string[] = [];

  async function makeBrand(workspaceId: string, name: string): Promise<string> {
    const brandId = randomUUID();
    await db.brand.create({
      data: {
        id: brandId,
        workspaceId,
        name,
        slug: `b-${brandId.slice(0, 8)}`,
        palette: {},
        typography: {},
        voiceGuide: {},
      },
    });
    return brandId;
  }

  async function makeWorkspace(name: string): Promise<string> {
    const workspaceId = randomUUID();
    await db.workspace.create({
      data: { id: workspaceId, slug: `hs-${name}-${workspaceId.slice(0, 8)}`, name },
    });
    workspaceIds.push(workspaceId);
    return workspaceId;
  }

  async function makeFixture(
    name: string,
    options: {
      workspaceId?: string;
      brandId?: string;
      expiresAt?: Date | null;
      lastValidatedAt?: Date | null;
      status?: 'ACTIVE' | 'REVOKED' | 'ERROR';
      withCredential?: boolean;
    } = {},
  ): Promise<Fixture> {
    const workspaceId = options.workspaceId ?? (await makeWorkspace(name));
    const brandId = options.brandId ?? (await makeBrand(workspaceId, `${name} brand`));

    const credential = await db.platformCredential.create({
      data: {
        workspaceId,
        brandId,
        platform: 'X',
        mode: 'CLIENT_APP',
        label: `${name} app`,
        appId: `app-${name}`,
        appSecret: `secret-${name}`,
        redirectUri: 'https://example.test/cb',
        grantedScopes: [],
        requiredScopes: [],
        status: 'ACTIVE',
      },
    });

    const account = await db.socialAccount.create({
      data: {
        brandId,
        platform: 'X',
        externalId: `x-${name}`,
        handle: name,
        accessToken: `token-${name}`,
        tokenSecret: `tsecret-${name}`,
        scopes: [],
        // Nullable by design: a PLATFORM_APP-minted account has no credential row, and
        // that is exactly the shape a revocation fan-out silently skips.
        credentialId: options.withCredential === false ? null : credential.id,
        status: options.status ?? 'ACTIVE',
        expiresAt: options.expiresAt ?? null,
        lastValidatedAt: options.lastValidatedAt ?? null,
      },
    });

    return { workspaceId, brandId, credentialId: credential.id, accountId: account.id };
  }

  async function makeTarget(
    fixture: Fixture,
    status: 'SCHEDULED' | 'PUBLISHED' = 'SCHEDULED',
  ): Promise<string> {
    const post = await db.post.create({
      data: { brandId: fixture.brandId, title: 'Test post', status: 'READY' },
    });
    const target = await db.postTarget.create({
      data: {
        postId: post.id,
        platform: 'X',
        socialAccountId: fixture.accountId,
        caption: 'hello',
        status,
        scheduledFor: new Date(Date.now() + 60_000),
      },
    });
    return target.id;
  }

  const statusOf = async (accountId: string) =>
    (await db.socialAccount.findUniqueOrThrow({ where: { id: accountId } })).status;

  const targetStatusOf = async (targetId: string) =>
    (await db.postTarget.findUniqueOrThrow({ where: { id: targetId } })).status;

  beforeAll(() => {
    db = getPrisma();
  });

  afterAll(async () => {
    for (const workspaceId of workspaceIds) {
      await db.workspace.deleteMany({ where: { id: workspaceId } });
    }
    await disconnectPrisma();
  });

  describe('selecting accounts that are due', () => {
    it('finds a never-validated account and reports the workspace it belongs to', async () => {
      const fixture = await makeFixture('due-never');
      const reader = createSystemAccountReader(db);

      const due = await reader.findAccountsDueForHealthCheck(new Date(), 500);
      const found = due.find((account) => account.id === fixture.accountId);

      expect(found).toBeDefined();
      // The sweep re-scopes on this value. If the join were wrong, every write for this
      // account would be attempted under another tenant's scope.
      expect(found!.workspaceId).toBe(fixture.workspaceId);
      expect(found!.brandId).toBe(fixture.brandId);
    });

    it('skips REVOKED accounts, which have already been dealt with', async () => {
      const revoked = await makeFixture('due-revoked', { status: 'REVOKED' });
      const active = await makeFixture('due-active');

      const due = await createSystemAccountReader(db).findAccountsDueForHealthCheck(
        new Date(),
        500,
      );
      const ids = due.map((account) => account.id);

      // Identity, plus a positive control that proves the query returns anything at all.
      expect(ids).not.toContain(revoked.accountId);
      expect(ids).toContain(active.accountId);
    });

    it('skips an account validated recently whose token is nowhere near expiry', async () => {
      const fresh = await makeFixture('due-fresh', {
        lastValidatedAt: new Date(),
        expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      });
      const stale = await makeFixture('due-stale', {
        lastValidatedAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
      });

      const due = await createSystemAccountReader(db).findAccountsDueForHealthCheck(
        new Date(),
        500,
      );
      const ids = due.map((account) => account.id);

      expect(ids).not.toContain(fresh.accountId);
      expect(ids).toContain(stale.accountId);
    });

    it('picks up a recently validated account whose token expires soon', async () => {
      const expiring = await makeFixture('due-expiring', {
        lastValidatedAt: new Date(),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      });

      const due = await createSystemAccountReader(db).findAccountsDueForHealthCheck(
        new Date(),
        500,
      );

      // A token that can only be renewed while alive has to be caught before it dies,
      // however recently it was checked.
      expect(due.map((account) => account.id)).toContain(expiring.accountId);
    });
  });

  describe('running the sweep', () => {
    /** Restrict a sweep to named accounts so parallel fixtures cannot perturb it. */
    function readerFor(accounts: Fixture[]): SystemAccountReader {
      const real = createSystemAccountReader(db);
      const wanted = new Set(accounts.map((account) => account.accountId));
      return {
        findAccountsDueForHealthCheck: async (now, limit) =>
          (await real.findAccountsDueForHealthCheck(now, limit)).filter((account) =>
            wanted.has(account.id),
          ),
      };
    }

    it('writes each account back under its own tenant, across two workspaces', async () => {
      const a = await makeFixture('sweep-ws-a');
      const b = await makeFixture('sweep-ws-b');
      const adapter = fakeAdapter({});

      const result = await runHealthSweep({
        db,
        reader: readerFor([a, b]),
        registry: adapter.registry,
      });

      expect(result.checked).toBe(2);
      // Both, not one. A sweep that re-scoped to the first account's workspace for every
      // write would leave the second untouched and still report success.
      expect(adapter.validated).toContain('x-sweep-ws-a');
      expect(adapter.validated).toContain('x-sweep-ws-b');

      const rowA = await db.socialAccount.findUniqueOrThrow({ where: { id: a.accountId } });
      const rowB = await db.socialAccount.findUniqueOrThrow({ where: { id: b.accountId } });
      expect(rowA.lastValidatedAt).not.toBeNull();
      expect(rowB.lastValidatedAt).not.toBeNull();
    });

    it('handles two brands in one workspace, writing each under its own brand scope', async () => {
      const workspaceId = await makeWorkspace('sweep-two-brands');
      const first = await makeFixture('sweep-brand-1', { workspaceId });
      const second = await makeFixture('sweep-brand-2', {
        workspaceId,
        brandId: await makeBrand(workspaceId, 'second brand'),
      });

      expect(first.brandId).not.toBe(second.brandId);

      const adapter = fakeAdapter({});
      await runHealthSweep({ db, reader: readerFor([first, second]), registry: adapter.registry });

      // `scopeFilterFor` dispatches to the brand rule *or* the workspace rule, never both.
      // A rule correct under one scope kind can be wrong under the other, and a
      // single-brand fixture cannot see the difference.
      const rowOne = await db.socialAccount.findUniqueOrThrow({ where: { id: first.accountId } });
      const rowTwo = await db.socialAccount.findUniqueOrThrow({ where: { id: second.accountId } });
      expect(rowOne.lastValidatedAt).not.toBeNull();
      expect(rowTwo.lastValidatedAt).not.toBeNull();
    });

    it('marks a revoked token REVOKED and records why', async () => {
      const fixture = await makeFixture('sweep-revoked');
      const adapter = fakeAdapter({
        validate: async () => ({
          status: 'REVOKED' as const,
          checkedAt: new Date(),
          message: 'The account owner disconnected this app.',
        }),
      });

      const result = await runHealthSweep({
        db,
        reader: readerFor([fixture]),
        registry: adapter.registry,
      });

      expect(result.revoked).toBe(1);
      expect(await statusOf(fixture.accountId)).toBe('REVOKED');
      const row = await db.socialAccount.findUniqueOrThrow({ where: { id: fixture.accountId } });
      expect(row.lastError).toContain('disconnected');
    });

    it('clears a stale error when an account recovers', async () => {
      const fixture = await makeFixture('sweep-recovers', { status: 'ERROR' });
      await db.socialAccount.update({
        where: { id: fixture.accountId },
        data: { lastError: 'something went wrong last time' },
      });

      const adapter = fakeAdapter({});
      await runHealthSweep({ db, reader: readerFor([fixture]), registry: adapter.registry });

      const row = await db.socialAccount.findUniqueOrThrow({ where: { id: fixture.accountId } });
      expect(row.status).toBe('ACTIVE');
      // A stale error next to an ACTIVE status reads to a human as "still broken".
      expect(row.lastError).toBeNull();
    });

    it('refreshes a token that is close to expiry instead of merely validating it', async () => {
      const fixture = await makeFixture('sweep-refresh', {
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      });
      const adapter = fakeAdapter({});

      const result = await runHealthSweep({
        db,
        reader: readerFor([fixture]),
        registry: adapter.registry,
      });

      expect(result.refreshed).toBe(1);
      expect(adapter.refreshed).toContain('x-sweep-refresh');
      expect(adapter.validated).not.toContain('x-sweep-refresh');

      const row = await db.socialAccount.findUniqueOrThrow({ where: { id: fixture.accountId } });
      expect(row.accessToken).toMatch(/^refreshed-/);
    });

    it('does not refresh a token that is nowhere near expiry', async () => {
      const fixture = await makeFixture('sweep-no-refresh', {
        expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
        lastValidatedAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
      });
      const adapter = fakeAdapter({});

      await runHealthSweep({ db, reader: readerFor([fixture]), registry: adapter.registry });

      // Refreshing on every pass rotates a token hundreds of times a day for nothing, and
      // some platforms count that against a quota.
      expect(adapter.refreshed).not.toContain('x-sweep-no-refresh');
      expect(adapter.validated).toContain('x-sweep-no-refresh');
    });

    it('keeps sweeping after one account throws', async () => {
      const broken = await makeFixture('sweep-broken');
      const healthy = await makeFixture('sweep-healthy');

      let firstCall = true;
      const adapter = fakeAdapter({
        validate: async () => {
          if (firstCall) {
            firstCall = false;
            throw new Error('platform exploded');
          }
          return { status: 'ACTIVE' as const, checkedAt: new Date() };
        },
      });

      const result = await runHealthSweep({
        db,
        reader: readerFor([broken, healthy]),
        registry: adapter.registry,
      });

      // One client's broken credential must not stop every other client being checked.
      expect(result.failed).toBe(1);
      expect(result.checked).toBe(2);
      expect(adapter.validated).toHaveLength(2);
    });
  });

  describe('listing connections', () => {
    it('shows only the scoped brand\u2019s accounts when scope is the only separator', async () => {
      const workspaceId = await makeWorkspace('conn-two-brands');
      const mine = await makeFixture('conn-mine', { workspaceId });
      const sibling = await makeFixture('conn-sibling', {
        workspaceId,
        brandId: await makeBrand(workspaceId, 'sibling brand'),
      });

      const scoped = withTenantScope(db, {
        kind: 'brand',
        workspaceId,
        brandId: mine.brandId,
      });
      const connections = await listConnections(scoped);
      const ids = connections.map((connection) => connection.id);

      // Two brands in ONE workspace, so the brand rule is the only thing separating these
      // rows — no credential id, no workspace boundary, nothing else to accidentally
      // filter on. An earlier version of the revocation tests below looked like a tenancy
      // test and was not one: its two tenants had different credential ids, so it passed
      // with the brand rule replaced by `{}`.
      expect(ids).toContain(mine.accountId);
      expect(ids).not.toContain(sibling.accountId);
    });

    it('shows every brand\u2019s accounts under a workspace scope', async () => {
      const workspaceId = await makeWorkspace('conn-ws-scope');
      const first = await makeFixture('conn-ws-1', { workspaceId });
      const second = await makeFixture('conn-ws-2', {
        workspaceId,
        brandId: await makeBrand(workspaceId, 'second'),
      });
      const outsider = await makeFixture('conn-outsider');

      const scoped = withTenantScope(db, { kind: 'workspace', workspaceId });
      const ids = (await listConnections(scoped)).map((connection) => connection.id);

      // The other scope kind. `scopeFilterFor` dispatches to one rule or the other and
      // never both, so a rule correct under `brand` can be broken under `workspace`.
      expect(ids).toContain(first.accountId);
      expect(ids).toContain(second.accountId);
      expect(ids).not.toContain(outsider.accountId);
    });

    it('never returns a token, even though the row holds three of them', async () => {
      const fixture = await makeFixture('conn-secrets');
      const scoped = withTenantScope(db, {
        kind: 'brand',
        workspaceId: fixture.workspaceId,
        brandId: fixture.brandId,
      });

      const [connection] = await listConnections(scoped);
      const serialized = JSON.stringify(connection);

      // The encryption extension decrypts on read, so a `findMany` without an explicit
      // `select` hands back live plaintext credentials. Asserting on the serialized body
      // is the check that matters: that is what would actually go on the wire.
      expect(serialized).not.toContain('token-conn-secrets');
      expect(serialized).not.toContain('tsecret-conn-secrets');
      expect(Object.keys(connection!)).not.toContain('accessToken');
      // Positive control: the right row was found, so the assertions above are not
      // trivially true of an empty result.
      expect(connection!.id).toBe(fixture.accountId);
      expect(connection!.handle).toBe('conn-secrets');
    });

    it('flags a non-ACTIVE account as needing attention', async () => {
      const fixture = await makeFixture('conn-attention', { status: 'ERROR' });
      const healthy = await makeFixture('conn-healthy', {
        workspaceId: fixture.workspaceId,
        brandId: fixture.brandId,
      });

      const scoped = withTenantScope(db, {
        kind: 'brand',
        workspaceId: fixture.workspaceId,
        brandId: fixture.brandId,
      });
      const connections = await listConnections(scoped);

      const broken = connections.find((c) => c.id === fixture.accountId)!;
      const fine = connections.find((c) => c.id === healthy.accountId)!;
      expect(broken.needsAttention).toBe(true);
      expect(fine.needsAttention).toBe(false);
    });
  });

  describe('revoking a credential', () => {
    it('marks the credential, its accounts and their pending targets', async () => {
      const fixture = await makeFixture('revoke-basic');
      const scheduled = await makeTarget(fixture, 'SCHEDULED');
      const published = await makeTarget(fixture, 'PUBLISHED');

      const scoped = withTenantScope(db, {
        kind: 'brand',
        workspaceId: fixture.workspaceId,
        brandId: fixture.brandId,
      });

      await revokeCredential(scoped, fixture.credentialId, { reason: 'Rotated by the client.' });

      // Read back, never a count. The fan-out is an `updateMany` whose result nobody
      // consumes, so a wrong `where` throws nothing and returns nothing while the account
      // keeps publishing with a revoked credential.
      expect(await statusOf(fixture.accountId)).toBe('REVOKED');
      expect(await targetStatusOf(scheduled)).toBe('BLOCKED');
      // BLOCKED, not FAILED: telling a client their content was rejected sends them to
      // debug the post when the answer is to reconnect.
      expect(await targetStatusOf(scheduled)).not.toBe('FAILED');
      // A published post is history and must not be rewritten. This is the control that
      // proves the `where` is filtering rather than matching everything.
      expect(await targetStatusOf(published)).toBe('PUBLISHED');

      const credential = await db.platformCredential.findUniqueOrThrow({
        where: { id: fixture.credentialId },
      });
      expect(credential.status).toBe('REVOKED');
    });

    it('leaves another tenant\u2019s account and targets untouched', async () => {
      const mine = await makeFixture('revoke-mine');
      const theirs = await makeFixture('revoke-theirs');
      const theirTarget = await makeTarget(theirs, 'SCHEDULED');

      const scoped = withTenantScope(db, {
        kind: 'brand',
        workspaceId: mine.workspaceId,
        brandId: mine.brandId,
      });
      await revokeCredential(scoped, mine.credentialId);

      expect(await statusOf(mine.accountId)).toBe('REVOKED');
      // The other tenant's rows are definitely present and must be identifiably unchanged.
      // An "expect nothing else changed" assertion phrased as a count would pass under a
      // scope bug that changed both.
      expect(await statusOf(theirs.accountId)).toBe('ACTIVE');
      expect(await targetStatusOf(theirTarget)).toBe('SCHEDULED');
    });

    it('does not touch an account minted by the platform app', async () => {
      const workspaceId = await makeWorkspace('revoke-null-fk');
      const brandId = await makeBrand(workspaceId, 'shared brand');
      const owned = await makeFixture('revoke-owned', { workspaceId, brandId });
      const platformMinted = await makeFixture('revoke-platform', {
        workspaceId,
        brandId,
        withCredential: false,
      });

      const scoped = withTenantScope(db, { kind: 'brand', workspaceId, brandId });
      const summary = await revokeCredential(scoped, owned.credentialId);

      expect(await statusOf(owned.accountId)).toBe('REVOKED');
      // `credentialId` is nullable, and a null FK is exactly the shape a fan-out written
      // as `where: { credentialId }` would sweep up if it ever became a looser match.
      // A PLATFORM_APP token is not revoked by a client revoking their own app.
      expect(await statusOf(platformMinted.accountId)).toBe('ACTIVE');
      expect(summary.accountsRevoked).toBe(1);

      // The exact key names, not just their values. The Settings → Connections page reads
      // this body and reports the blast radius from it; when the UI was first written it
      // guessed `accountsMarked` and its own fixture obligingly used the same wrong name,
      // so the page tested green while displaying nothing. Pinning the shape here is what
      // makes that a failure rather than a coincidence.
      expect(Object.keys(summary).sort()).toEqual([
        'accountsRevoked',
        'credentialId',
        'targetsBlocked',
      ]);
    });

    it('succeeds for a credential that never connected anything', async () => {
      const workspaceId = await makeWorkspace('revoke-unused');
      const brandId = await makeBrand(workspaceId, 'unused brand');
      const credential = await db.platformCredential.create({
        data: {
          workspaceId,
          brandId,
          platform: 'X',
          mode: 'CLIENT_APP',
          label: 'never used',
          appId: 'app',
          appSecret: 'secret',
          redirectUri: 'https://example.test/cb',
          grantedScopes: [],
          requiredScopes: [],
          status: 'PENDING',
        },
      });

      const scoped = withTenantScope(db, { kind: 'brand', workspaceId, brandId });
      const summary = await revokeCredential(scoped, credential.id);

      expect(summary.accountsRevoked).toBe(0);
      const row = await db.platformCredential.findUniqueOrThrow({ where: { id: credential.id } });
      expect(row.status).toBe('REVOKED');
    });

    it('refuses to revoke a credential belonging to another tenant', async () => {
      const mine = await makeFixture('revoke-scope-mine');
      const theirs = await makeFixture('revoke-scope-theirs');

      const scoped = withTenantScope(db, {
        kind: 'brand',
        workspaceId: mine.workspaceId,
        brandId: mine.brandId,
      });

      await expect(revokeCredential(scoped, theirs.credentialId)).rejects.toThrow();
      // Asserting the throw is not enough; the row must be provably intact, because a
      // partial revocation that threw halfway would still pass a rejects.toThrow().
      const row = await db.platformCredential.findUniqueOrThrow({
        where: { id: theirs.credentialId },
      });
      expect(row.status).toBe('ACTIVE');
      expect(await statusOf(theirs.accountId)).toBe('ACTIVE');
    });

    it('revokes under a workspace scope as well as a brand scope', async () => {
      const fixture = await makeFixture('revoke-ws-scope');
      const scheduled = await makeTarget(fixture, 'SCHEDULED');

      const scoped = withTenantScope(db, {
        kind: 'workspace',
        workspaceId: fixture.workspaceId,
      });
      await revokeCredential(scoped, fixture.credentialId);

      // Both scope kinds, because `scopeFilterFor` dispatches to one rule or the other and
      // never both — which is exactly how a brand-scope leak shipped with a passing
      // workspace-scoped test.
      expect(await statusOf(fixture.accountId)).toBe('REVOKED');
      expect(await targetStatusOf(scheduled)).toBe('BLOCKED');
    });
  });
});
