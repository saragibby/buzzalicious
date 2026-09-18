import type { Platform } from '@prisma/client';
import type { Db } from '../../platform/db';
import { getLogger } from '../../platform/logger';
import { getAdapter, type AdapterRegistry } from '../publish/adapter.registry';
import { CredentialUnavailableError, resolveCredential } from '../publish/credential.resolver';
import { PlatformMetaSchema } from '../publish/credential.schemas';
import { isPlatformError } from '../publish/publish.errors';
import { clicksAreMeasurable } from '../link/rollup.service';
import { CHECKPOINT_HOURS, checkpointAt, dueCheckpoints, hoursSincePublish } from './poll.schedule';

/**
 * Reading metrics back from the platforms, one immutable snapshot at a time.
 *
 * ## A zero is a lie
 *
 * Metric availability varies sharply by platform and by account type: a personal IG
 * account exposes almost nothing, a Business one exposes reach; X impressions depend on
 * the access tier. Every field on `PlatformMetrics` is therefore nullable, and a null
 * must survive all the way to storage.
 *
 * Coercing `null` to `0` anywhere in this path would be indistinguishable from a real
 * zero one row later, and the recommender would learn that posts it could not measure
 * were the ones that failed. `?? 0` is the specific thing not to write here.
 */

export interface PollOptions {
  now?: Date;
  registry?: AdapterRegistry;
  actor?: string;
  /** Cap on targets handled in one sweep, so a backlog cannot monopolise the worker. */
  limit?: number;
}

export type PollOutcome =
  | { kind: 'captured'; targetId: string; capturedAt: Date }
  | { kind: 'duplicate'; targetId: string; capturedAt: Date }
  | { kind: 'unavailable'; targetId: string; reason: string }
  | { kind: 'failed'; targetId: string; reason: string };

/**
 * First-party clicks for a target, as of a checkpoint.
 *
 * `null` rather than `0` where the platform cannot carry a tracked caption link at all.
 * Instagram is the case that matters: its short link exists but was never published in
 * the caption, so counting its clicks as zero would assert something we did not measure.
 */
export async function countLinkClicks(
  db: Db,
  postId: string,
  platform: Platform,
  until: Date,
): Promise<number | null> {
  if (!clicksAreMeasurable(platform)) return null;

  const link = await db.shortLink.findFirst({ where: { postId, platform } });
  if (!link) return null;

  return await db.linkClick.count({
    where: { shortLinkId: link.id, isBot: false, occurredAt: { lte: until } },
  });
}

/**
 * Capture one snapshot for one target at one checkpoint.
 *
 * Writes with `capturedAt` set to the checkpoint rather than `now()`, so a redelivered
 * job collides with the row it already wrote instead of producing a near-duplicate — see
 * `poll.schedule.ts`. The collision is caught rather than prevented by a pre-read: two
 * workers can pass the same pre-read concurrently, and the unique constraint is the only
 * thing that actually holds.
 */
export async function captureSnapshot(
  db: Db,
  targetId: string,
  checkpoint: { hour: number; capturedAt: Date },
  options: PollOptions = {},
): Promise<PollOutcome> {
  const log = getLogger();

  const target = await db.postTarget.findUnique({
    where: { id: targetId },
    include: {
      post: { include: { brand: { select: { id: true, workspaceId: true } } } },
      socialAccount: true,
    },
  });

  if (!target || !target.externalPostId || !target.publishedAt) {
    return { kind: 'unavailable', targetId, reason: 'target is not published' };
  }
  if (!target.socialAccount) {
    return { kind: 'unavailable', targetId, reason: 'no connected account' };
  }

  let metrics;
  try {
    const credential = await resolveCredential(db, {
      workspaceId: target.post.brand.workspaceId,
      brandId: target.post.brand.id,
      platform: target.platform,
      actor: options.actor ?? 'metrics.poll',
      credentialId: target.socialAccount.credentialId ?? undefined,
      context: { postTargetId: target.id },
    });

    const adapter = getAdapter(target.platform, options.registry);
    const platformMeta = PlatformMetaSchema.safeParse(target.socialAccount.platformMeta ?? {});

    metrics = await adapter.fetchMetrics(credential, {
      externalPostId: target.externalPostId,
      account: {
        externalId: target.socialAccount.externalId,
        tokens: {
          accessToken: target.socialAccount.accessToken,
          refreshToken: target.socialAccount.refreshToken ?? undefined,
          tokenSecret: target.socialAccount.tokenSecret ?? undefined,
          expiresAt: target.socialAccount.expiresAt,
          scopes: target.socialAccount.scopes,
        },
        platformMeta: platformMeta.success ? platformMeta.data : {},
      },
    });
  } catch (error) {
    if (error instanceof CredentialUnavailableError) {
      return { kind: 'unavailable', targetId, reason: error.message };
    }
    if (isPlatformError(error)) {
      // A failed read is not a failed post. It is also not a zero: writing one would
      // fabricate a measurement, so nothing is stored and the checkpoint stays due.
      log.warn({ targetId, err: error }, 'Metric fetch failed; no snapshot written');
      return { kind: 'failed', targetId, reason: error.message };
    }
    throw error;
  }

  const linkClicks = await countLinkClicks(
    db,
    target.postId,
    target.platform,
    checkpoint.capturedAt,
  );

  try {
    await db.postMetric.create({
      data: {
        postTargetId: target.id,
        capturedAt: checkpoint.capturedAt,
        source: target.platform,
        // Spread-free and field-by-field on purpose: `?? 0` must never creep in here, and
        // an explicit list makes a new nullable field a compile error rather than a
        // silently-dropped column.
        impressions: metrics.impressions ?? null,
        reach: metrics.reach ?? null,
        likes: metrics.likes ?? null,
        comments: metrics.comments ?? null,
        shares: metrics.shares ?? null,
        saves: metrics.saves ?? null,
        videoViews: metrics.videoViews ?? null,
        linkClicks,
        raw: {
          fetchedAt: metrics.collectedAt.toISOString(),
          hoursSincePublish: hoursSincePublish(target.publishedAt, checkpoint.capturedAt),
        },
      },
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return { kind: 'duplicate', targetId, capturedAt: checkpoint.capturedAt };
    }
    throw error;
  }

  return { kind: 'captured', targetId, capturedAt: checkpoint.capturedAt };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002'
  );
}

/**
 * Every checkpoint currently owed, across all published targets.
 *
 * Deliberately unscoped: this runs from a cron on the worker, where there is no request
 * and therefore no tenant. Nothing it returns is served to a user — the read path in
 * `insight.service.ts` is scoped like everything else.
 */
export async function findDueSnapshots(
  db: Db,
  options: PollOptions = {},
): Promise<{ targetId: string; hour: number; capturedAt: Date }[]> {
  const now = options.now ?? new Date();
  // Posts past the final checkpoint can never owe another snapshot, so they are excluded
  // in SQL rather than fetched and filtered — otherwise this query grows without bound as
  // the account's history does.
  const lastHour = CHECKPOINT_HOURS[CHECKPOINT_HOURS.length - 1]!;
  const oldest = checkpointAt(now, -lastHour);

  const targets = await db.postTarget.findMany({
    where: {
      externalPostId: { not: null },
      publishedAt: { not: null, gte: oldest },
    },
    select: {
      id: true,
      publishedAt: true,
      metrics: { select: { capturedAt: true } },
    },
    take: options.limit ?? 200,
  });

  const due: { targetId: string; hour: number; capturedAt: Date }[] = [];
  for (const target of targets) {
    const captured = target.metrics.map((metric) => metric.capturedAt);
    for (const checkpoint of dueCheckpoints(target.publishedAt!, now, captured)) {
      due.push({ targetId: target.id, ...checkpoint });
    }
  }

  return due;
}
