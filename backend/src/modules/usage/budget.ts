import { Prisma, UsageMetric } from '@prisma/client';
import { getConfig } from '../../platform/config';
import { getLogger } from '../../platform/logger';
import { periodStartFor } from './period';
import { BudgetExceededError } from './usage.errors';

/**
 * The fuse.
 *
 * Deliberately crude enforcement over billing-grade data (ADR-0011). A per-workspace
 * monthly AI *cost* ceiling, checked against the rollup before a call and updated from
 * actuals after it. Not an accounting system: there is no proration, no overage, no
 * credit, and no plan, because all of those need Q13 and none of them are needed to stop a
 * runaway loop.
 *
 * Two boundaries matter more than the arithmetic:
 *
 *  - **The cap governs generation, not delivery.** Nothing in the publish path calls this.
 *    A post that is already scheduled goes out even when its workspace is exhausted.
 *  - **A single call may overshoot.** `maxTokens` bounds the overshoot to a rounding error
 *    against a monthly ceiling, and pre-flight token estimation is not reliable enough to
 *    be worth the complexity it would add to every call site.
 */

/** Metrics that count against the AI ceiling. A new AI metric is added here, once. */
export const AI_METRICS: readonly UsageMetric[] = [UsageMetric.AI_TOKENS];

/**
 * The minimum a client must offer to answer "can this workspace spend?".
 *
 * Structural for the same reason as `UsageWriter`: the two live AI call sites hold
 * different clients — `voice.service` has a `ScopedDb`, `mapping.service` has the unscoped
 * `Db` because trends are platform-global — and neither should have to convert one into
 * the other just to be metered.
 */
export interface BudgetReader {
  workspace: {
    findUnique(args: {
      where: { id: string };
      select: { aiMonthlyCeilingUsd: true };
    }): Promise<{ aiMonthlyCeilingUsd: Prisma.Decimal | null } | null>;
  };
  usagePeriodRollup: {
    findMany(args: {
      where: { workspaceId: string; periodStart: Date; metric: { in: UsageMetric[] } };
      select: { providerCostUsd: true };
    }): Promise<{ providerCostUsd: Prisma.Decimal }[]>;
  };
}

export interface AiBudgetStatus {
  workspaceId: string;
  periodStart: Date;
  spentUsd: Prisma.Decimal;
  ceilingUsd: Prisma.Decimal;
  /** Never negative: "how much is left" reads badly as a negative number in a UI. */
  remainingUsd: Prisma.Decimal;
  exhausted: boolean;
}

/**
 * The ceiling in force for a workspace.
 *
 * A null column means "use the configured platform default", **not** "unlimited". An unset
 * column must not be how a workspace escapes the fuse — that is the kind of default that
 * is discovered from an invoice.
 */
export async function resolveAiCeilingUsd(
  db: BudgetReader,
  workspaceId: string,
): Promise<Prisma.Decimal> {
  const workspace = await db.workspace.findUnique({
    where: { id: workspaceId },
    select: { aiMonthlyCeilingUsd: true },
  });

  return workspace?.aiMonthlyCeilingUsd ?? new Prisma.Decimal(getConfig().ai.monthlyCeilingUsd);
}

/**
 * Current-period AI spend and ceiling for a workspace.
 *
 * One indexed read over the rollup, which is the entire reason the rollup exists — the
 * alternative is aggregating the ledger on the hot path of every AI call.
 */
export async function getAiBudgetStatus(
  db: BudgetReader,
  workspaceId: string,
  now: Date = new Date(),
): Promise<AiBudgetStatus> {
  const periodStart = periodStartFor(now);

  const [rollups, ceilingUsd] = await Promise.all([
    db.usagePeriodRollup.findMany({
      where: { workspaceId, periodStart, metric: { in: [...AI_METRICS] } },
      select: { providerCostUsd: true },
    }),
    resolveAiCeilingUsd(db, workspaceId),
  ]);

  const spentUsd = rollups.reduce(
    (total, row) => total.plus(row.providerCostUsd),
    new Prisma.Decimal(0),
  );

  const remaining = ceilingUsd.minus(spentUsd);

  return {
    workspaceId,
    periodStart,
    spentUsd,
    ceilingUsd,
    remainingUsd: remaining.isNegative() ? new Prisma.Decimal(0) : remaining,
    exhausted: spentUsd.greaterThanOrEqualTo(ceilingUsd),
  };
}

/**
 * Refuse a generation when the workspace has spent its month.
 *
 * Logged at `warn` with an explicit `budgetExceeded` marker before throwing, because the
 * one thing ADR-0011 insists on is that exhaustion is distinguishable from failure. An
 * engaged cap that looks like a flaky provider costs a week of debugging the wrong thing.
 */
export async function assertAiBudgetAvailable(
  db: BudgetReader,
  workspaceId: string,
  now: Date = new Date(),
): Promise<AiBudgetStatus> {
  const status = await getAiBudgetStatus(db, workspaceId, now);

  if (status.exhausted) {
    getLogger()
      .child({ component: 'usage.budget' })
      .warn(
        {
          budgetExceeded: true,
          workspaceId,
          spentUsd: status.spentUsd.toFixed(6),
          ceilingUsd: status.ceilingUsd.toFixed(2),
          periodStart: status.periodStart.toISOString(),
        },
        'AI generation refused: workspace is over its monthly AI cost ceiling',
      );

    throw new BudgetExceededError(
      workspaceId,
      status.spentUsd,
      status.ceilingUsd,
      status.periodStart,
    );
  }

  return status;
}
