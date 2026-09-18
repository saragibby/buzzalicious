import type { Db } from '../../platform/db';
import { getLogger } from '../../platform/logger';
import { listTrendsForScoring, writeScore, type TrendWithRelations } from './trend.repository';
import { scoreTrend, type TrendScore } from './scoring';

/**
 * Applies the scoring engine to stored trends.
 *
 * The split is the point: `scoring.ts` is pure and knows nothing about Postgres, this file
 * knows nothing about velocity. That is what makes "re-run scoring over history" a real
 * capability rather than an aspiration — the algorithm can be replaced wholesale and
 * replayed against untouched signal history, because signals are append-only and `now` is
 * always a parameter.
 */

export interface RescoreResult {
  trendId: string;
  title: string;
  before: { velocity: number | null; momentum: number | null; status: string };
  after: TrendScore;
  changed: boolean;
}

export interface RescoreOptions {
  /**
   * Compute and return the new scores without writing them.
   *
   * The reason to have this at all: tuning the algorithm means wanting to know what a
   * change would do to the feed *before* it does it. Without a dry run the only way to
   * find out is to overwrite every score and look, which is not a step anyone can undo.
   */
  dryRun?: boolean;
}

export async function rescoreAll(
  db: Db,
  now: Date,
  options: RescoreOptions = {},
): Promise<RescoreResult[]> {
  const logger = getLogger().child({ component: 'trend.scoring' });
  const trends = await listTrendsForScoring(db);

  const results: RescoreResult[] = [];

  for (const trend of trends) {
    results.push(await rescoreOne(db, trend, now, options));
  }

  logger.info(
    {
      trends: results.length,
      changed: results.filter((r) => r.changed).length,
      dryRun: options.dryRun === true,
    },
    'rescored trends',
  );

  return results;
}

export async function rescoreOne(
  db: Db,
  trend: TrendWithRelations,
  now: Date,
  options: RescoreOptions = {},
): Promise<RescoreResult> {
  const after = scoreTrend({ firstSeenAt: trend.firstSeenAt, signals: trend.signals }, now);

  const changed =
    trend.status !== after.status ||
    !closeEnough(trend.momentum, after.momentum) ||
    !closeEnough(trend.velocity, after.velocity);

  if (!options.dryRun && changed) {
    await writeScore(db, trend.id, {
      velocity: after.velocity,
      momentum: after.momentum,
      status: after.status,
      peakedAt: after.peakedAt,
    });
  }

  return {
    trendId: trend.id,
    title: trend.title,
    before: { velocity: trend.velocity, momentum: trend.momentum, status: trend.status },
    after,
    changed,
  };
}

/**
 * Floats do not round-trip exactly through Postgres, so an exact comparison would report
 * every trend as changed on every run and make `changed` useless as a signal that the
 * algorithm actually moved something.
 */
function closeEnough(a: number | null, b: number): boolean {
  return a !== null && Math.abs(a - b) < 1e-9;
}
