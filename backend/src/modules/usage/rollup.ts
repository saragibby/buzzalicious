import { Prisma, UsageMetric } from '@prisma/client';
import type { Db } from '../../platform/db';
import { periodEndFor, periodStartFor } from './period';
import { applyRollupDelta } from './usage.service';

/**
 * Rebuilding a period's rollup from the raw ledger.
 *
 * `UsagePeriodRollup` is derived. It exists so a cap check is one indexed read instead of
 * an aggregate over the whole ledger, and for no other reason — the events are the source
 * of truth. ADR-0011 therefore requires "rebuild from events equals incremental totals" to
 * be a test rather than a convention, because a rollup that has drifted from the events
 * under it is a billing error that nothing else in the system would notice.
 *
 * This is also the repair tool. If a rollup is ever wrong — a bad deploy, a manual write, a
 * bug in a future emit path — this recomputes it. It never touches `UsageEvent`.
 */

export interface RebuiltRollup {
  metric: UsageMetric;
  quantity: bigint;
  providerCostUsd: Prisma.Decimal;
  eventCount: number;
}

/**
 * Recompute every metric's rollup for one workspace and period from the events.
 *
 * A rollup row whose metric has no events in the period is zeroed rather than deleted: a
 * row that exists with a wrong total is the failure mode worth closing, and zeroing leaves
 * the evidence that it was rebuilt.
 */
export async function rebuildWorkspacePeriod(
  db: Db,
  workspaceId: string,
  instantInPeriod: Date,
): Promise<RebuiltRollup[]> {
  const periodStart = periodStartFor(instantInPeriod);
  const periodEnd = periodEndFor(instantInPeriod);

  const grouped = await db.usageEvent.groupBy({
    by: ['metric'],
    where: { workspaceId, periodStart },
    _sum: { quantity: true, providerCostUsd: true },
    _count: { _all: true },
  });

  const rebuilt: RebuiltRollup[] = grouped.map((row) => ({
    metric: row.metric,
    quantity: BigInt(row._sum.quantity ?? 0),
    providerCostUsd: row._sum.providerCostUsd ?? new Prisma.Decimal(0),
    eventCount: row._count._all,
  }));

  const seen = new Set(rebuilt.map((row) => row.metric));

  await db.$transaction(async (tx) => {
    for (const row of rebuilt) {
      await tx.usagePeriodRollup.upsert({
        where: {
          workspaceId_metric_periodStart: { workspaceId, metric: row.metric, periodStart },
        },
        create: {
          workspaceId,
          metric: row.metric,
          periodStart,
          periodEnd,
          quantity: row.quantity,
          providerCostUsd: row.providerCostUsd,
          eventCount: row.eventCount,
        },
        // Absolute values, not a delta: this is a recomputation, so whatever was there is
        // replaced outright. An increment here would preserve the drift being repaired.
        update: {
          periodEnd,
          quantity: row.quantity,
          providerCostUsd: row.providerCostUsd,
          eventCount: row.eventCount,
        },
      });
    }

    const orphaned = await tx.usagePeriodRollup.findMany({
      where: { workspaceId, periodStart, metric: { notIn: [...seen] } },
      select: { id: true },
    });

    if (orphaned.length > 0) {
      await tx.usagePeriodRollup.updateMany({
        where: { id: { in: orphaned.map((row) => row.id) } },
        data: { quantity: 0n, providerCostUsd: new Prisma.Decimal(0), eventCount: 0 },
      });
    }
  });

  return rebuilt;
}

/**
 * Rebuild every (workspace, period) pair that has events.
 *
 * Used by the admin repair path and by the seed, which writes history through the emit API
 * and then rebuilds as a self-check: if the two ever disagree, the seed fails loudly rather
 * than producing a development database that quietly lies about spend.
 */
export async function rebuildAllPeriods(db: Db): Promise<number> {
  const pairs = await db.usageEvent.groupBy({
    by: ['workspaceId', 'periodStart'],
  });

  for (const pair of pairs) {
    await rebuildWorkspacePeriod(db, pair.workspaceId, pair.periodStart);
  }

  return pairs.length;
}

/**
 * Read a period's rollups straight from the ledger without writing anything.
 *
 * The comparison half of the acceptance criterion, and the honest way to check a rollup in
 * production: answering "does the counter still match the events?" must not be able to fix
 * the answer as a side effect.
 */
export async function computePeriodFromEvents(
  db: Db,
  workspaceId: string,
  instantInPeriod: Date,
): Promise<RebuiltRollup[]> {
  const periodStart = periodStartFor(instantInPeriod);

  const grouped = await db.usageEvent.groupBy({
    by: ['metric'],
    where: { workspaceId, periodStart },
    _sum: { quantity: true, providerCostUsd: true },
    _count: { _all: true },
  });

  return grouped.map((row) => ({
    metric: row.metric,
    quantity: BigInt(row._sum.quantity ?? 0),
    providerCostUsd: row._sum.providerCostUsd ?? new Prisma.Decimal(0),
    eventCount: row._count._all,
  }));
}

export { applyRollupDelta };
