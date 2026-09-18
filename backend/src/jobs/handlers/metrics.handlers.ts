import { getLogger } from '../../platform/logger';
import type { Db } from '../../platform/db';
import { captureSnapshot, findDueSnapshots } from '../../modules/insight/metrics.service';
import type { AdapterRegistry } from '../../modules/publish/adapter.registry';

/**
 * The cron that actually reads metrics back from the platforms.
 *
 * ## Why a sweep rather than a job per checkpoint scheduled at publish time
 *
 * Scheduling six delayed jobs when a post publishes would work until the worker missed
 * one — and pg-boss retention is finite, so a job whose run time passed while the dyno
 * was down is simply gone. The reading would never happen and the gap would be
 * indistinguishable from a post that earned nothing overnight, which is a false zero the
 * recommender cannot detect.
 *
 * A sweep recomputes what is owed from `publishedAt` and the snapshots that exist, so an
 * outage delays a reading rather than losing it. The cost is a query per tick; the
 * benefit is that the schedule is derived from durable state rather than from jobs that
 * had to survive.
 *
 * ## Why failures do not fail the sweep
 *
 * One platform being down, or one account's token being revoked, must not abandon the
 * other targets — and neither is a reason to write a snapshot. `captureSnapshot` returns
 * an outcome rather than throwing for those cases, so the sweep records the shape of what
 * happened and moves on. The checkpoint stays due and is retried on the next tick.
 */

export interface MetricsSweepResult {
  captured: number;
  duplicate: number;
  unavailable: number;
  failed: number;
}

export async function handleMetricsSweep(deps: {
  db: Db;
  now?: Date;
  limit?: number;
  registry?: AdapterRegistry;
}): Promise<MetricsSweepResult> {
  const log = getLogger();
  const result: MetricsSweepResult = { captured: 0, duplicate: 0, unavailable: 0, failed: 0 };

  const due = await findDueSnapshots(deps.db, { now: deps.now, limit: deps.limit });
  if (due.length === 0) return result;

  for (const checkpoint of due) {
    try {
      const outcome = await captureSnapshot(deps.db, checkpoint.targetId, checkpoint, {
        now: deps.now,
        registry: deps.registry,
      });
      result[outcome.kind] += 1;
    } catch (error) {
      // An unclassified throw is a programming error rather than a platform one. Log it
      // against the target and keep sweeping: abandoning the remaining checkpoints would
      // turn one bad row into a gap across every post published that hour.
      log.error({ err: error, targetId: checkpoint.targetId }, 'Metric snapshot threw');
      result.failed += 1;
    }
  }

  log.info(result, 'Metrics sweep complete');
  return result;
}
