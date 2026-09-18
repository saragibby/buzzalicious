import { z } from 'zod';

/**
 * JSON column contracts for `Trend.raw` and `TrendSignal.metrics`.
 *
 * Raw observations are kept separate from the scored `Trend` so the scoring algorithm can
 * be re-run over history when it changes — essential while the engine is being tuned
 * (docs/07). That only works if the raw payload is preserved faithfully, so `TrendRawSchema`
 * is permissive by design: it records where the observation came from without asserting
 * what a third-party API is allowed to return.
 */

export const TrendRawSchema = z
  .object({
    /** Which collector produced this, e.g. "meta-hashtag", "x-search", "manual". */
    collectorId: z.string().min(1).optional(),
    fetchedAt: z.string().datetime().optional(),
    sourceUrl: z.string().url().optional(),
  })
  .passthrough();

export type TrendRaw = z.infer<typeof TrendRawSchema>;

/**
 * One observation's measurements. Every field is optional because no two sources expose
 * the same ones — X gives post counts, Meta gives hashtag volume — and a collector that
 * has to invent a zero to satisfy a schema has corrupted the signal before it is stored.
 */
export const TrendSignalMetricsSchema = z
  .object({
    volume: z.number().nonnegative().optional(),
    engagement: z.number().nonnegative().optional(),
    postCount: z.number().int().nonnegative().optional(),
    uniqueAuthors: z.number().int().nonnegative().optional(),
    /** Change since the previous observation from the same collector, if known. */
    deltaVolume: z.number().optional(),
    /** 0..1 confidence the collector attaches to this observation. */
    confidence: z.number().min(0).max(1).optional(),
    sampleWindowHours: z.number().positive().optional(),
  })
  .passthrough();

export type TrendSignalMetrics = z.infer<typeof TrendSignalMetricsSchema>;
