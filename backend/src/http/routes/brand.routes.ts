import { AssetKind, Role } from '@prisma/client';
import { Router, type ErrorRequestHandler } from 'express';
import multer from 'multer';
import { z } from 'zod';
import {
  MAX_UPLOAD_BYTES,
  deleteAsset,
  listAssets,
  uploadAsset,
} from '../../modules/brand/asset.service';
import {
  UpdateBrandSchema,
  deleteBrand,
  getBrand,
  setBrandLogo,
  toBrandView,
  updateBrand,
} from '../../modules/brand/brand.service';
import { listCategoryTree, searchCategories } from '../../modules/brand/category.service';
import { FONT_CATALOG } from '../../modules/brand/fonts';
import { suggestPaletteFromImage } from '../../modules/brand/palette';
import { DraftVoiceGuideSchema, draftVoiceGuide } from '../../modules/brand/voice.service';
import { getPrisma } from '../../platform/db';
import { ValidationError } from '../../platform/errors';
import { withTenantScope } from '../../platform/tenancy';
import { requireAuth } from '../middleware/require-auth';
import { brandOf, requireBrand } from '../middleware/require-scope';

/**
 * Brand routes.
 *
 * Every handler touching tenant data reads its client from `brandOf(req)`, which only
 * exists behind `requireBrand`. No unscoped client is imported for tenant reads, so an
 * unfiltered query is not something a handler here can express — which is what ADR-0010
 * means by not resting tenancy on developer discipline.
 */

/**
 * Memory storage, not disk. Heroku's filesystem is ephemeral and a temp file written on
 * one dyno is invisible to the next request, so the bytes go straight through to R2.
 * Multer enforces the size limit before the buffer is fully assembled, which is the only
 * place a limit actually saves memory.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
});

/**
 * The reference-data client.
 *
 * `null` scope, deliberately: categories and fonts are platform-wide, and a client with a
 * null scope serves them while throwing on any tenant model. Reaching for `getPrisma()`
 * directly here would work too — and would put an unscoped client one autocomplete away
 * from the handlers below.
 */
function referenceDb() {
  return withTenantScope(getPrisma(), null);
}

const AssetKindSchema = z.nativeEnum(AssetKind);

const UploadMetadataSchema = z
  .object({
    kind: AssetKindSchema.optional(),
    altText: z.string().max(1000).optional(),
    // Multipart fields are always strings, so tags arrive comma-joined rather than as an
    // array — parsing that here keeps the shape the same as the JSON endpoints'.
    tags: z.string().max(500).optional(),
  })
  .strip();

function parseTags(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 20);
}

function requireFile(file: Express.Multer.File | undefined): Express.Multer.File {
  if (!file) {
    throw new ValidationError('Expected a file in the "file" field of a multipart upload');
  }
  return file;
}

export function createBrandRouter(): Router {
  const router = Router();

  router.use(requireAuth);

  // --- Reference data -------------------------------------------------------
  // Registered before `/:brandId`, or Express would match "categories" as a brand id.

  router.get('/categories', (_req, res, next) => {
    void (async () => {
      try {
        res.json({ categories: await listCategoryTree(referenceDb()) });
      } catch (error) {
        next(error);
      }
    })();
  });

  router.get('/categories/search', (req, res, next) => {
    void (async () => {
      try {
        const query = typeof req.query.q === 'string' ? req.query.q : '';
        res.json({ categories: await searchCategories(referenceDb(), query) });
      } catch (error) {
        next(error);
      }
    })();
  });

  /**
   * The fonts a brand may choose.
   *
   * Served from the backend rather than hardcoded in the UI because Satori has no system
   * font fallback: an unresolvable family renders a *blank* image rather than erroring, so
   * the render pipeline and the picker have to agree on the list or a brand can configure
   * its way into silently empty posts.
   */
  router.get('/fonts', (_req, res) => {
    res.json({ fonts: FONT_CATALOG });
  });

  // --- A single brand -------------------------------------------------------

  router.get('/:brandId', requireBrand(), (req, res, next) => {
    void (async () => {
      try {
        const { db, brandId } = scope(req);
        res.json({ brand: toBrandView(await getBrand(db, brandId)) });
      } catch (error) {
        next(error);
      }
    })();
  });

  router.patch('/:brandId', requireBrand(), (req, res, next) => {
    void (async () => {
      try {
        const { db, brandId } = scope(req);
        const input = UpdateBrandSchema.parse(req.body);
        res.json({ brand: toBrandView(await updateBrand(db, brandId, input)) });
      } catch (error) {
        next(error);
      }
    })();
  });

  /**
   * Soft delete, and admin-only.
   *
   * A brand carries every post, metric and short link ever recorded against it. A MEMBER
   * being able to remove one by misclick is a different class of mistake from editing a
   * colour.
   */
  router.delete(
    '/:brandId',
    requireBrand('brandId', { minimumRole: Role.ADMIN }),
    (req, res, next) => {
      void (async () => {
        try {
          const { db, brandId } = scope(req);
          await deleteBrand(db, brandId);
          res.status(204).end();
        } catch (error) {
          next(error);
        }
      })();
    },
  );

  // --- Assets ---------------------------------------------------------------

  router.get('/:brandId/assets', requireBrand(), (req, res, next) => {
    void (async () => {
      try {
        const { db } = scope(req);
        const kind = req.query.kind ? AssetKindSchema.parse(req.query.kind) : undefined;
        res.json({ assets: await listAssets(db, { kind }) });
      } catch (error) {
        next(error);
      }
    })();
  });

  router.post('/:brandId/assets', requireBrand(), upload.single('file'), (req, res, next) => {
    void (async () => {
      try {
        const { db, brandId } = scope(req);
        const file = requireFile(req.file);
        const metadata = UploadMetadataSchema.parse(req.body ?? {});

        const uploaded = await uploadAsset(db, brandId, {
          buffer: file.buffer,
          kind: metadata.kind ?? AssetKind.PHOTO,
          altText: metadata.altText ?? null,
          tags: parseTags(metadata.tags),
          originalName: file.originalname,
        });

        res.status(201).json(uploaded);
      } catch (error) {
        next(error);
      }
    })();
  });

  router.delete('/:brandId/assets/:assetId', requireBrand(), (req, res, next) => {
    void (async () => {
      try {
        const { db } = scope(req);
        await deleteAsset(db, req.params.assetId);
        res.status(204).end();
      } catch (error) {
        next(error);
      }
    })();
  });

  /** Point the brand at one of its own assets, or clear the logo with an explicit null. */
  router.put('/:brandId/logo', requireBrand(), (req, res, next) => {
    void (async () => {
      try {
        const { db, brandId } = scope(req);
        const { assetId } = z
          .object({ assetId: z.string().uuid().nullable() })
          .strict()
          .parse(req.body);

        res.json({ brand: toBrandView(await setBrandLogo(db, brandId, assetId)) });
      } catch (error) {
        next(error);
      }
    })();
  });

  // --- Assistive suggestions ------------------------------------------------
  // Neither of these writes anything. Both return a proposal the user accepts or ignores.

  /**
   * Suggest a palette from an uploaded logo.
   *
   * Takes the image in the request rather than an asset id so the suggestion can be shown
   * while the user is still deciding whether to keep the logo at all — requiring an upload
   * first would mean storing files people then discard.
   */
  router.post(
    '/:brandId/palette-suggestion',
    requireBrand(),
    upload.single('file'),
    (req, res, next) => {
      void (async () => {
        try {
          scope(req);
          const file = requireFile(req.file);
          res.json({ palette: await suggestPaletteFromImage(file.buffer), suggested: true });
        } catch (error) {
          next(error);
        }
      })();
    },
  );

  router.post('/:brandId/voice-guide/draft', requireBrand(), (req, res, next) => {
    void (async () => {
      try {
        const { db, brandId } = scope(req);
        const input = DraftVoiceGuideSchema.parse(req.body ?? {});
        res.json(await draftVoiceGuide(db, brandId, input));
      } catch (error) {
        next(error);
      }
    })();
  });

  return router;
}

/**
 * Multer rejects an oversized upload with its own error class, which the generic handler
 * would report as a 500. It is a 400 — the client sent something too big — and saying so
 * is the difference between "try a smaller image" and "the site is broken".
 */
export const multerErrorHandler: ErrorRequestHandler = (error, _req, _res, next) => {
  if (error instanceof multer.MulterError) {
    const message =
      error.code === 'LIMIT_FILE_SIZE'
        ? `That file is larger than the ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB limit`
        : `Upload rejected: ${error.message}`;
    next(new ValidationError(message));
    return;
  }
  next(error);
};

/** The resolved brand scope. Throws a loud 500 if the route forgot `requireBrand`. */
function scope(req: Parameters<typeof brandOf>[0]) {
  const access = brandOf(req);
  return { db: access.db, brandId: access.brandId, workspaceId: access.workspaceId };
}
