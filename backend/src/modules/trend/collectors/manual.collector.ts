import { Platform, TrendKind } from '@prisma/client';
import { z } from 'zod';
import type { Db } from '../../../platform/db';
import { getLogger } from '../../../platform/logger';
import { NotFoundError } from '../../../platform/errors';
import {
  appendSignal,
  getTrend,
  resolveOrCreateTrend,
  type TrendWithRelations,
} from '../trend.repository';
import { TrendSignalMetricsSchema } from '../trend.schemas';
import type { CollectedObservation, CollectorRunInput, TrendCollector } from './types';

/**
 * Manual curation.
 *
 * **This is not a placeholder.** docs/07 and the W9 brief are both emphatic, and they are
 * right: a weekly pass by someone who understands small-business marketing outperforms a
 * naive automated feed for months. It is also the only way to have signals to score while
 * the automated collectors mature, and it produces the labelled data that makes category
 * mapping tunable. The admin UI on top of this is built as a tool someone uses every week,
 * not a debug form.
 *
 * Unlike an API collector this one has no schedule of its own — it is driven by a human
 * through the admin API. `collect()` therefore returns nothing rather than pretending to
 * poll; `record()` is the real entry point.
 */
export const MANUAL_COLLECTOR_ID = 'manual';

export const ManualObservationSchema = z
  .object({
    platform: z.nativeEnum(Platform).nullable().default(null),
    kind: z.nativeEnum(TrendKind),
    externalRef: z.string().min(1).max(200).nullable().default(null),
    title: z.string().min(3).max(200),
    description: z.string().max(2000).nullable().optional(),
    /**
     * References, not content. docs/07: store derived signals and links, never copies of
     * other people's posts — that is both the ToS position and the only thing the scorer
     * can actually use.
     */
    exampleUrls: z.array(z.string().url()).max(10).default([]),
    observedAt: z.coerce.date(),
    metrics: TrendSignalMetricsSchema,
    /** Who curated this observation. Internal audit trail, not shown to end users. */
    curatedBy: z.string().min(1).max(200),
    sourceNote: z.string().max(500).optional(),
  })
  .strict();

export type ManualObservation = z.infer<typeof ManualObservationSchema>;

/**
 * Records one curated observation: resolve or create the trend, then append a signal.
 *
 * Append, never overwrite. Curating the same trend a week later must add a second point,
 * because two points are what make a velocity — a curator who "updates" a trend's number
 * in place has thrown away the only thing the engine needed.
 */
export async function recordManualObservation(
  db: Db,
  input: ManualObservation,
): Promise<TrendWithRelations> {
  const logger = getLogger().child({ component: 'trend.collector.manual' });

  const trend = await resolveOrCreateTrend(db, {
    platform: input.platform,
    kind: input.kind,
    externalRef: input.externalRef,
    title: input.title,
    description: input.description ?? null,
    exampleUrls: input.exampleUrls,
    raw: {
      collectorId: MANUAL_COLLECTOR_ID,
      fetchedAt: input.observedAt.toISOString(),
      ...(input.sourceNote ? { sourceNote: input.sourceNote } : {}),
    },
  });

  await appendSignal(db, {
    trendId: trend.id,
    collectorId: MANUAL_COLLECTOR_ID,
    observedAt: input.observedAt,
    metrics: { ...input.metrics, curatedBy: input.curatedBy },
  });

  logger.info({ trendId: trend.id, kind: input.kind }, 'recorded manual trend observation');

  const withRelations = await getTrend(db, trend.id);
  if (!withRelations) throw new NotFoundError('Trend');
  return withRelations;
}

export const manualCollector: TrendCollector = {
  id: MANUAL_COLLECTOR_ID,
  label: 'Manual curation',

  // Needs no credentials and no platform app at all, which is exactly why docs/07 has it
  // carrying the feed while the API-backed collectors wait on approval.
  isConfigured: () => true,

  // Human-driven, so there is nothing to poll. Returning an empty array rather than
  // throwing keeps it a well-behaved member of the collector registry.
  collect: (_input: CollectorRunInput): Promise<CollectedObservation[]> => Promise.resolve([]),
};
