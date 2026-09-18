import { Prisma } from '@prisma/client';
import { AppError } from '../../platform/errors';

/**
 * The fuse blowing.
 *
 * **402, and its own error code.** ADR-0011 is explicit that exhaustion must be
 * distinguishable from failure "in logs, in the API response, and in the admin view" — a
 * cap that engages invisibly is worse than no cap, because the symptom gets debugged for a
 * week. Reusing `RATE_LIMITED` would make a spend ceiling look like a burst limit, and
 * "wait and retry" is exactly the wrong advice: nothing changes until the period rolls
 * over or someone raises the ceiling.
 *
 * Exposed to the client on purpose. The numbers are the workspace's own spend against its
 * own ceiling — no other tenant's data is in it, and hiding it would leave the UI with
 * nothing useful to say.
 */
export class BudgetExceededError extends AppError {
  readonly code = 'BUDGET_EXCEEDED' as const;
  readonly status = 402;

  constructor(
    readonly workspaceId: string,
    readonly spentUsd: Prisma.Decimal,
    readonly ceilingUsd: Prisma.Decimal,
    readonly periodStart: Date,
  ) {
    super(
      `AI generation is paused for this workspace: $${spentUsd.toFixed(2)} of the ` +
        `$${ceilingUsd.toFixed(2)} monthly AI budget has been used. Already-scheduled ` +
        `posts will still publish.`,
      {
        details: {
          spentUsd: spentUsd.toFixed(6),
          ceilingUsd: ceilingUsd.toFixed(2),
          periodStart: periodStart.toISOString(),
        },
      },
    );
  }
}

export function isBudgetExceededError(error: unknown): error is BudgetExceededError {
  return error instanceof BudgetExceededError;
}

/**
 * The reserved `platform` workspace is not in the database.
 *
 * A deployment fault, not a client fault: the row is created by migration
 * `0002_usage_metering`, so this means migrations have not been run. `expose: false` and a
 * 500 because the message names internal machinery, and there is nothing the caller can do
 * about it — but it is an `AppError` rather than a bare `Error` so the error handler logs
 * it with the same structure as everything else.
 */
export class PlatformWorkspaceMissingError extends AppError {
  readonly code = 'INTERNAL_ERROR' as const;
  readonly status = 500;
  readonly expose = false;
}
