import { Router } from 'express';
import { z } from 'zod';
import { getPrisma } from '../../platform/db';
import { ForbiddenError, NotFoundError, ValidationError } from '../../platform/errors';
import { requireAuth } from '../middleware/require-auth';
import {
  SlotSchemaSchema,
  TemplateLayoutSchema,
  SlotValuesSchema,
} from '../../modules/template/template.schemas';
import { rankTemplates } from '../../modules/template/relevance';
import { previewRender } from '../../modules/render/render.service';
import { ALL_ASPECT_RATIOS } from '../../modules/render/renderer';

/**
 * The template registry, and the composer's live preview.
 *
 * The registry is ranked rather than listed — industry relevance is the product's wedge
 * (docs/00), so "which templates" is a ranking question, not a pagination one.
 *
 * The preview endpoint returns SVG and stores nothing. A composer preview fires on every
 * keystroke after a debounce; rasterizing and persisting each one would be the most
 * expensive thing the platform does, for an artefact discarded milliseconds later.
 *
 * ## Access
 *
 * Templates themselves are platform-wide, but preview renders a *brand* — palette,
 * typography and logo belong to one workspace. An unauthenticated endpoint taking a
 * caller-supplied `brandId` would hand any visitor a picture of any client's brand, so
 * the router requires a session and the preview handler checks membership of the brand's
 * workspace.
 *
 * The membership check is inline and deliberately small. A reusable
 * `assertCanAccessWorkspace` belongs in `modules/identity/`, which W3 owns and is
 * building now; this should be replaced by that helper rather than grown here.
 */

const AspectRatioSchema = z.enum(ALL_ASPECT_RATIOS as unknown as [string, ...string[]]);

const ListQuerySchema = z.object({
  categoryId: z.string().uuid().optional(),
  archetype: z.string().min(1).optional(),
  aspectRatio: AspectRatioSchema.optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

const PreviewBodySchema = z.object({
  brandId: z.string().uuid(),
  aspectRatio: AspectRatioSchema,
  slotValues: SlotValuesSchema.default({}),
});

export function createTemplatesRouter(): Router {
  const router = Router();

  router.use(requireAuth);

  router.get('/', (req, res, next) => {
    void (async () => {
      try {
        const query = ListQuerySchema.parse(req.query);

        const templates = await rankTemplates(getPrisma(), {
          categoryId: query.categoryId,
          archetype: query.archetype,
          aspectRatios: query.aspectRatio ? [query.aspectRatio as never] : undefined,
          limit: query.limit,
        });

        res.json({ templates });
      } catch (error) {
        next(error);
      }
    })();
  });

  // The composer needs the slot schema to build its form, and the layout to explain what
  // each slot does. Both are JSON columns, so they are re-validated on the way out: a row
  // written before a contract change should fail here, not in the renderer.
  router.get('/:slug', (req, res, next) => {
    void (async () => {
      try {
        const template = await getPrisma().template.findUnique({
          where: { slug: req.params.slug },
        });

        if (!template) throw new NotFoundError('Template');

        res.json({
          template: {
            id: template.id,
            slug: template.slug,
            name: template.name,
            description: template.description,
            archetype: template.archetype,
            kind: template.kind,
            version: template.version,
            supportedRatios: template.supportedRatios,
            slotSchema: SlotSchemaSchema.parse(template.slotSchema),
            canvas: TemplateLayoutSchema.parse(template.layout).canvas ?? {},
          },
        });
      } catch (error) {
        next(error);
      }
    })();
  });

  router.post('/:slug/preview', (req, res, next) => {
    void (async () => {
      try {
        const body = PreviewBodySchema.parse(req.body);
        const db = getPrisma();

        const template = await db.template.findUnique({ where: { slug: req.params.slug } });
        if (!template) throw new NotFoundError('Template');

        // A brand is workspace-scoped data. Resolve it before rendering and confirm the
        // session user is a member, so `brandId` cannot be used to read another
        // workspace's palette, typography and logo out of a preview image.
        const brand = await db.brand.findUnique({
          where: { id: body.brandId },
          select: { workspaceId: true },
        });
        if (!brand) throw new NotFoundError('Brand');

        const userId = (req.user as { id?: string } | undefined)?.id;
        const member =
          userId &&
          (await db.membership.findUnique({
            where: { userId_workspaceId: { userId, workspaceId: brand.workspaceId } },
            select: { id: true },
          }));

        if (!member) throw new ForbiddenError('You do not have access to this brand');

        if (!template.supportedRatios.includes(body.aspectRatio as never)) {
          throw new ValidationError(
            `Template does not support ${body.aspectRatio}. ` +
              `Supported: ${template.supportedRatios.join(', ')}`,
          );
        }

        const preview = await previewRender(db, {
          templateId: template.id,
          templateVersion: template.version,
          brandId: body.brandId,
          slotValues: body.slotValues,
          aspectRatio: body.aspectRatio as never,
        });

        // Overflow is reported, not thrown. The composer wants to show the user what is
        // wrong while they type; only a real render refuses.
        res.json(preview);
      } catch (error) {
        next(error);
      }
    })();
  });

  return router;
}
