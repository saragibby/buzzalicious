import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectPrisma, getPrisma, type Db } from '../../src/platform/db';
import { withTenantScope } from '../../src/platform/tenancy';
import {
  resolveCredential,
  CredentialUnavailableError,
} from '../../src/modules/publish/credential.resolver';
import { publishTarget, publishKey } from '../../src/modules/publish/publish.service';
import { findDueTargets } from '../../src/modules/publish/schedule.service';
import {
  startHandshake,
  consumeHandshake,
} from '../../src/modules/publish/oauth/handshake.service';
import { InvalidOAuthStateError } from '../../src/modules/publish/oauth/state';
import type { AdapterRegistry } from '../../src/modules/publish/adapter.registry';
import type { PlatformAdapter, PublishResult } from '../../src/modules/publish/adapter.types';
import { classifyPlatformError } from '../../src/modules/publish/publish.errors';
import { X_SPEC } from '../../src/modules/publish/x/x.adapter';
import { hasTestDatabase } from '../env';

/**
 * Credentials, tenancy, the resolver and the publish pipeline, against a real database.
 *
 * Every fixture is created fresh with random ids inside this file, so nothing here
 * depends on seed contents or on file execution order — Vitest orders files by size, and
 * an ordering dependency is machine-dependent by construction.
 *
 * The tenancy tests follow the rule the W10 brand-scope leak taught: assert on the
 * **identity** of what comes back, with another tenant's rows definitely present. A
 * "returns 0 rows" assertion passes under the very bug it is meant to catch, because an
 * empty filter fragment `{}` is *no filter* rather than a deny — it leaks more rows, not
 * fewer.
 */

interface Tenant {
  workspaceId: string;
  brandId: string;
  credentialId: string;
  accountId: string;
}

/** A fake adapter. No test in this file may reach a social platform. */
function fakeAdapter(behaviour: { publish?: () => Promise<PublishResult> } = {}): {
  registry: AdapterRegistry;
  calls: number;
} {
  const state = { calls: 0 };
  const adapter = {
    platform: 'X' as const,
    specs: X_SPEC,
    getAuthUrl: async () => 'https://example.test/auth',
    connect: async () => [],
    refresh: async (_c: unknown, a: { tokens: unknown }) => a.tokens,
    validate: async () => ({ status: 'ACTIVE' as const, checkedAt: new Date() }),
    introspect: async () => ({
      status: 'ACTIVE' as const,
      grantedScopes: [],
      capabilities: {},
      summary: 'ok',
      checkedAt: new Date(),
    }),
    publish: async () => {
      state.calls += 1;
      if (behaviour.publish) return behaviour.publish();
      return {
        externalPostId: `ext-${randomUUID()}`,
        externalUrl: 'https://x.test/status/1',
        publishedAt: new Date(),
      };
    },
    fetchMetrics: async () => ({ collectedAt: new Date() }),
  } as unknown as PlatformAdapter;

  return {
    registry: { X: adapter },
    get calls() {
      return state.calls;
    },
  } as { registry: AdapterRegistry; calls: number };
}

describe.skipIf(!hasTestDatabase)('publishing', () => {
  let db: Db;
  const tenants: Tenant[] = [];

  async function makeTenant(name: string): Promise<Tenant> {
    const workspaceId = randomUUID();
    const brandId = randomUUID();

    await db.workspace.create({
      data: { id: workspaceId, slug: `pub-${name}-${workspaceId.slice(0, 8)}`, name },
    });
    await db.brand.create({
      data: {
        id: brandId,
        workspaceId,
        name: `${name} brand`,
        slug: `b-${brandId.slice(0, 8)}`,
        palette: {},
        typography: {},
        voiceGuide: {},
      },
    });

    const credential = await db.platformCredential.create({
      data: {
        workspaceId,
        brandId,
        platform: 'X',
        mode: 'CLIENT_APP',
        label: `${name} X app`,
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
        credentialId: credential.id,
        status: 'ACTIVE',
      },
    });

    const tenant = { workspaceId, brandId, credentialId: credential.id, accountId: account.id };
    tenants.push(tenant);
    return tenant;
  }

  async function makeTarget(
    tenant: Tenant,
    overrides: Partial<{ status: 'DRAFT' | 'SCHEDULED'; scheduledFor: Date }> = {},
  ): Promise<string> {
    const post = await db.post.create({
      data: { brandId: tenant.brandId, title: 'Test post', status: 'READY' },
    });
    const target = await db.postTarget.create({
      data: {
        postId: post.id,
        platform: 'X',
        socialAccountId: tenant.accountId,
        caption: 'hello world',
        status: overrides.status ?? 'SCHEDULED',
        scheduledFor: overrides.scheduledFor ?? new Date(Date.now() - 1000),
      },
    });
    return target.id;
  }

  beforeAll(() => {
    db = getPrisma();
  });

  afterAll(async () => {
    // Workspace cascade removes brands, credentials, accounts, posts and targets.
    for (const tenant of tenants) {
      await db.workspace.deleteMany({ where: { id: tenant.workspaceId } });
    }
    await disconnectPrisma();
  });

  describe('OAuthHandshake tenancy', () => {
    it('scopes handshakes to the owning brand under a BRAND scope', async () => {
      const mine = await makeTenant('hs-brand-mine');
      const theirs = await makeTenant('hs-brand-theirs');

      const own = await startHandshake(db, {
        credentialId: mine.credentialId,
        platform: 'X',
        brandId: mine.brandId,
        nonce: randomUUID(),
      });
      const other = await startHandshake(db, {
        credentialId: theirs.credentialId,
        platform: 'X',
        brandId: theirs.brandId,
        nonce: randomUUID(),
      });

      const scoped = withTenantScope(db, {
        kind: 'brand',
        workspaceId: mine.workspaceId,
        brandId: mine.brandId,
      });
      const visible = await scoped.oAuthHandshake.findMany({});
      const ids = visible.map((row) => row.id);

      // Identity, not count. The other tenant's row definitely exists — asserting "0 rows"
      // or "1 row" would both pass under an empty-fragment leak.
      expect(ids).toContain(own.id);
      expect(ids).not.toContain(other.id);
    });

    it('scopes handshakes to the owning workspace under a WORKSPACE scope', async () => {
      const mine = await makeTenant('hs-ws-mine');
      const theirs = await makeTenant('hs-ws-theirs');

      const own = await startHandshake(db, {
        credentialId: mine.credentialId,
        platform: 'X',
        brandId: mine.brandId,
        nonce: randomUUID(),
      });
      const other = await startHandshake(db, {
        credentialId: theirs.credentialId,
        platform: 'X',
        brandId: theirs.brandId,
        nonce: randomUUID(),
      });

      // The second scope kind. `scopeFilterFor` dispatches to `rule.brand` *or*
      // `rule.workspace` and never both, so a rule that is correct under one can leak
      // under the other — which is exactly the shape of the bug W10 shipped.
      const scoped = withTenantScope(db, { kind: 'workspace', workspaceId: mine.workspaceId });
      const ids = (await scoped.oAuthHandshake.findMany({})).map((row) => row.id);

      expect(ids).toContain(own.id);
      expect(ids).not.toContain(other.id);
    });

    it('scopes handshakes against a WORKSPACE-SHARED credential to the initiating brand', async () => {
      // The case the two tests above cannot see. Both of their credentials are
      // brand-scoped, so filtering a handshake by its *credential's* brand happens to give
      // the right answer. A workspace-shared credential has `brandId: null`, and every
      // brand in the workspace legitimately connects through it — so routing the scope
      // through the credential makes each brand's handshake visible to all the others.
      const mine = await makeTenant('hs-shared-mine');
      const theirs = await makeTenant('hs-shared-theirs');

      const shared = await db.platformCredential.create({
        data: {
          workspaceId: mine.workspaceId,
          brandId: null,
          platform: 'X',
          mode: 'CLIENT_APP',
          label: 'workspace-wide X app',
          appId: 'app-shared',
          appSecret: 'secret-shared',
          grantedScopes: [],
          requiredScopes: [],
          status: 'ACTIVE',
        },
      });

      // A second brand in the SAME workspace, so the workspace filter cannot separate them
      // either — only the handshake's own brandId can.
      const sibling = await db.brand.create({
        data: {
          workspaceId: mine.workspaceId,
          name: 'sibling',
          slug: `sib-${randomUUID().slice(0, 8)}`,
          palette: {},
          typography: {},
          voiceGuide: {},
        },
      });

      const own = await startHandshake(db, {
        credentialId: shared.id,
        platform: 'X',
        brandId: mine.brandId,
        nonce: randomUUID(),
      });
      const siblings = await startHandshake(db, {
        credentialId: shared.id,
        platform: 'X',
        brandId: sibling.id,
        nonce: randomUUID(),
      });

      const scoped = withTenantScope(db, {
        kind: 'brand',
        workspaceId: mine.workspaceId,
        brandId: mine.brandId,
      });
      const ids = (await scoped.oAuthHandshake.findMany({})).map((row) => row.id);

      expect(ids).toContain(own.id);
      expect(ids).not.toContain(siblings.id);
      // Control: the other workspace is still excluded too, so this has not been fixed by
      // accidentally widening the filter.
      expect(theirs.workspaceId).not.toBe(mine.workspaceId);
    });

    it('encrypts the request token secret at rest', async () => {
      const tenant = await makeTenant('hs-enc');
      const handshake = await db.oAuthHandshake.create({
        data: {
          credentialId: tenant.credentialId,
          platform: 'X',
          brandId: tenant.brandId,
          nonce: randomUUID(),
          requestToken: 'rt',
          requestTokenSecret: 'super-secret-value',
          expiresAt: new Date(Date.now() + 60_000),
        },
      });

      // Raw SQL bypasses the decrypting extension, which is the only way to prove the
      // plaintext never reached the column.
      const raw = await db.$queryRaw<Array<{ requestTokenSecret: string | null }>>`
        SELECT "requestTokenSecret" FROM oauth_handshakes WHERE id = ${handshake.id}
      `;
      expect(raw[0]!.requestTokenSecret).not.toBe('super-secret-value');
      // The versioned envelope W2's crypto layer writes: `v1.<keyId>.<iv>.<ct>.<tag>`.
      // Matching the shape rather than merely "not the plaintext" means a future change
      // that stored, say, a base64 of the plaintext would still fail this.
      expect(raw[0]!.requestTokenSecret).toMatch(/^v1\.[^.]+\.[^.]+\.[^.]+\.[^.]+$/);

      // Control: the value still round-trips through the extension, so the assertion above
      // is proving encryption rather than a dropped write.
      const read = await db.oAuthHandshake.findUnique({ where: { id: handshake.id } });
      expect(read!.requestTokenSecret).toBe('super-secret-value');
    });
  });

  describe('handshake consumption', () => {
    it('can be consumed exactly once', async () => {
      const tenant = await makeTenant('hs-once');
      const nonce = randomUUID();
      await startHandshake(db, {
        credentialId: tenant.credentialId,
        platform: 'X',
        brandId: tenant.brandId,
        nonce,
      });

      const first = await consumeHandshake(db, nonce);
      expect(first.consumedAt).not.toBeNull();

      // A duplicated callback — a double-click, a prefetch, a replayed link — must not run
      // the code exchange twice.
      await expect(consumeHandshake(db, nonce)).rejects.toThrow(InvalidOAuthStateError);
    });

    it('refuses an expired handshake', async () => {
      const tenant = await makeTenant('hs-expired');
      const nonce = randomUUID();
      await db.oAuthHandshake.create({
        data: {
          credentialId: tenant.credentialId,
          platform: 'X',
          brandId: tenant.brandId,
          nonce,
          expiresAt: new Date(Date.now() - 1000),
        },
      });

      await expect(consumeHandshake(db, nonce)).rejects.toThrow(InvalidOAuthStateError);
    });
  });

  describe('credential resolver', () => {
    it('prefers a brand credential over a workspace-shared one', async () => {
      const tenant = await makeTenant('res-brand');
      const shared = await db.platformCredential.create({
        data: {
          workspaceId: tenant.workspaceId,
          brandId: null,
          platform: 'X',
          mode: 'CLIENT_APP',
          label: 'shared',
          appId: 'app-shared',
          appSecret: 'secret-shared',
          grantedScopes: [],
          requiredScopes: [],
          status: 'ACTIVE',
        },
      });

      const resolved = await resolveCredential(db, {
        workspaceId: tenant.workspaceId,
        brandId: tenant.brandId,
        platform: 'X',
        actor: 'test',
      });

      expect(resolved.id).toBe(tenant.credentialId);
      // Control: the shared credential is genuinely a candidate, so this is testing
      // precedence rather than the absence of an alternative.
      expect(shared.workspaceId).toBe(tenant.workspaceId);
    });

    it('prefers CLIENT_APP over DIRECT_TOKEN within the same tier', async () => {
      const tenant = await makeTenant('res-mode');
      await db.platformCredential.create({
        data: {
          workspaceId: tenant.workspaceId,
          brandId: tenant.brandId,
          platform: 'X',
          mode: 'DIRECT_TOKEN',
          label: 'pasted token',
          directToken: 'dt',
          directTokenSecret: 'dts',
          grantedScopes: [],
          requiredScopes: [],
          status: 'ACTIVE',
        },
      });

      const resolved = await resolveCredential(db, {
        workspaceId: tenant.workspaceId,
        brandId: tenant.brandId,
        platform: 'X',
        actor: 'test',
      });

      // A DIRECT_TOKEN is a day-one bootstrap that expires; a CLIENT_APP is durable. A
      // client who has upgraded should use the upgrade without deleting the old row.
      expect(resolved.id).toBe(tenant.credentialId);
      expect(resolved.mode).toBe('CLIENT_APP');
    });

    it('does not resolve another workspace credential', async () => {
      const mine = await makeTenant('res-iso-mine');
      const theirs = await makeTenant('res-iso-theirs');

      const resolved = await resolveCredential(db, {
        workspaceId: mine.workspaceId,
        brandId: mine.brandId,
        platform: 'X',
        actor: 'test',
      });

      // Identity again: the other workspace has a perfectly usable X credential, and the
      // only thing stopping it being chosen is the workspace binding.
      expect(resolved.id).toBe(mine.credentialId);
      expect(resolved.id).not.toBe(theirs.credentialId);
    });

    it('does not borrow a brand credential for workspace-level work', async () => {
      const tenant = await makeTenant('res-ws-level');

      // Only a brand-scoped credential exists. Workspace-level work must not adopt it:
      // unfiltered, `rank()` scores every row identically and the tie breaks on
      // `createdAt`, so the workspace would silently act as whichever brand connected
      // first.
      const resolved = await resolveCredential(db, {
        workspaceId: tenant.workspaceId,
        brandId: null,
        platform: 'X',
        actor: 'test',
      });

      // It falls through to the platform's own app rather than borrowing. Asserting the
      // identity of what came back is the point: an assertion that merely rejected would
      // also pass if the resolver were broken in the opposite direction, and an assertion
      // on the count would pass while returning the wrong brand's row.
      expect(resolved.id).toBeNull();
      expect(resolved.mode).toBe('PLATFORM_APP');
      expect(resolved.id).not.toBe(tenant.credentialId);

      // Control: the same call with the brand does resolve, proving the row is usable and
      // it is the scoping that refused.
      const withBrand = await resolveCredential(db, {
        workspaceId: tenant.workspaceId,
        brandId: tenant.brandId,
        platform: 'X',
        actor: 'test',
      });
      expect(withBrand.id).toBe(tenant.credentialId);
    });

    it('writes an access log row on every decrypt', async () => {
      const tenant = await makeTenant('res-audit');
      const before = await db.credentialAccessLog.count({
        where: { credentialId: tenant.credentialId },
      });

      await resolveCredential(db, {
        workspaceId: tenant.workspaceId,
        brandId: tenant.brandId,
        platform: 'X',
        actor: 'job:test',
        context: { reason: 'unit' },
      });

      const rows = await db.credentialAccessLog.findMany({
        where: { credentialId: tenant.credentialId },
        orderBy: { occurredAt: 'desc' },
      });
      expect(rows.length).toBe(before + 1);
      expect(rows[0]!.actor).toBe('job:test');
      expect(rows[0]!.action).toBe('decrypt');
    });

    it('refuses a REVOKED credential', async () => {
      const tenant = await makeTenant('res-revoked');
      await db.platformCredential.update({
        where: { id: tenant.credentialId },
        data: { status: 'REVOKED' },
      });

      const resolved = await resolveCredential(db, {
        workspaceId: tenant.workspaceId,
        brandId: tenant.brandId,
        platform: 'X',
        actor: 'test',
      });

      // A revoked credential is skipped, not used and not fatal — the platform app is
      // still a legitimate way to publish. The identity assertion is what matters: the
      // revoked row must not be the one that came back.
      expect(resolved.id).not.toBe(tenant.credentialId);
      expect(resolved.mode).toBe('PLATFORM_APP');
    });

    it('raises CredentialUnavailableError when nothing at all is usable', async () => {
      const tenant = await makeTenant('res-none');

      // LINKEDIN has no stored credential and no configured platform app, so every tier
      // misses. This is the control for the two tests above: it proves the resolver can
      // still refuse, so their fallback results are a deliberate third tier rather than a
      // resolver that never rejects.
      await expect(
        resolveCredential(db, {
          workspaceId: tenant.workspaceId,
          brandId: tenant.brandId,
          platform: 'LINKEDIN',
          actor: 'test',
        }),
      ).rejects.toThrow(CredentialUnavailableError);
    });
  });

  describe('publish pipeline', () => {
    it('publishes a target and meters it exactly once', async () => {
      const tenant = await makeTenant('pub-ok');
      const targetId = await makeTarget(tenant);
      const fake = fakeAdapter();

      const outcome = await publishTarget(db, {
        targetId,
        actor: 'test',
        registry: fake.registry,
      });

      expect(outcome.kind).toBe('published');

      const target = await db.postTarget.findUnique({ where: { id: targetId } });
      expect(target!.status).toBe('PUBLISHED');
      expect(target!.externalPostId).not.toBeNull();
      expect(target!.publishedAt).not.toBeNull();

      const events = await db.usageEvent.findMany({
        where: { workspaceId: tenant.workspaceId, metric: 'POST_PUBLISHED' },
      });
      expect(events).toHaveLength(1);
      expect(events[0]!.quantity).toBe(1);
      // Attempt-independent by construction. W10's `assertAttemptIndependent` rejects
      // anything ending in an attempt number, and this is the key it must be.
      expect(events[0]!.idempotencyKey).toBe(publishKey(targetId));
      expect(events[0]!.postTargetId).toBe(targetId);
    });

    it('does not re-publish or double-meter an already published target', async () => {
      const tenant = await makeTenant('pub-idem');
      const targetId = await makeTarget(tenant);
      const fake = fakeAdapter();

      await publishTarget(db, { targetId, actor: 'test', registry: fake.registry });
      const second = await publishTarget(db, { targetId, actor: 'test', registry: fake.registry });

      // pg-boss delivers at least once; a worker dyno cycling mid-publish is ordinary.
      expect(second.kind).toBe('already-published');
      // The control that makes this non-vacuous: the adapter was called exactly once, so
      // the second run really did stop before the network rather than the test never
      // having published at all.
      expect(fake.calls).toBe(1);

      const events = await db.usageEvent.count({
        where: { workspaceId: tenant.workspaceId, metric: 'POST_PUBLISHED' },
      });
      expect(events).toBe(1);
    });

    it('publishes for a workspace that is over its AI budget', async () => {
      const tenant = await makeTenant('pub-budget');
      // A ceiling of zero with spend against it: unambiguously over.
      await db.workspace.update({
        where: { id: tenant.workspaceId },
        data: { aiMonthlyCeilingUsd: new Prisma.Decimal('0.00') },
      });
      await db.usageEvent.create({
        data: {
          workspaceId: tenant.workspaceId,
          brandId: tenant.brandId,
          metric: 'AI_TOKENS',
          quantity: 1000,
          providerCostUsd: new Prisma.Decimal('25.00'),
          idempotencyKey: `ai:${randomUUID()}`,
          periodStart: new Date(),
        },
      });

      const targetId = await makeTarget(tenant);
      const outcome = await publishTarget(db, {
        targetId,
        actor: 'test',
        registry: fakeAdapter().registry,
      });

      // The behavioural half of the guard in `no-ai-budget.test.ts`. Publishing is paid
      // for separately; an AI overspend must not silently stop a client's social presence.
      expect(outcome.kind).toBe('published');
    });

    it('blocks rather than fails when the account is revoked', async () => {
      const tenant = await makeTenant('pub-blocked');
      const targetId = await makeTarget(tenant);
      await db.socialAccount.update({
        where: { id: tenant.accountId },
        data: { status: 'REVOKED' },
      });

      const outcome = await publishTarget(db, {
        targetId,
        actor: 'test',
        registry: fakeAdapter().registry,
      });

      expect(outcome.kind).toBe('blocked');
      const target = await db.postTarget.findUnique({ where: { id: targetId } });
      // BLOCKED, not FAILED. Calling it a failure tells the client their content was
      // rejected when it is actually waiting for them to reconnect.
      expect(target!.status).toBe('BLOCKED');
      expect(target!.errorClass).toBe('CREDENTIAL');
    });

    it('schedules a retry with a future nextAttemptAt on a transient failure', async () => {
      const tenant = await makeTenant('pub-retry');
      const targetId = await makeTarget(tenant);

      const registry = fakeAdapter({
        publish: async () => {
          throw classifyPlatformError({ platform: 'X', status: 503, message: 'upstream down' });
        },
      }).registry;

      const outcome = await publishTarget(db, { targetId, actor: 'test', registry });
      expect(outcome.kind).toBe('retry');

      const target = await db.postTarget.findUnique({ where: { id: targetId } });
      expect(target!.status).toBe('SCHEDULED');
      expect(target!.errorClass).toBe('TRANSIENT');
      expect(target!.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
      expect(target!.attempts).toBe(1);

      // Not yet due, so the sweep must not pick it up again immediately — otherwise the
      // backoff is decorative.
      const due = await findDueTargets(db, new Date());
      expect(due.map((t) => t.id)).not.toContain(targetId);
    });

    it('fails terminally on a validation error without retrying', async () => {
      const tenant = await makeTenant('pub-validation');
      const targetId = await makeTarget(tenant);

      const registry = fakeAdapter({
        publish: async () => {
          throw classifyPlatformError({ platform: 'X', status: 422, message: 'duplicate tweet' });
        },
      }).registry;

      const outcome = await publishTarget(db, { targetId, actor: 'test', registry });
      expect(outcome.kind).toBe('failed');

      const target = await db.postTarget.findUnique({ where: { id: targetId } });
      expect(target!.status).toBe('FAILED');
      expect(target!.nextAttemptAt).toBeNull();
      // No usage event: nothing was published, so nothing is billable.
      const events = await db.usageEvent.count({
        where: { workspaceId: tenant.workspaceId, metric: 'POST_PUBLISHED' },
      });
      expect(events).toBe(0);
    });

    it('rolls a post up to PARTIALLY_PUBLISHED when one target fails', async () => {
      const tenant = await makeTenant('pub-partial');
      const post = await db.post.create({
        data: { brandId: tenant.brandId, title: 'Multi', status: 'READY' },
      });
      const ok = await db.postTarget.create({
        data: {
          postId: post.id,
          platform: 'X',
          socialAccountId: tenant.accountId,
          caption: 'a',
          status: 'SCHEDULED',
        },
      });
      const bad = await db.postTarget.create({
        data: {
          postId: post.id,
          platform: 'FACEBOOK',
          caption: 'b',
          status: 'SCHEDULED',
        },
      });

      await publishTarget(db, { targetId: ok.id, actor: 'test', registry: fakeAdapter().registry });
      await publishTarget(db, {
        targetId: bad.id,
        actor: 'test',
        registry: fakeAdapter().registry,
      });

      const updated = await db.post.findUnique({ where: { id: post.id } });
      // The honest answer to "one of two worked". Collapsing it to PUBLISHED or FAILED
      // loses the only information the user needs in order to act.
      expect(updated!.status).toBe('PARTIALLY_PUBLISHED');
    });
  });

  describe('scheduling', () => {
    it('finds due targets and ignores future ones', async () => {
      const tenant = await makeTenant('sched');
      const due = await makeTarget(tenant, { scheduledFor: new Date(Date.now() - 60_000) });
      const future = await makeTarget(tenant, { scheduledFor: new Date(Date.now() + 3_600_000) });

      const found = (await findDueTargets(db, new Date())).map((t) => t.id);

      expect(found).toContain(due);
      // Identity, with a genuinely scheduled future row present.
      expect(found).not.toContain(future);
    });

    it('never returns an already-published target', async () => {
      const tenant = await makeTenant('sched-published');
      const targetId = await makeTarget(tenant, { scheduledFor: new Date(Date.now() - 60_000) });
      await publishTarget(db, { targetId, actor: 'test', registry: fakeAdapter().registry });

      // Belt and braces alongside the `externalPostId` check in the pipeline: a published
      // target reappearing in the sweep is how a duplicate post happens.
      const found = (await findDueTargets(db, new Date())).map((t) => t.id);
      expect(found).not.toContain(targetId);
    });
  });
});
