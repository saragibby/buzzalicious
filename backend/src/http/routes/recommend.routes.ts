import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { getPrisma } from '../../platform/db';
import { ValidationError } from '../../platform/errors';
import { requireAuth } from '../middleware/require-auth';
import { requireBrandAccess } from '../../modules/identity/authorization';
import { categoryAggregates, recommendationsFor } from '../../modules/recommend/recommend.service';
import type { ClickWindow } from '../../modules/link/rollup.service';

/**
 * What to make next, and why.
 *
 * ## The one unscoped read, and why it is here rather than deeper
 *
 * A category prior is a platform-wide statistic by definition — "how does this archetype
 * do for businesses like yours" is unanswerable from inside one brand's scope. So exactly
 * one call in this file takes the unscoped client: `categoryAggregates`. It is called
 * here, at the boundary, and its result is passed *into* `recommendationsFor` as data.
 *
 * The alternative — letting `recommendationsFor` widen its own scope internally — would
 * put a scope escape inside a function whose signature promises it is scoped. A reader
 * checking whether this endpoint can leak would have to read the whole module to find out.
 * Here the widening is one line, in the request handler, next to the authorization that
 * justifies it.
 *
 * `categoryAggregates` itself reads each contributing brand through *that brand's* own
 * scope, so no query underneath returns rows from more than one tenant; the unscoped
 * client is used only to discover which brands share the category.
 *
 * ## Nulls travel all the way out
 *
 * A cadence we could not measure is `null`, not `0`, and a claim we could not support is
 * `kind: 'no-claim'`, not a `1.0` multiplier. Nothing here tidies either into a number on
 * the way past — see `docs/06-outcome-and-feedback-loop.md`.
 */

function handle(fn: (...args: Parameters<RequestHandler>) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    void fn(req, res, next).catch(next);
  };
}

const DEFAULT_WINDOW_DAYS = 90;

/**
 * A longer default window than the insights dashboard uses.
 *
 * Recommendations are shrunk toward a prior by sample size, so a short window does not
 * produce *wrong* recommendations — it produces timid ones, where every archetype sits
 * near its prior and the brand's own history never gets to speak. Ninety days is roughly
 * the point at which a brand posting twice a week clears the claim threshold.
 */
const QuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(DEFAULT_WINDOW_DAYS),
  count: z.coerce.number().int().min(1).max(24).optional(),
});

function resolveWindow(days: number, now: Date): ClickWindow {
  return { from: new Date(now.getTime() - days * 86_400_000), to: now };
}

export function createRecommendRouter(): Router {
  const router = Router({ mergeParams: true });

  router.get(
    '/',
    requireAuth,
    handle(async (req, res) => {
      const query = QuerySchema.safeParse(req.query);
      if (!query.success) {
        throw new ValidationError('Invalid recommendation query', {
          details: query.error.issues,
        });
      }

      const brandId = req.params.brandId as string;
      const access = await requireBrandAccess(req.user!.id, brandId);
      const now = new Date();
      const window = resolveWindow(query.data.days, now);

      // Read the brand's category through the *scoped* client. The unscoped read below
      // needs a category id, and taking it from an unscoped lookup would mean an
      // unscoped query decided which category this brand belongs to.
      const brand = await access.db.brand.findFirst({
        where: { id: brandId, deletedAt: null },
        select: { categoryId: true },
      });

      const aggregates = brand?.categoryId
        ? await categoryAggregates(getPrisma(), brand.categoryId, window, brandId)
        : null;

      const result = await recommendationsFor(access.db, {
        brandId,
        window,
        now,
        count: query.data.count,
        aggregates,
      });

      res.json({
        window: { from: window.from.toISOString(), to: window.to.toISOString() },
        brandId: result.brandId,
        timezone: result.timezone,
        category: result.category,
        archetypes: result.archetypes.map((item) => ({
          archetype: item.archetype,
          templateIds: item.templateIds,
          // The score is deliberately unpacked rather than serialised whole. `ShrunkScore`
          // is branded so a shrunk figure cannot be mistaken for a measured one inside the
          // backend, but JSON has no brands — so the wire format carries the basis
          // explicitly instead, and the client is never handed a bare number it could read
          // as a measurement.
          value: item.score.shrunkValue,
          basis: {
            observed: item.score.basis.observed,
            observations: item.score.basis.observations,
            prior: item.score.basis.prior,
            priorSource: item.score.basis.priorSource,
            brandWeight: item.score.basis.brandWeight,
            priorWeight: item.score.basis.priorWeight,
          },
          scored: item.scored,
          posts: item.posts,
          userChoices: item.userChoices,
          selection: item.selection,
          explanation: item.explanation,
        })),
        sendTime: {
          // Unpacked for the same reason as the archetype scores above: a `SlotScore`
          // carries a branded `ShrunkScore`, and serialising it whole would put a shrunk
          // figure on the wire under a name that does not say so.
          slots: result.sendTime.slots.map((slot) => ({
            slot: slot.slot,
            value: slot.score.shrunkValue,
            basis: {
              observed: slot.score.basis.observed,
              observations: slot.score.basis.observations,
              prior: slot.score.basis.prior,
              priorSource: slot.score.basis.priorSource,
              brandWeight: slot.score.basis.brandWeight,
              priorWeight: slot.score.basis.priorWeight,
            },
            scored: slot.scored,
            posts: slot.posts,
            priorBasis: slot.priorBasis,
            claimable: slot.claimable,
          })),
          suggestedSlot: result.sendTime.suggestedSlot,
          selection: result.sendTime.selection,
          suggested: result.sendTime.suggested
            ? {
                slot: result.sendTime.suggested.slot,
                local: result.sendTime.suggested.local,
                instant: result.sendTime.suggested.instant.toISOString(),
                timeZone: result.sendTime.suggested.timeZone,
              }
            : null,
        },
        cadence: {
          weeks: result.cadence.weeks,
          // Same unpacking as above. A band's expected outcome is a `ShrunkScore`, and a
          // band with one measured week sits almost entirely on its prior — so the wire
          // format carries the basis rather than a bare number the UI could read as a
          // measured weekly total.
          bands: result.cadence.bands.map((band) => ({
            postsPerWeek: band.postsPerWeek,
            weeks: band.weeks,
            measuredWeeks: band.measuredWeeks,
            value: band.score.shrunkValue,
            basis: {
              observed: band.score.basis.observed,
              observations: band.score.basis.observations,
              prior: band.score.basis.prior,
              priorSource: band.score.basis.priorSource,
              brandWeight: band.score.basis.brandWeight,
              priorWeight: band.score.basis.priorWeight,
            },
          })),
          currentPerWeek: result.cadence.currentPerWeek,
          suggested: result.cadence.suggested,
          fatigueAbove: result.cadence.fatigueAbove,
          basis: result.cadence.basis,
        },
      });
    }),
  );

  return router;
}
