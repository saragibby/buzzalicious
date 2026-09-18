import { z } from 'zod';

/**
 * JSON column contract for `Rendition.rendererMeta`.
 *
 * Renders are meant to be deterministic (ADR-0002), which is only a meaningful claim if a
 * rendition records what produced it. When output changes unexpectedly, the first question
 * is whether Satori, resvg, a font, or the template moved — and without this column the
 * answer is unrecoverable.
 */
export const RendererMetaSchema = z
  .object({
    satoriVersion: z.string().min(1),
    resvgVersion: z.string().min(1),
    sharpVersion: z.string().min(1).optional(),
    /** libvips, which is what actually rasterizes; sharp is a thin binding over it. */
    vipsVersion: z.string().min(1).optional(),
    /** The `Template.version` rendered, which may trail the template's current version. */
    templateVersion: z.number().int().positive(),
    durationMs: z.number().nonnegative().optional(),
    /** Font families actually loaded for this render. A missing font renders blank. */
    fonts: z.array(z.string().min(1)).default([]),
    /** Set when text had to be shrunk by `$fit`, so overflow is visible after the fact. */
    fittedDown: z.array(z.string().min(1)).default([]),
    /** The cache key: (templateId, templateVersion, brandId, hash(slotValues), ratio). */
    cacheKey: z.string().min(1).optional(),
  })
  .strict();

export type RendererMeta = z.infer<typeof RendererMetaSchema>;
