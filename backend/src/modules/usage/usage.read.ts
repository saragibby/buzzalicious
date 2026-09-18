import { Prisma, UsageMetric } from '@prisma/client';
import { getConfig } from '../../platform/config';
import type { Db } from '../../platform/db';
import { AI_METRICS } from './budget';
import { periodEndFor, periodStartFor } from './period';
import { PLATFORM_WORKSPACE_SLUG } from './platform-workspace';

/**
 * Reads over the meter.
 *
 * Read-only by construction — nothing here writes, and the admin view is a window on the
 * rollup rather than a console. The brief is explicit that this is "a read-only admin
 * view, not a billing UI"; the moment it can adjust a ceiling or void an event it needs an
 * audit trail, and that is a decision for whoever answers Q13.
 *
 * Every number comes from `UsagePeriodRollup`, never from an aggregate over the ledger.
 * That is the rollup's whole job, and reading the ledger here would make the admin page
 * slower every month it is used.
 */

export interface UsageMetricTotal {
  metric: UsageMetric;
  quantity: number;
  providerCostUsd: string;
  eventCount: number;
}

export interface WorkspaceUsageSummary {
  workspaceId: string;
  workspaceName: string;
  workspaceSlug: string;
  /** True for the reserved workspace that carries platform-global AI work. */
  isPlatformWorkspace: boolean;
  periodStart: string;
  periodEnd: string;
  metrics: UsageMetricTotal[];
  aiSpendUsd: string;
  aiCeilingUsd: string;
  /** Present and true when this is the workspace that has run out. */
  exhausted: boolean;
  /** 0..1+, for a bar. Clamped nowhere: over-ceiling should look over-ceiling. */
  aiUtilization: number;
}

export interface UsagePeriodSummary {
  periodStart: string;
  periodEnd: string;
  workspaces: WorkspaceUsageSummary[];
  totals: UsageMetricTotal[];
}

/**
 * `quantity` is a `BigInt` in the database and a `bigint` in the client.
 *
 * It does not survive `JSON.stringify`, which throws rather than degrading — so it is
 * converted exactly once, here, at the boundary. `Number` is safe for a token count:
 * `Number.MAX_SAFE_INTEGER` tokens is several thousand times the annual output of every
 * model in the table. Money is never converted this way; it stays a decimal string.
 */
function quantityToNumber(quantity: bigint): number {
  return Number(quantity);
}

function sumMetrics(rows: UsageMetricTotal[]): UsageMetricTotal[] {
  const byMetric = new Map<UsageMetric, UsageMetricTotal>();

  for (const row of rows) {
    const existing = byMetric.get(row.metric);
    if (!existing) {
      byMetric.set(row.metric, { ...row });
      continue;
    }
    existing.quantity += row.quantity;
    existing.eventCount += row.eventCount;
    existing.providerCostUsd = new Prisma.Decimal(existing.providerCostUsd)
      .plus(row.providerCostUsd)
      .toFixed(6);
  }

  return [...byMetric.values()].sort((a, b) => a.metric.localeCompare(b.metric));
}

/**
 * Platform-wide usage for one period, one workspace per row.
 *
 * Cross-tenant by design, which is why it takes the unscoped `Db` and why its only caller
 * is behind `assertPlatformAdmin`. A scoped client cannot answer this question, and
 * shouldn't be able to.
 */
export async function getUsagePeriodSummary(
  db: Db,
  reference: Date = new Date(),
): Promise<UsagePeriodSummary> {
  const periodStart = periodStartFor(reference);
  const periodEnd = periodEndFor(reference);
  const defaultCeiling = new Prisma.Decimal(getConfig().ai.monthlyCeilingUsd);

  const [rollups, workspaces] = await Promise.all([
    db.usagePeriodRollup.findMany({
      where: { periodStart },
      select: {
        workspaceId: true,
        metric: true,
        quantity: true,
        providerCostUsd: true,
        eventCount: true,
      },
    }),
    db.workspace.findMany({
      select: { id: true, name: true, slug: true, aiMonthlyCeilingUsd: true },
      orderBy: { name: 'asc' },
    }),
  ]);

  const byWorkspace = new Map<string, UsageMetricTotal[]>();
  for (const row of rollups) {
    const list = byWorkspace.get(row.workspaceId) ?? [];
    list.push({
      metric: row.metric,
      quantity: quantityToNumber(row.quantity),
      providerCostUsd: row.providerCostUsd.toFixed(6),
      eventCount: row.eventCount,
    });
    byWorkspace.set(row.workspaceId, list);
  }

  const summaries = workspaces
    .map((workspace): WorkspaceUsageSummary => {
      const metrics = sumMetrics(byWorkspace.get(workspace.id) ?? []);
      const aiSpend = metrics
        .filter((m) => AI_METRICS.includes(m.metric))
        .reduce((total, m) => total.plus(m.providerCostUsd), new Prisma.Decimal(0));
      const ceiling = workspace.aiMonthlyCeilingUsd ?? defaultCeiling;

      return {
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        workspaceSlug: workspace.slug,
        isPlatformWorkspace: workspace.slug === PLATFORM_WORKSPACE_SLUG,
        periodStart: periodStart.toISOString(),
        periodEnd: periodEnd.toISOString(),
        metrics,
        aiSpendUsd: aiSpend.toFixed(6),
        aiCeilingUsd: ceiling.toFixed(2),
        exhausted: aiSpend.greaterThanOrEqualTo(ceiling),
        aiUtilization: ceiling.isZero() ? 1 : aiSpend.dividedBy(ceiling).toNumber(),
      };
    })
    // Exhausted first, then by spend. The admin view exists to answer "who ran out", and
    // burying that under alphabetical order makes the reader do the scanning.
    .sort((a, b) => {
      if (a.exhausted !== b.exhausted) return a.exhausted ? -1 : 1;
      return b.aiUtilization - a.aiUtilization;
    });

  return {
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    workspaces: summaries,
    totals: sumMetrics(summaries.flatMap((w) => w.metrics)),
  };
}

/** One workspace's current-period usage, for its own members. */
export async function getWorkspaceUsage(
  db: Db,
  workspaceId: string,
  reference: Date = new Date(),
): Promise<Omit<WorkspaceUsageSummary, 'workspaceName' | 'workspaceSlug' | 'isPlatformWorkspace'>> {
  const periodStart = periodStartFor(reference);
  const periodEnd = periodEndFor(reference);

  const [rollups, workspace] = await Promise.all([
    db.usagePeriodRollup.findMany({
      where: { workspaceId, periodStart },
      select: { metric: true, quantity: true, providerCostUsd: true, eventCount: true },
    }),
    db.workspace.findUnique({ where: { id: workspaceId }, select: { aiMonthlyCeilingUsd: true } }),
  ]);

  const metrics = sumMetrics(
    rollups.map((row) => ({
      metric: row.metric,
      quantity: quantityToNumber(row.quantity),
      providerCostUsd: row.providerCostUsd.toFixed(6),
      eventCount: row.eventCount,
    })),
  );

  const aiSpend = metrics
    .filter((m) => AI_METRICS.includes(m.metric))
    .reduce((total, m) => total.plus(m.providerCostUsd), new Prisma.Decimal(0));
  const ceiling =
    workspace?.aiMonthlyCeilingUsd ?? new Prisma.Decimal(getConfig().ai.monthlyCeilingUsd);

  return {
    workspaceId,
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    metrics,
    aiSpendUsd: aiSpend.toFixed(6),
    aiCeilingUsd: ceiling.toFixed(2),
    exhausted: aiSpend.greaterThanOrEqualTo(ceiling),
    aiUtilization: ceiling.isZero() ? 1 : aiSpend.dividedBy(ceiling).toNumber(),
  };
}
