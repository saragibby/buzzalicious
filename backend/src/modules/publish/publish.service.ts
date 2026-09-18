import type { Platform, PostTarget, TargetStatus } from '@prisma/client';
import { getConfig } from '../../platform/config';
import type { Db } from '../../platform/db';
import { getLogger } from '../../platform/logger';
import { getStorage } from '../../platform/storage';
import type { AdapterRegistry } from './adapter.registry';
import { getAdapter } from './adapter.registry';
import type { PublishInput, PublishMedia, PublishResult } from './adapter.types';
import { PlatformMetaSchema } from './credential.schemas';
import { CredentialUnavailableError, resolveCredential } from './credential.resolver';
import { isPlatformError, type PlatformError } from './publish.errors';
import { emitUsage } from '../usage/usage.service';

/**
 * The publish pipeline: one attempt at one `PostTarget`.
 *
 * Scope discipline is the main thing here. This module decides *policy* — idempotency,
 * retry, classification, status rollup, metering — and knows nothing about any particular
 * platform's HTTP. Adapters know the HTTP and decide nothing. Keeping that line sharp is
 * what makes three more platforms in PR 2 additive rather than a rewrite.
 *
 * One job per target, never one per post (docs/08). A post going to four networks where
 * Instagram is rejected must still reach the other three; a single job would either lose
 * them or republish them on retry.
 */

export interface PublishTargetOptions {
  targetId: string;
  actor: string;
  registry?: AdapterRegistry;
  now?: Date;
}

export type PublishOutcome =
  | { kind: 'published'; target: PostTarget; result: PublishResult; metered: boolean }
  | { kind: 'already-published'; target: PostTarget }
  | { kind: 'retry'; target: PostTarget; error: PlatformError; nextAttemptAt: Date }
  | { kind: 'failed'; target: PostTarget; error: PlatformError }
  | { kind: 'blocked'; target: PostTarget; reason: string };

/**
 * Exponential backoff with a QUOTA special case.
 *
 * A quota error is not a transient one even though both mean "later": a daily publishing
 * limit clears at a window boundary, not in ninety seconds, and retrying against it burns
 * attempts for nothing and can attract rate limiting of its own.
 */
export function backoffFor(attempt: number, error: PlatformError, now: Date = new Date()): Date {
  if (error.retryAfterSeconds && error.retryAfterSeconds > 0) {
    return new Date(now.getTime() + error.retryAfterSeconds * 1000);
  }
  if (error.errorClass === 'QUOTA') {
    return new Date(now.getTime() + 60 * 60 * 1000);
  }
  // 1m, 2m, 4m, 8m… capped. Capped because an uncapped doubling reaches "next week" by
  // attempt 12, which is indistinguishable from never for a social post.
  const minutes = Math.min(2 ** Math.max(0, attempt - 1), 60);
  return new Date(now.getTime() + minutes * 60 * 1000);
}

/** Error classes where retrying cannot possibly help. */
const TERMINAL = new Set(['VALIDATION', 'POLICY']);

export async function publishTarget(
  db: Db,
  options: PublishTargetOptions,
): Promise<PublishOutcome> {
  const now = options.now ?? new Date();
  const log = getLogger();

  const target = await db.postTarget.findUnique({
    where: { id: options.targetId },
    include: {
      post: { include: { brand: { select: { id: true, workspaceId: true } } } },
      socialAccount: true,
      rendition: true,
    },
  });

  if (!target) {
    throw new CredentialUnavailableError('X', `post target ${options.targetId} no longer exists`);
  }

  /**
   * Idempotency, and the reason it is a column rather than a job-queue feature.
   *
   * pg-boss guarantees at-least-once delivery, so a handler *will* occasionally run twice
   * for one target — a worker dyno cycled mid-publish is the ordinary case, and by then
   * the platform has already accepted the post. `externalPostId` is the durable record
   * that it did. Checking it first is what stops a restart from double-posting, which is
   * the single most visible failure a publishing tool can have.
   */
  if (target.externalPostId) {
    return { kind: 'already-published', target };
  }

  if (!target.socialAccount) {
    return await block(db, target, 'This destination has no connected account.', now);
  }
  if (target.socialAccount.status !== 'ACTIVE') {
    return await block(
      db,
      target,
      `The connected ${target.platform} account needs to be reconnected.`,
      now,
    );
  }

  const workspaceId = target.post.brand.workspaceId;
  const brandId = target.post.brand.id;

  await db.postTarget.update({
    where: { id: target.id },
    data: { status: 'PUBLISHING', attempts: { increment: 1 }, nextAttemptAt: null },
  });

  try {
    const credential = await resolveCredential(db, {
      workspaceId,
      brandId,
      platform: target.platform,
      actor: options.actor,
      credentialId: target.socialAccount.credentialId ?? undefined,
      context: { postTargetId: target.id },
    });

    const adapter = getAdapter(target.platform, options.registry);
    const input = await buildPublishInput(target, now);
    const result = await adapter.publish(credential, input);

    return await recordSuccess(db, target, result, { workspaceId, brandId });
  } catch (error) {
    if (error instanceof CredentialUnavailableError) {
      // A missing or revoked *credential* is not a failed post. The content is fine and
      // will publish as soon as the client reconnects, so BLOCKED is both accurate and
      // the state the UI can offer a fix from.
      return await block(db, target, error.message, now);
    }

    if (!isPlatformError(error)) {
      log.error({ err: error, targetId: target.id }, 'Unclassified publish failure');
      throw error;
    }

    return await recordFailure(db, target, error, now);
  }
}

async function buildPublishInput(
  target: PostTarget & {
    rendition: {
      storageKey: string;
      mimeType: string;
      width: number;
      height: number;
      aspectRatio: PublishMedia['aspectRatio'];
    } | null;
    socialAccount: {
      externalId: string;
      accessToken: string;
      refreshToken: string | null;
      tokenSecret: string | null;
      expiresAt: Date | null;
      scopes: string[];
      platformMeta: unknown;
    } | null;
  },
  _now: Date,
): Promise<PublishInput> {
  const account = target.socialAccount;
  if (!account) {
    // A developer mistake rather than a client one — `publishTarget` has already refused
    // a target with no account. The eslint exemption is deliberate: this must stay a bare
    // Error so it becomes a non-exposed 500 instead of a message shown to a user.
    // eslint-disable-next-line no-restricted-syntax
    throw new Error('unreachable: account checked by caller');
  }

  const media: PublishMedia[] = [];
  if (target.rendition) {
    // Meta fetches media by URL rather than accepting an upload, so the URL has to be
    // reachable from outside. A signed, expiring URL is the only form that satisfies both
    // that and docs/10's rule that rendered assets are not public.
    media.push({
      url: await getStorage().signedUrl(target.rendition.storageKey),
      mimeType: target.rendition.mimeType,
      width: target.rendition.width,
      height: target.rendition.height,
      aspectRatio: target.rendition.aspectRatio,
    });
  }

  const platformMeta = PlatformMetaSchema.safeParse(account.platformMeta ?? {});

  return {
    account: {
      externalId: account.externalId,
      tokens: {
        accessToken: account.accessToken,
        refreshToken: account.refreshToken ?? undefined,
        tokenSecret: account.tokenSecret ?? undefined,
        expiresAt: account.expiresAt,
        scopes: account.scopes,
      },
      platformMeta: platformMeta.success ? platformMeta.data : {},
    },
    caption: target.caption ?? '',
    media,
    // Attempt-independent by construction. The same string is the usage idempotency key,
    // which is what makes "published after three retries" bill once.
    idempotencyKey: publishKey(target.id),
  };
}

/** The one place the publish idempotency key is spelled. */
export function publishKey(targetId: string): string {
  return `publish:${targetId}`;
}

async function recordSuccess(
  db: Db,
  target: PostTarget,
  result: PublishResult,
  scope: { workspaceId: string; brandId: string },
): Promise<PublishOutcome> {
  /**
   * The status write and the usage event share one transaction.
   *
   * ADR-0011's rule is that an event must never be recorded for work that rolled back,
   * and the converse matters just as much here: a target marked PUBLISHED whose meter
   * write was lost is revenue silently dropped, and nothing downstream would ever notice
   * because the post looks fine.
   */
  const { updated, metered } = await db.$transaction(async (tx) => {
    const updated = await tx.postTarget.update({
      where: { id: target.id },
      data: {
        status: 'PUBLISHED',
        externalPostId: result.externalPostId,
        externalUrl: result.externalUrl ?? null,
        publishedAt: result.publishedAt,
        lastError: null,
        errorClass: null,
        nextAttemptAt: null,
      },
    });

    const usage = await emitUsage(tx, {
      workspaceId: scope.workspaceId,
      brandId: scope.brandId,
      metric: 'POST_PUBLISHED',
      quantity: 1,
      // Attempt-independent: `publish:{postTargetId}`. Adding the attempt number here is
      // the documented way to bill a client three times for one post.
      idempotencyKey: publishKey(target.id),
      occurredAt: result.publishedAt,
      postTargetId: target.id,
      metadata: { platform: target.platform },
    });

    return { updated, metered: usage.recorded };
  });

  await rollUpPost(db, target.postId);
  return { kind: 'published', target: updated, result, metered };
}

async function recordFailure(
  db: Db,
  target: PostTarget,
  error: PlatformError,
  now: Date,
): Promise<PublishOutcome> {
  const attempts = target.attempts + 1;
  const exhausted = attempts >= getConfig().publish.maxAttempts;
  const terminal = TERMINAL.has(error.errorClass);

  // AUTH means the token is dead; the same token will be just as dead in four minutes.
  // Retrying is pure noise, and the fix is a human reconnecting the account.
  const authFailure = error.errorClass === 'AUTH';

  if (terminal || authFailure || exhausted) {
    const status: TargetStatus = authFailure ? 'BLOCKED' : 'FAILED';
    const updated = await db.postTarget.update({
      where: { id: target.id },
      data: {
        status,
        lastError: error.clientMessage,
        errorClass: error.errorClass,
        nextAttemptAt: null,
      },
    });
    await rollUpPost(db, target.postId);
    return status === 'BLOCKED'
      ? { kind: 'blocked', target: updated, reason: error.clientMessage }
      : { kind: 'failed', target: updated, error };
  }

  const nextAttemptAt = backoffFor(attempts, error, now);
  const updated = await db.postTarget.update({
    where: { id: target.id },
    data: {
      // Back to SCHEDULED rather than a bespoke RETRYING state: the sweep that picks up
      // due work already looks for scheduled targets, and a second waiting state would be
      // a second thing to remember to sweep.
      status: 'SCHEDULED',
      lastError: error.clientMessage,
      errorClass: error.errorClass,
      nextAttemptAt,
    },
  });

  return { kind: 'retry', target: updated, error, nextAttemptAt };
}

async function block(
  db: Db,
  target: PostTarget,
  reason: string,
  _now: Date,
): Promise<PublishOutcome> {
  const updated = await db.postTarget.update({
    where: { id: target.id },
    data: {
      status: 'BLOCKED',
      lastError: reason,
      errorClass: 'CREDENTIAL',
      nextAttemptAt: null,
    },
  });
  await rollUpPost(db, target.postId);
  return { kind: 'blocked', target: updated, reason };
}

/**
 * Derive the post's status from its targets.
 *
 * `PARTIALLY_PUBLISHED` exists because the honest answer to "three of four worked" is
 * neither PUBLISHED nor FAILED, and collapsing it to either one loses the only
 * information the user needs in order to act.
 */
export async function rollUpPost(db: Db, postId: string): Promise<void> {
  const targets = await db.postTarget.findMany({
    where: { postId },
    select: { status: true },
  });

  const relevant = targets.filter((t) => t.status !== 'CANCELLED' && t.status !== 'DRAFT');
  if (relevant.length === 0) return;

  const published = relevant.filter((t) => t.status === 'PUBLISHED').length;
  const settled = relevant.filter(
    (t) => t.status === 'PUBLISHED' || t.status === 'FAILED' || t.status === 'BLOCKED',
  ).length;

  // Still work in flight — leave the post alone rather than flapping its status between
  // every target completing.
  if (settled < relevant.length) return;

  const status =
    published === relevant.length ? 'PUBLISHED' : published > 0 ? 'PARTIALLY_PUBLISHED' : 'FAILED';

  await db.post.update({
    where: { id: postId },
    // No `publishedAt` on Post: the timestamp belongs to the target, because a partially
    // published post has several of them and no single one is the answer.
    data: { status },
  });
}

export type { Platform };
