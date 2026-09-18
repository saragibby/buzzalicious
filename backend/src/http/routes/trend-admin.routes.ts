import { Router } from 'express';
import { z } from 'zod';
import { TrendStatus } from '@prisma/client';
import { getPrisma } from '../../platform/db';
import { NotFoundError, ValidationError } from '../../platform/errors';
import { requireAuth } from '../middleware/require-auth';
import { assertTrendAdmin } from '../../modules/trend/trend.access';
import {
  ManualObservationSchema,
  recordManualObservation,
} from '../../modules/trend/collectors/manual.collector';
import {
  getTrend,
  listTrends,
  mergeRaw,
  updateTrend,
  type TrendWithRelations,
} from '../../modules/trend/trend.repository';
import { rescoreAll, rescoreOne } from '../../modules/trend/scoring.service';
import { loadTaxonomy, mapTrend } from '../../modules/trend/mapping/mapping.service';
import {
  MAPPING_REVIEW_STATUSES,
  SuggestedAngleSchema,
  SUGGESTED_ANGLE_MAX,
  readCategoryMapping,
  readCuration,
  writeCategoryMapping,
  writeCuration,
} from '../../modules/trend/trend.schemas';
import { handle } from './trend.routes';

/**
 * Internal trend curation.
 *
 * The UI on top of this is built as something a person uses every week, not a debug form,
 * because docs/07 is right that a weekly curation pass by someone who understands
 * small-business marketing beats a naive automated feed for months. These endpoints are
 * shaped around that workflow — record an observation, write the angles, clear the review
 * queue — rather than around CRUD on rows.
 *
 * Every route is behind `requireAuth` *and* `TREND_ADMIN_EMAILS`. These write global rows
 * that every workspace reads, so session alone is not sufficient authorization.
 */

const ListQuerySchema = z.object({
  status: z
    .union([z.nativeEnum(TrendStatus), z.array(z.nativeEnum(TrendStatus))])
    .optional()
    .transform((v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v])),
  search: z.string().min(1).max(200).optional(),
  needsReview: z.coerce.boolean().optional(),
  take: z.coerce.number().int().min(1).max(200).default(100),
});

const PatchSchema = z
  .object({
    title: z.string().min(3).max(200).optional(),
    description: z.string().max(2000).nullable().optional(),
    exampleUrls: z.array(z.string().url()).max(10).optional(),
  })
  .strict();

const CurationSchema = z
  .object({
    rationale: z.string().max(1000).optional(),
    angles: z.array(SuggestedAngleSchema).max(30).default([]),
    defaultAngle: z.string().min(20).max(SUGGESTED_ANGLE_MAX).optional(),
  })
  .strict();

const ReviewSchema = z
  .object({
    reviewStatus: z.enum(MAPPING_REVIEW_STATUSES),
  })
  .strict();

const RescoreSchema = z.object({ dryRun: z.boolean().default(false) }).strict();

const MapSchema = z.object({ force: z.boolean().default(false) }).strict();

/**
 * The shape the admin UI renders.
 *
 * Signals are summarised rather than returned in full: a trend curated weekly for a year
 * has fifty-odd observations, and the list view needs the count and the latest, not the
 * history. The detail view asks for the history explicitly.
 */
function toAdminView(trend: TrendWithRelations) {
  const curation = readCuration(trend.raw);
  const mapping = readCategoryMapping(trend.raw);
  const latest = trend.signals[trend.signals.length - 1];

  return {
    id: trend.id,
    title: trend.title,
    description: trend.description,
    kind: trend.kind,
    platform: trend.platform,
    externalRef: trend.externalRef,
    exampleUrls: trend.exampleUrls,
    status: trend.status,
    velocity: trend.velocity,
    momentum: trend.momentum,
    firstSeenAt: trend.firstSeenAt,
    lastSeenAt: trend.lastSeenAt,
    peakedAt: trend.peakedAt,
    signalCount: trend.signals.length,
    latestObservedAt: latest?.observedAt ?? null,
    categoryScoreCount: trend.categoryScores.length,
    curation: curation ?? null,
    mapping: mapping ?? null,
    // The two things that make a trend actually usable. Surfaced as booleans so the
    // curation list can show what still needs work at a glance, which is the whole job.
    hasAngle: Boolean(curation?.angles.length ?? curation?.defaultAngle),
    needsReview: mapping?.reviewStatus === 'NEEDS_REVIEW',
  };
}

export function createTrendAdminRouter(): Router {
  const router = Router();

  router.use(requireAuth, (req, _res, next) => {
    try {
      assertTrendAdmin(req.user?.email);
      next();
    } catch (error) {
      next(error);
    }
  });

  router.get(
    '/',
    handle(async (req, res) => {
      const query = ListQuerySchema.safeParse(req.query);
      if (!query.success) {
        throw new ValidationError('Invalid query', { details: query.error.issues });
      }

      const trends = await listTrends(getPrisma(), {
        status: query.data.status,
        search: query.data.search,
        take: query.data.take,
      });

      const views = trends.map(toAdminView);

      res.json({
        trends: query.data.needsReview ? views.filter((v) => v.needsReview) : views,
      });
    }),
  );

  router.get(
    '/:id',
    handle(async (req, res) => {
      const trend = await getTrend(getPrisma(), req.params.id as string);
      if (!trend) throw new NotFoundError('Trend');

      res.json({
        ...toAdminView(trend),
        signals: trend.signals.map((s) => ({
          id: s.id,
          collectorId: s.collectorId,
          observedAt: s.observedAt,
          metrics: s.metrics,
        })),
        categoryScores: trend.categoryScores,
      });
    }),
  );

  /**
   * Record a curated observation. Creates the trend if it is new, appends a signal if it
   * is not — curating the same trend next week must add a second data point, because two
   * points are what make a velocity.
   */
  router.post(
    '/observations',
    handle(async (req, res) => {
      const parsed = ManualObservationSchema.safeParse({
        ...(req.body as Record<string, unknown>),
        curatedBy: req.user!.email,
      });

      if (!parsed.success) {
        throw new ValidationError('Invalid observation', { details: parsed.error.issues });
      }

      const db = getPrisma();
      const trend = await recordManualObservation(db, parsed.data);

      // Score and map immediately. A curator who records an observation and sees the trend
      // sit at momentum 0 until some later job runs has no way to tell whether they did it
      // right, and would reasonably record it again.
      const now = new Date();
      await rescoreOne(db, trend, now);
      await mapTrend(db, trend, await loadTaxonomy(db), now);

      const refreshed = await getTrend(db, trend.id);
      res.status(201).json(toAdminView(refreshed!));
    }),
  );

  router.patch(
    '/:id',
    handle(async (req, res) => {
      const parsed = PatchSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError('Invalid patch', { details: parsed.error.issues });
      }

      const db = getPrisma();
      const id = req.params.id as string;
      const existing = await getTrend(db, id);
      if (!existing) throw new NotFoundError('Trend');

      await updateTrend(db, id, parsed.data);

      // Title and description are mapping inputs, so editing them invalidates the cached
      // classification by construction — `mappingInputHash` covers both.
      const refreshed = await getTrend(db, id);
      await mapTrend(db, refreshed!, await loadTaxonomy(db), new Date());

      res.json(toAdminView((await getTrend(db, id))!));
    }),
  );

  /** Write the angles. This is the part that makes a trend usable rather than noise. */
  router.put(
    '/:id/curation',
    handle(async (req, res) => {
      const parsed = CurationSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError('Invalid curation', { details: parsed.error.issues });
      }

      const db = getPrisma();
      const id = req.params.id as string;
      const trend = await getTrend(db, id);
      if (!trend) throw new NotFoundError('Trend');

      // Merged against the current row, not the one read a moment ago: mapping and
      // curation share `raw`, and a stale write drops the trend out of every feed.
      await mergeRaw(db, id, (raw) =>
        writeCuration(raw, {
          ...parsed.data,
          curatedBy: req.user!.email,
          curatedAt: new Date().toISOString(),
        }),
      );
      res.json(toAdminView((await getTrend(db, id))!));
    }),
  );

  /**
   * Resolve a low-confidence mapping.
   *
   * `CONFIRMED` and `REJECTED` are sticky: a later re-map will not overwrite a human
   * decision, because a person who looked at the trend is the most reliable signal the
   * system has and recomputation must not silently discard it.
   */
  router.post(
    '/:id/mapping/review',
    handle(async (req, res) => {
      const parsed = ReviewSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError('Invalid review', { details: parsed.error.issues });
      }

      const db = getPrisma();
      const id = req.params.id as string;
      const trend = await getTrend(db, id);
      if (!trend) throw new NotFoundError('Trend');

      const mapping = readCategoryMapping(trend.raw);
      if (!mapping) throw new NotFoundError('Category mapping');

      await mergeRaw(db, id, (raw) =>
        writeCategoryMapping(raw, {
          ...mapping,
          reviewStatus: parsed.data.reviewStatus,
          reviewedBy: req.user!.email,
          reviewedAt: new Date().toISOString(),
        }),
      );

      res.json(toAdminView((await getTrend(db, id))!));
    }),
  );

  router.post(
    '/:id/map',
    handle(async (req, res) => {
      const parsed = MapSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new ValidationError('Invalid request', { details: parsed.error.issues });
      }

      const db = getPrisma();
      const trend = await getTrend(db, req.params.id as string);
      if (!trend) throw new NotFoundError('Trend');

      const result = await mapTrend(db, trend, await loadTaxonomy(db), new Date(), {
        force: parsed.data.force,
      });

      res.json({ mapping: result.mapping, scores: result.scores, cached: result.cached });
    }),
  );

  /**
   * Re-run scoring over the full signal history.
   *
   * The acceptance criterion, exposed as an endpoint. `dryRun` returns what *would*
   * change without writing — tuning the algorithm means wanting to see the effect before
   * causing it, and overwriting every score to find out is not a step anyone can undo.
   *
   * Not on a schedule: pg-boss is deferred to W6, and introducing a second job system to
   * cover the gap would be a worse problem than a manual trigger. Reported for W6 to wire.
   */
  router.post(
    '/rescore',
    handle(async (req, res) => {
      const parsed = RescoreSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new ValidationError('Invalid request', { details: parsed.error.issues });
      }

      const results = await rescoreAll(getPrisma(), new Date(), { dryRun: parsed.data.dryRun });

      res.json({
        dryRun: parsed.data.dryRun,
        total: results.length,
        changed: results.filter((r) => r.changed).length,
        results: results.map((r) => ({
          trendId: r.trendId,
          title: r.title,
          changed: r.changed,
          before: r.before,
          after: {
            velocity: r.after.velocity,
            momentum: r.after.momentum,
            status: r.after.status,
            usableSignals: r.after.usableSignals,
          },
        })),
      });
    }),
  );

  return router;
}
