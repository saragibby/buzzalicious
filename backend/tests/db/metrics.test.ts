import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectPrisma, getPrisma, type Db } from '../../src/platform/db';
import { captureSnapshot, findDueSnapshots } from '../../src/modules/insight/metrics.service';
import { handleMetricsSweep } from '../../src/jobs/handlers/metrics.handlers';
import { checkpointAt } from '../../src/modules/insight/poll.schedule';
import type { AdapterRegistry } from '../../src/modules/publish/adapter.registry';
import type { PlatformAdapter, PlatformMetrics } from '../../src/modules/publish/adapter.types';
import { X_SPEC } from '../../src/modules/publish/x/x.adapter';
import { classifyPlatformError } from '../../src/modules/publish/publish.errors';
import { hasTestDatabase } from '../env';

/**
 * Metric snapshots against a real database.
 *
 * The invariants here fail silently by construction: a mutated total still reads as a
 * number, a null coerced to zero still reads as a number, and a duplicated snapshot still
 * reads as history. Every assertion in this file is therefore about the *shape* of what
 * was stored rather than about a call returning without throwing.
 */

function registryReturning(metrics: Partial<PlatformMetrics>): {
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
    publish: async () => ({
      externalPostId: 'x',
      externalUrl: 'https://x.test/1',
      publishedAt: new Date(),
    }),
    fetchMetrics: async (): Promise<PlatformMetrics> => {
      state.calls += 1;
      return { collectedAt: new Date(), ...metrics };
    },
  } as unknown as PlatformAdapter;

  return {
    registry: { X: adapter } as AdapterRegistry,
    get calls() {
      return state.calls;
    },
  } as { registry: AdapterRegistry; calls: number };
}

describe.skipIf(!hasTestDatabase)('metric snapshots', () => {
  let db: Db;
  const workspaceIds: string[] = [];

  const PUBLISHED = new Date('2024-06-01T00:00:00Z');

  async function makeTarget(options: { platform?: 'X' | 'INSTAGRAM' } = {}): Promise<{
    targetId: string;
    postId: string;
    brandId: string;
  }> {
    const workspaceId = randomUUID();
    const brandId = randomUUID();
    const platform = options.platform ?? 'X';

    await db.workspace.create({
      data: { id: workspaceId, slug: `met-${workspaceId.slice(0, 8)}`, name: 'Metrics' },
    });
    workspaceIds.push(workspaceId);

    await db.brand.create({
      data: {
        id: brandId,
        workspaceId,
        name: 'Metrics brand',
        slug: `mb-${brandId.slice(0, 8)}`,
        website: 'https://example.test/',
        palette: {},
        typography: {},
        voiceGuide: {},
      },
    });

    const credential = await db.platformCredential.create({
      data: {
        workspaceId,
        brandId,
        platform,
        mode: 'CLIENT_APP',
        label: 'app',
        appId: `app-${brandId.slice(0, 6)}`,
        appSecret: 'secret',
        redirectUri: 'https://example.test/cb',
        grantedScopes: [],
        requiredScopes: [],
        status: 'ACTIVE',
      },
    });

    const account = await db.socialAccount.create({
      data: {
        brandId,
        platform,
        externalId: `acct-${brandId.slice(0, 6)}`,
        handle: 'brand',
        accessToken: 'token',
        tokenSecret: 'tsecret',
        scopes: [],
        credentialId: credential.id,
        status: 'ACTIVE',
      },
    });

    const post = await db.post.create({
      data: { brandId, title: 'Measured post', status: 'PUBLISHED' },
    });

    const target = await db.postTarget.create({
      data: {
        postId: post.id,
        platform,
        socialAccountId: account.id,
        caption: 'published',
        status: 'PUBLISHED',
        externalPostId: `ext-${randomUUID().slice(0, 8)}`,
        publishedAt: PUBLISHED,
      },
    });

    return { targetId: target.id, postId: post.id, brandId };
  }

  beforeAll(() => {
    db = getPrisma();
  });

  afterAll(async () => {
    for (const id of workspaceIds) {
      await db.workspace.deleteMany({ where: { id } });
    }
    await disconnectPrisma();
  });

  describe('history is never rewritten', () => {
    it('writes a new snapshot per checkpoint instead of updating the last one', async () => {
      const { targetId } = await makeTarget();
      const { registry } = registryReturning({ likes: 10 });

      await captureSnapshot(
        db,
        targetId,
        { hour: 1, capturedAt: checkpointAt(PUBLISHED, 1) },
        { registry },
      );
      const later = registryReturning({ likes: 40 });
      await captureSnapshot(
        db,
        targetId,
        { hour: 24, capturedAt: checkpointAt(PUBLISHED, 24) },
        { registry: later.registry },
      );

      const rows = await db.postMetric.findMany({
        where: { postTargetId: targetId },
        orderBy: { capturedAt: 'asc' },
      });

      // Two rows, and the FIRST still says 10. An implementation that updated in place
      // would leave one row saying 40 — still a plausible number, and the shape of the
      // curve, which is the actual product, would be gone.
      expect(rows).toHaveLength(2);
      expect(rows[0]!.likes).toBe(10);
      expect(rows[1]!.likes).toBe(40);
    });

    it('is a no-op when the same checkpoint is delivered twice', async () => {
      const { targetId } = await makeTarget();
      const checkpoint = { hour: 1, capturedAt: checkpointAt(PUBLISHED, 1) };
      const { registry } = registryReturning({ likes: 7 });

      const first = await captureSnapshot(db, targetId, checkpoint, { registry });
      const second = await captureSnapshot(db, targetId, checkpoint, { registry });

      expect(first.kind).toBe('captured');
      expect(second.kind).toBe('duplicate');
      expect(await db.postMetric.count({ where: { postTargetId: targetId } })).toBe(1);
    });

    it('stamps the checkpoint time, not the time the job ran', async () => {
      const { targetId } = await makeTarget();
      const { registry } = registryReturning({ likes: 1 });

      await captureSnapshot(
        db,
        targetId,
        { hour: 24, capturedAt: checkpointAt(PUBLISHED, 24) },
        { registry },
      );

      const row = await db.postMetric.findFirst({ where: { postTargetId: targetId } });
      expect(row!.capturedAt).toEqual(checkpointAt(PUBLISHED, 24));

      // `hoursSincePublish` is what makes two snapshots comparable like-for-like, so a
      // 24h row claiming 24 hours is the assertion, not merely that the field is present.
      expect((row!.raw as { hoursSincePublish: number }).hoursSincePublish).toBe(24);
    });
  });

  describe('a zero is a lie', () => {
    // Asserting on one field only would leave every other `?? null` free to become
    // `?? 0` unnoticed, so each nullable column is reported in turn and every other one
    // is checked to still be null. A single unprotected field is a fabricated
    // measurement that W8 cannot tell apart from a real one.
    const NULLABLE = [
      'impressions',
      'reach',
      'likes',
      'comments',
      'shares',
      'saves',
      'videoViews',
    ] as const;

    it.each(NULLABLE)(
      'stores every other metric as null when only %s is reported',
      async (reported) => {
        const { targetId } = await makeTarget();
        const { registry } = registryReturning({ [reported]: 3 });

        await captureSnapshot(
          db,
          targetId,
          { hour: 1, capturedAt: checkpointAt(PUBLISHED, 1) },
          { registry },
        );

        const row = await db.postMetric.findFirst({ where: { postTargetId: targetId } });
        expect(row![reported]).toBe(3);
        for (const field of NULLABLE) {
          if (field === reported) continue;
          expect(row![field], `${field} should be null, not fabricated`).toBeNull();
          expect(row![field]).not.toBe(0);
        }
      },
    );

    it('records a genuine zero as zero, because earning nothing is information', async () => {
      const { targetId } = await makeTarget();
      const { registry } = registryReturning({ likes: 0 });

      await captureSnapshot(
        db,
        targetId,
        { hour: 1, capturedAt: checkpointAt(PUBLISHED, 1) },
        { registry },
      );

      const row = await db.postMetric.findFirst({ where: { postTargetId: targetId } });
      expect(row!.likes).toBe(0);
      expect(row!.likes).not.toBeNull();
    });

    it('counts first-party clicks, excluding bots', async () => {
      const { targetId, postId, brandId } = await makeTarget();
      const link = await db.shortLink.create({
        data: {
          slug: `m${randomUUID().replace(/-/g, '').slice(0, 6)}`,
          brandId,
          postId,
          platform: 'X',
          destinationUrl: 'https://example.test/',
        },
      });

      for (let i = 0; i < 4; i += 1) {
        await db.linkClick.create({
          data: { shortLinkId: link.id, isBot: false, occurredAt: checkpointAt(PUBLISHED, 0.5) },
        });
      }
      await db.linkClick.create({
        data: {
          shortLinkId: link.id,
          isBot: true,
          botReason: 'ua-crawler',
          occurredAt: checkpointAt(PUBLISHED, 0.1),
        },
      });
      // After the checkpoint, so it belongs to the next snapshot rather than this one.
      await db.linkClick.create({
        data: { shortLinkId: link.id, isBot: false, occurredAt: checkpointAt(PUBLISHED, 5) },
      });

      const { registry } = registryReturning({ likes: 1 });
      await captureSnapshot(
        db,
        targetId,
        { hour: 1, capturedAt: checkpointAt(PUBLISHED, 1) },
        { registry },
      );

      const row = await db.postMetric.findFirst({ where: { postTargetId: targetId } });
      // 4, not 5 (bot excluded) and not 6 (later click belongs to a later checkpoint).
      expect(row!.linkClicks).toBe(4);
    });

    it('reports Instagram link clicks as null, never as zero', async () => {
      const { targetId, postId, brandId } = await makeTarget({ platform: 'INSTAGRAM' });
      await db.shortLink.create({
        data: {
          slug: `i${randomUUID().replace(/-/g, '').slice(0, 6)}`,
          brandId,
          postId,
          platform: 'INSTAGRAM',
          destinationUrl: 'https://example.test/',
        },
      });

      const adapter = registryReturning({ likes: 2 });
      // The Instagram adapter under a key the registry will find.
      const registry = { INSTAGRAM: adapter.registry.X } as unknown as AdapterRegistry;

      await captureSnapshot(
        db,
        targetId,
        { hour: 1, capturedAt: checkpointAt(PUBLISHED, 1) },
        { registry },
      );

      const row = await db.postMetric.findFirst({ where: { postTargetId: targetId } });
      expect(row).not.toBeNull();
      // The link exists, so this is not "no link found" — it is "this platform cannot
      // carry a tracked caption link", which is an unknown rather than a zero.
      expect(row!.linkClicks).toBeNull();
      expect(row!.linkClicks).not.toBe(0);
    });
  });

  describe('a failed read writes nothing', () => {
    it('leaves the checkpoint due rather than storing a fabricated snapshot', async () => {
      const { targetId } = await makeTarget();

      const failing = {
        ...(registryReturning({}).registry.X as object),
        fetchMetrics: async () => {
          // A real classified platform error, not a bare Error. An unclassified throw is
          // a programming mistake and `captureSnapshot` rethrows it on purpose, so using
          // one here would test the wrong path.
          throw classifyPlatformError({ platform: 'X', status: 429, message: 'rate limited' });
        },
      } as unknown as PlatformAdapter;

      const outcome = await captureSnapshot(
        db,
        targetId,
        { hour: 1, capturedAt: checkpointAt(PUBLISHED, 1) },
        { registry: { X: failing } as AdapterRegistry },
      );

      expect(outcome.kind).toBe('failed');
      // Nothing stored — a zero-filled row would be indistinguishable from a real
      // measurement one row later.
      expect(await db.postMetric.count({ where: { postTargetId: targetId } })).toBe(0);

      // And the checkpoint is still owed, so the next tick retries it.
      const due = await findDueSnapshots(db, { now: checkpointAt(PUBLISHED, 2) });
      expect(due.map((d) => d.targetId)).toContain(targetId);
    });
  });

  describe('the sweep', () => {
    it('backfills every checkpoint missed while the worker was down', async () => {
      const { targetId } = await makeTarget();
      const { registry } = registryReturning({ likes: 5 });

      // Two days after publish with nothing captured: 1h and 24h are both owed.
      const due = await findDueSnapshots(db, { now: checkpointAt(PUBLISHED, 48) });
      const mine = due.filter((d) => d.targetId === targetId);
      expect(mine.map((d) => d.hour)).toEqual([1, 24]);

      for (const checkpoint of mine) {
        await captureSnapshot(db, targetId, checkpoint, { registry });
      }

      const rows = await db.postMetric.findMany({
        where: { postTargetId: targetId },
        orderBy: { capturedAt: 'asc' },
      });
      expect(rows.map((r) => (r.raw as { hoursSincePublish: number }).hoursSincePublish)).toEqual([
        1, 24,
      ]);
    });

    it('captures the healthy target even when another one fails', async () => {
      const good = await makeTarget();
      const bad = await makeTarget();

      const badTarget = await db.postTarget.findUnique({ where: { id: bad.targetId } });

      // Fails for exactly one target, by its external id. A registry that threw for
      // everything would pass a "sweep did not throw" assertion while capturing nothing.
      const selective = {
        ...(registryReturning({}).registry.X as object),
        fetchMetrics: async (_c: unknown, target: { externalPostId: string }) => {
          if (target.externalPostId === badTarget!.externalPostId) {
            throw classifyPlatformError({ platform: 'X', status: 429, message: 'rate limited' });
          }
          return { collectedAt: new Date(), likes: 9 };
        },
      } as unknown as PlatformAdapter;

      await handleMetricsSweep({
        db,
        now: checkpointAt(PUBLISHED, 2),
        limit: 500,
        registry: { X: selective } as AdapterRegistry,
      });

      // The healthy target got its snapshot despite the other one failing in the same
      // sweep. Abandoning on first failure would turn one bad row into a gap across
      // every post published that hour.
      const goodRows = await db.postMetric.findMany({ where: { postTargetId: good.targetId } });
      expect(goodRows).toHaveLength(1);
      expect(goodRows[0]!.likes).toBe(9);

      // And the failing one stored nothing rather than a fabricated zero.
      expect(await db.postMetric.count({ where: { postTargetId: bad.targetId } })).toBe(0);
    });
  });
});
