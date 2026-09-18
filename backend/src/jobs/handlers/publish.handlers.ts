import type { Db } from '../../platform/db';
import { getLogger } from '../../platform/logger';
import type { AdapterRegistry } from '../../modules/publish/adapter.registry';
import { publishTarget } from '../../modules/publish/publish.service';
import { findDueTargets } from '../../modules/publish/schedule.service';
import { PublishTargetPayloadSchema } from '../queues';

/**
 * Job handlers.
 *
 * Plain functions taking their dependencies as arguments, deliberately not reaching for
 * module singletons. That is what lets the pipeline be tested end to end against a real
 * database and a fake adapter without booting pg-boss — the queue is a delivery
 * mechanism, and needing it running to test publishing would make the most important
 * tests in this workstream the slowest and flakiest.
 *
 * A handler contains no business logic. It validates its payload, calls a service, and
 * translates the result into "done" or "throw so pg-boss retries".
 */

export interface HandlerDeps {
  db: Db;
  registry?: AdapterRegistry;
  /** Enqueue a follow-up job. Injected so the sweep can be tested without a queue. */
  enqueuePublish: (targetId: string) => Promise<void>;
}

export async function handlePublishTarget(deps: HandlerDeps, rawPayload: unknown): Promise<void> {
  const payload = PublishTargetPayloadSchema.parse(rawPayload);
  const log = getLogger();

  const outcome = await publishTarget(deps.db, {
    targetId: payload.targetId,
    actor: 'job:publish.target',
    registry: deps.registry,
  });

  switch (outcome.kind) {
    case 'published':
      log.info({ targetId: payload.targetId, metered: outcome.metered }, 'Published target');
      return;
    case 'already-published':
      // At-least-once delivery doing exactly what it says. Not a warning.
      log.info({ targetId: payload.targetId }, 'Target already published; skipping');
      return;
    case 'blocked':
      log.warn({ targetId: payload.targetId, reason: outcome.reason }, 'Target blocked');
      return;
    case 'failed':
      log.warn(
        { targetId: payload.targetId, errorClass: outcome.error.errorClass },
        'Target failed permanently',
      );
      return;
    case 'retry':
      // Returning rather than throwing. The retry is already recorded on the row with its
      // own `nextAttemptAt`, and the sweep owns re-delivery; throwing as well would give
      // the target two independent retry schedules — pg-boss's and ours — racing each
      // other, which is how a backoff quietly becomes no backoff.
      log.info(
        { targetId: payload.targetId, nextAttemptAt: outcome.nextAttemptAt },
        'Target will be retried',
      );
      return;
  }
}

/**
 * Find due targets and enqueue one job each.
 *
 * Runs on a cron. It is the recovery path for anything the queue lost, which is why it
 * queries rows rather than trusting that every scheduled target has a live job.
 */
export async function handlePublishSweep(
  deps: HandlerDeps,
  now: Date = new Date(),
): Promise<number> {
  const due = await findDueTargets(deps.db, now);

  for (const target of due) {
    await deps.enqueuePublish(target.id);
  }

  if (due.length > 0) {
    getLogger().info({ count: due.length }, 'Publish sweep enqueued due targets');
  }
  return due.length;
}
