import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { ValidationError } from '../../platform/errors';
import { requireAuth } from '../middleware/require-auth';
import { requireBrandAccess } from '../../modules/identity/authorization';
import { insightSummary, metricTimeline } from '../../modules/insight/insight.service';
import { clicksByDay, clicksByShortLink, type ClickWindow } from '../../modules/link/rollup.service';

/**
 * Read-only insight surfaces, mounted under a brand.
 *
 * Every response here goes through `requireBrandAccess`, whose `db` is tenant-scoped.
 * Nothing in this file touches `getPrisma()` directly — an unscoped read on an analytics
 * endpoint would return other tenants' numbers looking exactly like the caller's own,
 * with no error and nothing in the shape of the response to give it away.
 *
 * ## Nulls travel all the way out
 *
 * JSON has a null and the UI knows what to do with it. The one thing this layer must not
 * do is tidy a null into a 0 on the way past — see `insight.service.ts`.
 */

function handle(fn: (...args: Parameters<RequestHandler>) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    void fn(req, res, next).catch(next);
  };
}

const DEFAULT_WINDOW_DAYS = 30;

const WindowSchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(DEFAULT_WINDOW_DAYS),
  timeZone: z.string().min(1).default('UTC'),
});

function resolveWindow(days: number, now = new Date()): ClickWindow {
  return { from: new Date(now.getTime() - days * 86_400_000), to: now };
}

/**
 * Reject a time zone Node does not know before it reaches `Intl`.
 *
 * `Intl.DateTimeFormat` throws a `RangeError` on an unknown zone, which the error handler
 * would surface as a 500 — an operator alert for what is a bad query string.
 */
function assertTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone });
  } catch {
    throw new ValidationError(`Unknown time zone: ${timeZone}`);
  }
}

export function createInsightRouter(): Router {
  const router = Router({ mergeParams: true });

  /** The dashboard: per-target outcomes, platform and template rollups, one headline. */
  router.get(
    '/',
    requireAuth,
    handle(async (req, res) => {
      const query = WindowSchema.safeParse(req.query);
      if (!query.success)
        throw new ValidationError('Invalid insight query', { details: query.error.issues });

      const access = await requireBrandAccess(req.user!.id, req.params.brandId as string);
      const window = resolveWindow(query.data.days);
      const summary = await insightSummary(access.db, window);

      res.json({
        window: { from: window.from.toISOString(), to: window.to.toISOString() },
        headline: summary.headline,
        byPlatform: summary.byPlatform,
        byTemplate: summary.byTemplate,
        targets: summary.targets.map((target) => ({
          ...target,
          publishedAt: target.publishedAt?.toISOString() ?? null,
          capturedAt: target.capturedAt?.toISOString() ?? null,
        })),
      });
    }),
  );

  /** Clicks per day, bucketed in the caller's zone rather than UTC. */
  router.get(
    '/clicks',
    requireAuth,
    handle(async (req, res) => {
      const query = WindowSchema.safeParse(req.query);
      if (!query.success)
        throw new ValidationError('Invalid insight query', { details: query.error.issues });
      assertTimeZone(query.data.timeZone);

      const access = await requireBrandAccess(req.user!.id, req.params.brandId as string);
      const window = resolveWindow(query.data.days);

      const [days, links] = await Promise.all([
        clicksByDay(access.db, window, query.data.timeZone),
        clicksByShortLink(access.db, window),
      ]);

      res.json({ days, links });
    }),
  );

  /** One target's full snapshot history — the curve, not the latest number. */
  router.get(
    '/targets/:postTargetId/timeline',
    requireAuth,
    handle(async (req, res) => {
      const access = await requireBrandAccess(req.user!.id, req.params.brandId as string);

      // A target belonging to another brand reads as an empty timeline, because
      // `access.db` is scoped and simply does not return it. That is the same response as
      // a target with no snapshots yet, which is the intended ambiguity: distinguishing
      // them would confirm the id exists.
      const points = await metricTimeline(access.db, req.params.postTargetId as string);

      res.json({
        points: points.map((point) => ({ ...point, capturedAt: point.capturedAt.toISOString() })),
      });
    }),
  );

  return router;
}
