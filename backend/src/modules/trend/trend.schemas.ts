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

/**
 * Reads the comparable volume out of one observation.
 *
 * `TrendSignal.metrics` is a contract column, not a verbatim payload — `schema.prisma`
 * points it at `TrendSignalMetricsSchema`, which names this field `volume`. Provenance
 * lives in `Trend.raw`, which is where docs/07's "the raw payload must survive" applies.
 * So a collector with its own vocabulary normalizes on the way into `metrics` and keeps
 * its original payload in `raw`; this reader knows one name, and `metrics` keeps meaning
 * one thing.
 *
 * Returns `null`, never 0, when an observation carries no volume at all. A collector that
 * reports engagement but not volume has not observed a volume of zero, and treating it as
 * one would invent a cliff in the velocity series.
 */
export function volumeOf(metrics: unknown): number | null {
  return finiteNonNegative(metrics, 'volume');
}

/** Same contract, same treatment. See `volumeOf`. */
export function engagementOf(metrics: unknown): number | null {
  return finiteNonNegative(metrics, 'engagement');
}

function finiteNonNegative(metrics: unknown, key: string): number | null {
  if (typeof metrics !== 'object' || metrics === null) return null;
  const value = (metrics as Record<string, unknown>)[key];
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  return null;
}

// ─── Curation and category mapping (W9) ──────────────────────────────────────────
//
// Both of these live inside `Trend.raw` under reserved keys rather than in columns of
// their own. `schema.prisma` is owned by W2 and is not editable from this workstream, and
// `TrendRawSchema` is `.passthrough()` by design, so namespacing is the available move.
//
// It is a compromise, not a preference: `raw` means "what the collector observed", and
// curation output plus mapping provenance are neither. The follow-up recorded for W2 is a
// `Trend.curation Json?` column and `confidence` / `method` / `reviewStatus` on
// `TrendCategoryScore`. Everything here reads and writes through the helpers below, so
// that migration touches this file and nothing else.

export const SUGGESTED_ANGLE_MAX = 400;

/**
 * A concrete thing a business in this category could actually post this week.
 *
 * This is the acceptance criterion the brief singles out: a trend without a usable idea
 * attached is just noise. So `angle` is prose a person could act on, not a label — the
 * minimum length is there to stop "post about pumpkin spice" passing for an angle.
 */
export const SuggestedAngleSchema = z
  .object({
    categorySlug: z.string().min(1),
    angle: z.string().min(20).max(SUGGESTED_ANGLE_MAX),
    /** Optional first line of copy. The angle is the idea; this is the execution. */
    hook: z.string().max(200).optional(),
  })
  .strict();

export type SuggestedAngle = z.infer<typeof SuggestedAngleSchema>;

export const TrendCurationSchema = z
  .object({
    /** Who curated it. An email or a handle — this is an internal audit trail. */
    curatedBy: z.string().min(1).optional(),
    curatedAt: z.string().datetime().optional(),
    /** Why this is worth a small business's week. Shown to curators, not to end users. */
    rationale: z.string().max(1000).optional(),
    angles: z.array(SuggestedAngleSchema).default([]),
    /** Falls back to `angles` when a brand's category has no specific one. */
    defaultAngle: z.string().min(20).max(SUGGESTED_ANGLE_MAX).optional(),
  })
  .strict();

export type TrendCuration = z.infer<typeof TrendCurationSchema>;

export const MAPPING_METHODS = ['rules', 'llm', 'manual'] as const;
export type MappingMethod = (typeof MAPPING_METHODS)[number];

export const MAPPING_REVIEW_STATUSES = ['OK', 'NEEDS_REVIEW', 'CONFIRMED', 'REJECTED'] as const;
export type MappingReviewStatus = (typeof MAPPING_REVIEW_STATUSES)[number];

/**
 * How one trend was mapped onto the taxonomy, and how much we trust it.
 *
 * `TrendCategoryScore` stores the score; this stores everything needed to explain or
 * distrust it. `evidence` is not decoration — it is what the feed turns into "why this
 * fits you", and a mapping that cannot say why it matched is one the user has no reason
 * to believe.
 */
export const TrendCategoryMappingSchema = z
  .object({
    method: z.enum(MAPPING_METHODS),
    /** 0..1. Below `NEEDS_REVIEW_BELOW` the mapping is withheld from the feed. */
    confidence: z.number().min(0).max(1),
    reviewStatus: z.enum(MAPPING_REVIEW_STATUSES).default('OK'),
    mappedAt: z.string().datetime(),
    /**
     * Cache key covering the inputs a mapping depends on. Changing a trend's title or
     * bumping the rules version invalidates it; adding a brand does not. This is what
     * makes the cache per trend rather than per brand.
     */
    inputHash: z.string().min(1),
    /** Per category, in the order the feed should cite them. */
    evidence: z
      .array(
        z
          .object({
            categorySlug: z.string().min(1),
            score: z.number().min(0).max(1),
            /** Human-readable: the matched terms, or the model's stated reason. */
            reason: z.string().min(1).max(300),
          })
          .strict(),
      )
      .default([]),
    reviewedBy: z.string().min(1).optional(),
    reviewedAt: z.string().datetime().optional(),
  })
  .strict();

export type TrendCategoryMapping = z.infer<typeof TrendCategoryMappingSchema>;

/** The reserved `Trend.raw` keys. Anything else in `raw` is the collector's. */
export const CURATION_KEY = 'curation';
export const MAPPING_KEY = 'categoryMapping';

export const TrendRawWithW9Schema = TrendRawSchema.extend({
  [CURATION_KEY]: TrendCurationSchema.optional(),
  [MAPPING_KEY]: TrendCategoryMappingSchema.optional(),
});

function rawRecord(raw: unknown): Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

/**
 * Reads a namespaced section out of `Trend.raw`.
 *
 * Returns `undefined` rather than throwing on malformed data. `raw` is permissive by
 * contract and may hold anything a collector wrote, including from a future version of
 * this code — a feed that 500s because one trend has an unexpected shape is a worse
 * outcome than a feed missing one trend.
 */
export function readCuration(raw: unknown): TrendCuration | undefined {
  const parsed = TrendCurationSchema.safeParse(rawRecord(raw)[CURATION_KEY]);
  return parsed.success ? parsed.data : undefined;
}

export function readCategoryMapping(raw: unknown): TrendCategoryMapping | undefined {
  const parsed = TrendCategoryMappingSchema.safeParse(rawRecord(raw)[MAPPING_KEY]);
  return parsed.success ? parsed.data : undefined;
}

/** Merges a section into `raw`, preserving every collector field already there. */
export function writeCuration(raw: unknown, curation: TrendCuration): Record<string, unknown> {
  return { ...rawRecord(raw), [CURATION_KEY]: TrendCurationSchema.parse(curation) };
}

export function writeCategoryMapping(
  raw: unknown,
  mapping: TrendCategoryMapping,
): Record<string, unknown> {
  return { ...rawRecord(raw), [MAPPING_KEY]: TrendCategoryMappingSchema.parse(mapping) };
}
