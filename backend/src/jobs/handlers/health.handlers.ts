import { getLogger } from '../../platform/logger';
import type { Db } from '../../platform/db';
import {
  createSystemAccountReader,
  runHealthSweep,
  type HealthSweepResult,
} from '../../modules/publish/health.service';

/**
 * The cron that actually drives `refresh` and `validate`.
 *
 * PR 1 shipped the contract — `AccountStatus`, the `REVOKED` → publish-`BLOCKED` path —
 * and tested it, but nothing ever *called* refresh. That is a failure mode that looks
 * healthy right up until it isn't: a long-lived Meta page token is good for about sixty
 * days, so an unrefreshed install works perfectly for two months and then every brand
 * stops publishing on the same morning, with no deploy to correlate it against.
 *
 * ## Why this is a separate queue from `publish.target`
 *
 * A health sweep touches every workspace. The publish queue is per target and its retries
 * are tuned for a single post. Sharing a queue would mean one slow platform's refresh
 * delaying real posts behind it.
 *
 * ## Why failures here are swallowed per account
 *
 * `runHealthSweep` catches per account, so one platform being down does not abandon the
 * rest of the sweep. The handler only has to survive the sweep itself throwing, which
 * means a programming error rather than a platform error. It logs and rethrows so pg-boss
 * records the failure; retrying a whole sweep is harmless because every write it makes is
 * idempotent (status and timestamps, never an increment).
 */

export interface HealthHandlerDeps {
  readonly db: Db;
}

export async function handleAccountHealthSweep(
  deps: HealthHandlerDeps,
): Promise<HealthSweepResult> {
  const log = getLogger();
  const result = await runHealthSweep({
    db: deps.db,
    reader: createSystemAccountReader(deps.db),
  });

  // Logged at info unconditionally rather than only when something changed: "the sweep ran
  // and found nothing due" and "the sweep has not run since Tuesday" are the two states
  // this job exists to distinguish, and silence cannot tell them apart.
  log.info(
    {
      checked: result.checked,
      refreshed: result.refreshed,
      revoked: result.revoked,
      failed: result.failed,
    },
    'Account health sweep complete',
  );

  return result;
}
