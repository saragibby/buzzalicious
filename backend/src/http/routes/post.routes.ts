import { Router } from 'express';
import { z } from 'zod';
import type { AspectRatio } from '@prisma/client';
import { getPrisma } from '../../platform/db';
import { getLogger } from '../../platform/logger';
import { ALL_ASPECT_RATIOS } from '../../modules/render/renderer';
import { generateCaption } from '../../modules/post/caption.service';
import { exportFilename, streamExportBundle } from '../../modules/post/export.service';
import {
  CreateDraftSchema,
  GenerateCaptionSchema,
  UpdateDraftSchema,
} from '../../modules/post/post.schemas';
import {
  createDraft,
  deleteDraft,
  draftReadiness,
  getDraft,
  listDrafts,
  updateDraft,
} from '../../modules/post/post.service';
import { PLATFORM_SPECS } from '../../modules/template/platform-spec';
import { requireAuth } from '../middleware/require-auth';
import { brandOf, requireBrand } from '../middleware/require-scope';

/**
 * Composer drafts and export.
 *
 * Mounted under `/api/brands/:brandId/posts` behind `requireBrand`, so every handler
 * reads its client from `brandOf(req)` and no unscoped client is in reach — the same
 * shape as `brand.routes.ts`, for the same reason (ADR-0010).
 *
 * The one deliberate exception is export, which needs the unscoped client for the render
 * service. It is passed explicitly and only after the scoped read has proven the draft
 * belongs to this tenant; see `streamExportBundle`.
 */

const logger = getLogger().child({ module: 'post.routes' });

const AspectRatioSchema = z.enum(ALL_ASPECT_RATIOS as unknown as [string, ...string[]]);

const ExportBodySchema = z
  .object({ aspectRatios: z.array(AspectRatioSchema).min(1).optional() })
  .strict();

export function createPostRouter(): Router {
  const router = Router({ mergeParams: true });

  router.use(requireAuth);
  router.use(requireBrand());

  router.get('/', (req, res, next) => {
    void (async () => {
      try {
        res.json({ drafts: await listDrafts(brandOf(req).db) });
      } catch (error) {
        next(error);
      }
    })();
  });

  router.post('/', (req, res, next) => {
    void (async () => {
      try {
        const { db, brandId } = brandOf(req);
        const input = CreateDraftSchema.parse(req.body);
        res.status(201).json({ draft: await createDraft(db, brandId, input) });
      } catch (error) {
        next(error);
      }
    })();
  });

  router.get('/:postId', (req, res, next) => {
    void (async () => {
      try {
        const { db } = brandOf(req);
        const [draft, readiness] = await Promise.all([
          getDraft(db, req.params.postId),
          draftReadiness(db, req.params.postId),
        ]);
        res.json({ draft, readiness });
      } catch (error) {
        next(error);
      }
    })();
  });

  router.patch('/:postId', (req, res, next) => {
    void (async () => {
      try {
        const { db } = brandOf(req);
        const input = UpdateDraftSchema.parse(req.body);
        const draft = await updateDraft(db, req.params.postId, input);
        res.json({ draft, readiness: await draftReadiness(db, req.params.postId) });
      } catch (error) {
        next(error);
      }
    })();
  });

  router.delete('/:postId', (req, res, next) => {
    void (async () => {
      try {
        await deleteDraft(brandOf(req).db, req.params.postId);
        res.status(204).end();
      } catch (error) {
        next(error);
      }
    })();
  });

  /**
   * Draft a caption. Metered against the workspace (ADR-0011), so an exhausted budget
   * refuses here with a 402 rather than spending and reporting it afterwards.
   */
  router.post('/:postId/caption', (req, res, next) => {
    void (async () => {
      try {
        const { db } = brandOf(req);
        const input = GenerateCaptionSchema.parse(req.body ?? {});
        res.json(await generateCaption(db, req.params.postId, input));
      } catch (error) {
        next(error);
      }
    })();
  });

  /**
   * The export bundle.
   *
   * Streamed rather than buffered, which means headers are committed before the first
   * byte of zip exists — so a failure *after* streaming starts cannot become a JSON error
   * body. It is logged and the connection destroyed instead, which the browser surfaces
   * as a failed download. That is the honest outcome: a truncated zip that looks like a
   * successful download is exactly the "silently clipped" failure the brief rules out.
   *
   * Everything that can be checked before streaming — scope, readiness, targets — is
   * checked inside `streamExportBundle` before it touches the response.
   */
  router.post('/:postId/export', (req, res, next) => {
    void (async () => {
      try {
        const { db } = brandOf(req);
        const body = ExportBodySchema.parse(req.body ?? {});

        await streamExportBundle(db, getPrisma(), req.params.postId, res, {
          aspectRatios: body.aspectRatios as AspectRatio[] | undefined,
          // Headers are set here, not above, so that a readiness or render failure is
          // still a JSON 400/404 rather than an error body wearing zip headers.
          onBeforeStream: (draft) => {
            res.setHeader('Content-Type', 'application/zip');
            res.setHeader('Content-Disposition', `attachment; filename="${exportFilename(draft)}"`);
          },
        });
      } catch (error) {
        if (res.headersSent) {
          logger.error(
            { postId: req.params.postId, err: error },
            'export failed after streaming began; destroying the response rather than ' +
              'letting a truncated zip look like a successful download',
          );
          // Not thrown: `destroy` needs an Error to abort the socket with, and the
          // response is already committed so nothing can reach the error handler.
          // eslint-disable-next-line no-restricted-syntax
          const reason = error instanceof Error ? error : new Error('export failed');
          res.destroy(reason);
          return;
        }
        next(error);
      }
    })();
  });

  return router;
}

/**
 * The platform specs the composer counts against.
 *
 * Served rather than duplicated in the frontend bundle so there is one source for the
 * numbers. The counting *functions* are unavoidably implemented on both sides — a
 * keystroke cannot round-trip — and are pinned to the same documented cases by tests in
 * each workspace.
 */
export function createPlatformRouter(): Router {
  const router = Router();

  router.use(requireAuth);

  router.get('/', (_req, res) => {
    res.json({ platforms: Object.values(PLATFORM_SPECS) });
  });

  return router;
}
