import { PgBoss, type Job } from 'pg-boss';
import { getConfig } from '../platform/config';
import { getPrisma } from '../platform/db';
import { getLogger } from '../platform/logger';
import { ExternalServiceError } from '../platform/errors';
import {
  handlePublishSweep,
  handlePublishTarget,
  type HandlerDeps,
} from './handlers/publish.handlers';
import { handleAccountHealthSweep } from './handlers/health.handlers';
import { handleMetricsSweep } from './handlers/metrics.handlers';
import { QUEUE } from './queues';

/**
 * pg-boss worker (ADR-0004: Postgres, no Redis).
 *
 * Replaces the M1 stub. Two things here are deliberate and worth not undoing:
 *
 * **The sweep is a cron, and it is the safety net.** Every scheduled target is a row with
 * a due time; the queue only exists to notice. That means a lost job costs one sweep
 * interval rather than a silently missed post, and it means the system recovers from a
 * queue outage without anyone replaying anything by hand.
 *
 * **Handlers are bound to their dependencies here and nowhere else.** The handler
 * functions take a `HandlerDeps`, so tests call them directly with a fake adapter and a
 * real database. Nothing about publishing requires a running queue to test.
 *
 * Job payloads carry identifiers only — never a credential, never a token (docs/10).
 */

let boss: PgBoss | null = null;

/** Exported for the sweep and for any route that wants to publish now. */
export async function enqueuePublish(targetId: string): Promise<void> {
  if (!boss) {
    // Reachable in production: a web dyno can serve a publish request before (or without)
    // the worker's boot having run. A typed error means the HTTP layer answers 503 rather
    // than leaking a stack trace through the generic handler.
    throw new ExternalServiceError('worker', 'Worker is not running; cannot enqueue a publish job');
  }
  await boss.send(
    QUEUE.publishTarget,
    { targetId },
    {
      // Retries here are a backstop for a *crashed* handler. Ordinary publish failures are
      // recorded on the row with their own backoff and are not thrown, so this does not
      // double up with the pipeline's retry policy.
      retryLimit: 2,
      retryBackoff: true,
      // Collapses duplicate deliveries for the same target inside the window. Idempotency
      // still rests on `externalPostId`; this just avoids the wasted work.
      singletonKey: targetId,
    },
  );
}

function deps(): HandlerDeps {
  return { db: getPrisma(), enqueuePublish };
}

export async function startWorker(): Promise<void> {
  if (boss) return;
  const config = getConfig();
  const log = getLogger();

  const instance = new PgBoss({
    connectionString: config.databaseUrl,
    // Heroku Postgres terminates idle connections; the worker dyno must not sleep, so the
    // pool has to survive that rather than dying on the next send.
    max: 4,
  });

  instance.on('error', (error: Error) => log.error({ err: error }, 'pg-boss error'));

  await instance.start();
  boss = instance;

  await instance.createQueue(QUEUE.publishTarget);
  await instance.createQueue(QUEUE.publishSweep);
  await instance.createQueue(QUEUE.accountHealth);
  await instance.createQueue(QUEUE.metricsPoll);

  await instance.work(QUEUE.publishTarget, async (jobs: Job<unknown>[]) => {
    for (const job of jobs) {
      await handlePublishTarget(deps(), job.data);
    }
  });

  await instance.work(QUEUE.publishSweep, async () => {
    await handlePublishSweep(deps());
  });

  // Every minute. Finer would add load for no benefit — a post scheduled to the minute is
  // already at the mercy of platform latency — and coarser would make a one-minute retry
  // backoff meaningless.
  await instance.schedule(QUEUE.publishSweep, '* * * * *');

  await instance.work(QUEUE.accountHealth, async () => {
    await handleAccountHealthSweep({ db: getPrisma() });
  });

  // Hourly, on the hour. The sweep refreshes anything inside a seven-day window, so the
  // interval only has to be small relative to that — hourly gives roughly 168 chances to
  // refresh a token before it expires, which survives a worker being down for a day.
  await instance.schedule(QUEUE.accountHealth, '0 * * * *');

  await instance.work(QUEUE.metricsPoll, async () => {
    await handleMetricsSweep({ db: getPrisma() });
  });

  // Every 15 minutes. The checkpoints are hours apart, so the tick only has to be small
  // relative to the tightest of them — the 1h reading — for a snapshot to land close to
  // the hour it claims. Finer would poll platform APIs harder for a reading whose
  // `hoursSincePublish` would barely move; hourly would make the 1h checkpoint land
  // anywhere in a two-hour band, and comparing a 1h reading with a 2h one as though both
  // were "hour one" is exactly the error that survives review.
  await instance.schedule(QUEUE.metricsPoll, '*/15 * * * *');

  log.info({ queues: Object.values(QUEUE) }, 'Worker started');
}

export async function stopWorker(): Promise<void> {
  if (!boss) return;
  const current = boss;
  boss = null;
  // Graceful: let an in-flight publish finish rather than killing it between the platform
  // accepting the post and us recording `externalPostId` — precisely the window that
  // produces a duplicate on the next attempt.
  await current.stop({ graceful: true });
  getLogger().info('Worker stopped');
}

export function isWorkerRunning(): boolean {
  return boss !== null;
}
