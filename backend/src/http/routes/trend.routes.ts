import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { Platform, TrendKind } from '@prisma/client';
import { getPrisma } from '../../platform/db';
import { ValidationError } from '../../platform/errors';
import { requireAuth } from '../middleware/require-auth';
import { assertBrandAccess } from '../../modules/trend/trend.access';
import { buildFeed, loadBrandContext } from '../../modules/trend/feed.service';

/**
 * The per-brand trend feed. Read-only, and the only trend surface a normal user touches —
 * curation lives behind the admin router and a separate allow list.
 */

const QuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

/**
 * Shared async wrapper. Express 4 does not catch a rejected promise from a handler, so
 * without this an async throw becomes an unhandled rejection and the request hangs until
 * the client times out rather than returning the error body the SPA knows how to read.
 */
function handle(fn: (...args: Parameters<RequestHandler>) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    void fn(req, res, next).catch(next);
  };
}

export function createTrendRouter(): Router {
  const router = Router();

  /**
   * The brands this user can build a feed for.
   *
   * **W3 seam**, same as `assertBrandAccess`: identity owns brand listing, and this is a
   * read-only projection of the membership join the access check already performs. It
   * exists so the feed page has a real brand picker instead of asking a user to paste an
   * id, and it is the first thing to delete when W3 ships `GET /api/brands`.
   */
  router.get(
    '/brands',
    requireAuth,
    handle(async (req, res) => {
      const db = getPrisma();

      const brands = await db.brand.findMany({
        where: {
          deletedAt: null,
          workspace: { memberships: { some: { userId: req.user!.id } } },
        },
        select: {
          id: true,
          name: true,
          category: { select: { slug: true, name: true } },
        },
        orderBy: { name: 'asc' },
      });

      res.json({
        brands: brands.map((brand) => ({
          id: brand.id,
          name: brand.name,
          categorySlug: brand.category?.slug ?? null,
          categoryName: brand.category?.name ?? null,
        })),
      });
    }),
  );

  router.get(
    '/brands/:brandId/feed',
    requireAuth,
    handle(async (req, res) => {
      const db = getPrisma();
      const brandId = req.params.brandId as string;

      await assertBrandAccess(db, req.user!.id, brandId);

      const query = QuerySchema.safeParse(req.query);
      if (!query.success)
        throw new ValidationError('Invalid feed query', { details: query.error.issues });

      const brand = await loadBrandContext(db, brandId);
      const items = await buildFeed(db, brand, { now: new Date(), limit: query.data.limit });

      res.json({
        brand: {
          id: brand.brandId,
          name: brand.brandName,
          categorySlug: brand.categorySlug,
          categoryName: brand.categoryName,
          targetPlatforms: brand.targetPlatforms,
        },
        // An uncategorised brand gets an empty feed, and the UI needs to say why rather
        // than showing "no trends this week" when the real answer is "pick a category".
        needsCategory: brand.categoryId === null,
        items,
      });
    }),
  );

  return router;
}

/** Exported for the admin router, which accepts the same vocabulary. */
export const PlatformSchema = z.nativeEnum(Platform);
export const TrendKindSchema = z.nativeEnum(TrendKind);
export { handle };
