/**
 * The render service: a post, a template and a brand in — `Rendition` rows out.
 *
 * ## The cache key has no platform in it, on purpose
 *
 * `Rendition` hangs off `Post`, not `PostTarget`, so one render is reused by every
 * platform that shares its aspect ratio. Publishing to Instagram, Facebook and Threads at
 * 1:1 is one render, not three. The key is therefore:
 *
 *     (templateId, templateVersion, brandId, hash(slotValues), aspectRatio)
 *
 * `templateVersion` is in it because performance is attributed to a template: editing a
 * layout in place would make old posts and new posts incomparable, so a breaking change
 * bumps the version and that version is part of what was rendered.
 *
 * ## A text post has no renditions
 *
 * `MediaType.TEXT` posts render nothing — that is what makes a plain X or Threads post
 * work. Nothing here assumes a rendition exists, and `renderPost` on a text post returns
 * an empty list rather than failing.
 */

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import type { AspectRatio, MediaType } from '@prisma/client';
import type { Db } from '../../platform/db';
import { NotFoundError, ValidationError } from '../../platform/errors';
import { getLogger } from '../../platform/logger';
import { buildStorageKey, getStorage } from '../../platform/storage';
import {
  BrandPaletteSchema,
  BrandTypographySchema,
  type BrandPalette,
  type BrandTypography,
} from '../brand/brand.schemas';
import {
  SlotValuesSchema,
  SlotSchemaSchema,
  TemplateLayoutSchema,
  validateSlotValues,
  type SlotValues,
  type TemplateLayout,
} from '../template/template.schemas';
import { prepareImage, resolveAssets } from './assets';
import type { BrandKit } from './bindings';
import { compileLayout } from './compile';
import { loadMetrics } from './fonts';
import { RenderOverflowError } from './render.errors';
import { RendererMetaSchema, type RendererMeta } from './rendition.schemas';
import { ALL_ASPECT_RATIOS, specFor } from './renderer';
import { getRenderer, PREVIEW_SCALE } from './satori-renderer';
import { assertRenderableText } from './text';

const logger = getLogger().child({ module: 'render' });

/** Immutable content, addressed by a key containing its own hash. */
const RENDITION_CACHE_CONTROL = 'public, max-age=31536000, immutable';

export interface RenderRequest {
  templateId: string;
  templateVersion: number;
  brandId: string;
  slotValues: SlotValues;
  aspectRatio: AspectRatio;
}

/**
 * The cache key for one rendition.
 *
 * Slot values are hashed from a key-sorted JSON encoding so that two posts differing only
 * in property order share a render. A raw `JSON.stringify` would not.
 */
export function cacheKeyFor(request: RenderRequest): string {
  const slots = JSON.stringify(
    Object.fromEntries(Object.entries(request.slotValues).sort(([a], [b]) => a.localeCompare(b))),
  );

  const digest = createHash('sha256')
    .update(
      [
        request.templateId,
        request.templateVersion,
        request.brandId,
        slots,
        request.aspectRatio,
      ].join('\u0000'),
    )
    .digest('hex');

  return digest.slice(0, 32);
}

interface LoadedContext {
  layout: TemplateLayout;
  slotSchema: ReturnType<typeof SlotSchemaSchema.parse>;
  brand: BrandKit;
  palette: BrandPalette;
  typography: BrandTypography;
  supportedRatios: AspectRatio[];
  templateVersion: number;
}

async function loadContext(
  db: Db,
  templateId: string,
  brandId: string,
  slotValues: SlotValues,
): Promise<LoadedContext> {
  const [template, brand] = await Promise.all([
    db.template.findUnique({ where: { id: templateId } }),
    db.brand.findUnique({ where: { id: brandId }, include: { logo: true } }),
  ]);

  if (!template) throw new NotFoundError(`Template ${templateId} not found`);
  if (!brand) throw new NotFoundError(`Brand ${brandId} not found`);

  const layout = TemplateLayoutSchema.parse(template.layout);
  const slotSchema = SlotSchemaSchema.parse(template.slotSchema);
  const palette = BrandPaletteSchema.parse(brand.palette);
  const typography = BrandTypographySchema.parse(brand.typography);

  const issues = validateSlotValues(slotSchema, slotValues);
  if (issues.length > 0) {
    throw new ValidationError('Slot values do not satisfy the template', {
      details: { issues },
    });
  }

  let logo: string | undefined;
  if (brand.logo) {
    // A brand can hold an `Asset` row whose object is no longer in storage — a failed
    // upload, a lifecycle rule, or a seeded key with nothing behind it. Templates already
    // have to render a brand that has no logo at all, so degrading to that is strictly
    // better than refusing every render this brand asks for because its wordmark is gone.
    try {
      const bytes = await getStorage().get(brand.logo.storageKey);
      logo = (await prepareImage(bytes)).dataUri;
    } catch (error) {
      logger.warn(
        { brandId, storageKey: brand.logo.storageKey, err: error },
        'brand logo object is missing; rendering without it',
      );
    }
  }

  return {
    layout,
    slotSchema,
    brand: { palette, typography, logo },
    palette,
    typography,
    supportedRatios: template.supportedRatios,
    templateVersion: template.version,
  };
}

/** Text slots, with schema defaults applied. Image slots are handled separately. */
function textSlots(
  slotSchema: LoadedContext['slotSchema'],
  values: SlotValues,
): Record<string, string> {
  const text: Record<string, string> = {};

  for (const [name, definition] of Object.entries(slotSchema)) {
    if (definition.type !== 'text') continue;
    const value = values[name];
    text[name] = typeof value === 'string' && value !== '' ? value : (definition.default ?? '');
  }

  return text;
}

function imageAssetIds(
  slotSchema: LoadedContext['slotSchema'],
  values: SlotValues,
): Record<string, string> {
  const images: Record<string, string> = {};

  for (const [name, definition] of Object.entries(slotSchema)) {
    if (definition.type !== 'image') continue;
    const value = values[name];
    if (value && typeof value === 'object' && 'assetId' in value) images[name] = value.assetId;
  }

  return images;
}

export interface RenderedRendition {
  aspectRatio: AspectRatio;
  storageKey: string;
  width: number;
  height: number;
  bytes: number;
  png: Buffer;
  meta: RendererMeta;
  /** True when an existing rendition was reused rather than re-rendered. */
  cached: boolean;
}

interface Versions {
  satoriVersion: string;
  resvgVersion: string;
  sharpVersion: string;
}

let versionCache: Versions | undefined;

/**
 * `createRequire` rather than a static import: these are the renderer's own dependencies'
 * manifests, which have no types and no business being in the module graph.
 */
const resolve = createRequire(__filename);

/** Recorded on every rendition so an unexpected pixel change can be attributed. */
function loadVersions(): Versions {
  if (versionCache) return versionCache;

  const read = (name: string): string => {
    try {
      return (resolve(`${name}/package.json`) as { version: string }).version;
    } catch {
      return 'unknown';
    }
  };

  versionCache = {
    satoriVersion: read('satori'),
    resvgVersion: read('@resvg/resvg-js'),
    sharpVersion: read('sharp'),
  };

  return versionCache;
}

export interface RenderOneOptions {
  /** Skip the cache lookup and re-render. Used when a template is being edited. */
  force?: boolean;
}

/**
 * Render one aspect ratio, reusing a stored rendition when the inputs are unchanged.
 *
 * The cache is checked against storage rather than only the database: a `Rendition` row
 * whose object has been deleted is worse than no row at all, because publishing would
 * hand the platform a dead key.
 */
export async function renderOne(
  db: Db,
  workspaceId: string,
  request: RenderRequest,
  options: RenderOneOptions = {},
): Promise<RenderedRendition> {
  const cacheKey = cacheKeyFor(request);
  const storage = getStorage();

  if (!options.force) {
    const existing = await db.rendition.findFirst({
      where: {
        aspectRatio: request.aspectRatio,
        rendererMeta: { path: ['cacheKey'], equals: cacheKey },
      },
      orderBy: { renderedAt: 'desc' },
    });

    if (existing && (await storage.exists(existing.storageKey))) {
      logger.debug({ cacheKey, aspectRatio: request.aspectRatio }, 'rendition cache hit');

      return {
        aspectRatio: existing.aspectRatio,
        storageKey: existing.storageKey,
        width: existing.width,
        height: existing.height,
        bytes: existing.bytes,
        png: await storage.get(existing.storageKey),
        meta: RendererMetaSchema.parse(existing.rendererMeta),
        cached: true,
      };
    }
  }

  const context = await loadContext(db, request.templateId, request.brandId, request.slotValues);

  if (!context.supportedRatios.includes(request.aspectRatio)) {
    throw new ValidationError(
      `Template does not support ${request.aspectRatio}. Supported: ${context.supportedRatios.join(', ')}`,
    );
  }

  const slots = textSlots(context.slotSchema, request.slotValues);
  const assetIds = imageAssetIds(context.slotSchema, request.slotValues);

  await assertRenderableText(
    Object.entries(slots).map(([field, text]) => ({ field, text })),
    [context.typography.headingFamily, context.typography.bodyFamily],
  );

  const assets = await resolveAssets(db, Object.values(assetIds));
  const images = Object.fromEntries(
    Object.entries(assetIds).map(([slot, id]) => [slot, assets.get(id)?.dataUri ?? '']),
  );

  const compiled = compileLayout({
    layout: context.layout,
    brand: context.brand,
    slots,
    images,
    aspectRatio: request.aspectRatio,
    metrics: await loadMetrics(),
  });

  if (compiled.overflows.length > 0) {
    throw new RenderOverflowError(request.aspectRatio, compiled.overflows);
  }

  const image = await getRenderer().render(compiled.element, request.aspectRatio, {
    fittedDown: compiled.fittedDown,
  });

  const storageKey = buildStorageKey({ workspaceId, kind: 'renditions', extension: 'png' });
  await storage.put(storageKey, image.png, {
    contentType: 'image/png',
    cacheControl: RENDITION_CACHE_CONTROL,
  });

  const meta = RendererMetaSchema.parse({
    ...loadVersions(),
    templateVersion: request.templateVersion,
    durationMs: image.durationMs,
    fonts: await getRenderer().fontFamilies(),
    fittedDown: compiled.fittedDown,
    cacheKey,
  });

  return {
    aspectRatio: request.aspectRatio,
    storageKey,
    width: image.width,
    height: image.height,
    bytes: image.png.byteLength,
    png: image.png,
    meta,
    cached: false,
  };
}

export interface RenderPostOptions extends RenderOneOptions {
  /** Defaults to every ratio the template supports. */
  aspectRatios?: AspectRatio[];
}

/**
 * Render a post and persist its renditions.
 *
 * Ratios are rendered in parallel. They share no mutable state — fonts and metrics are
 * cached module-level and read-only — and the four-ratio budget in docs/05 is not
 * reachable serially.
 */
export async function renderPost(
  db: Db,
  postId: string,
  options: RenderPostOptions = {},
): Promise<RenderedRendition[]> {
  const post = await db.post.findUnique({
    where: { id: postId },
    include: { brand: { select: { workspaceId: true } }, template: true },
  });

  if (!post) throw new NotFoundError(`Post ${postId} not found`);

  // A TEXT post renders nothing. This is not an edge case to tolerate, it is how a plain
  // X or Threads post works.
  if (post.mediaType !== ('IMAGE' satisfies MediaType)) return [];

  if (!post.template || !post.templateId) {
    throw new ValidationError('An image post must reference a template to be rendered');
  }

  const slotValues = SlotValuesSchema.parse(post.slotValues ?? {});
  const ratios =
    options.aspectRatios ??
    post.template.supportedRatios.filter((ratio) => ALL_ASPECT_RATIOS.includes(ratio));

  const rendered = await Promise.all(
    ratios.map((aspectRatio) =>
      renderOne(
        db,
        post.brand.workspaceId,
        {
          templateId: post.templateId as string,
          templateVersion: post.templateVersion ?? post.template!.version,
          brandId: post.brandId,
          slotValues,
          aspectRatio,
        },
        options,
      ),
    ),
  );

  await db.$transaction(
    rendered
      .filter((item) => !item.cached)
      .map((item) =>
        db.rendition.create({
          data: {
            postId,
            aspectRatio: item.aspectRatio,
            storageKey: item.storageKey,
            width: item.width,
            height: item.height,
            bytes: item.bytes,
            rendererMeta: item.meta,
          },
        }),
      ),
  );

  return rendered;
}

export interface PreviewRequest extends RenderRequest {
  workspaceId: string;
}

/**
 * A low-resolution SVG preview for the composer.
 *
 * Nothing is rasterized and nothing is stored, which is what keeps a debounced preview
 * inside the docs/05 budget. Overflow is reported rather than thrown: the composer wants
 * to show the user what is wrong while they type, not a modal.
 */
export async function previewRender(
  db: Db,
  request: RenderRequest,
): Promise<{
  svg: string;
  width: number;
  height: number;
  overflows: unknown[];
  fittedDown: string[];
}> {
  const context = await loadContext(db, request.templateId, request.brandId, request.slotValues);
  const slots = textSlots(context.slotSchema, request.slotValues);
  const assetIds = imageAssetIds(context.slotSchema, request.slotValues);
  const assets = await resolveAssets(db, Object.values(assetIds));

  const compiled = compileLayout({
    layout: context.layout,
    brand: context.brand,
    slots,
    images: Object.fromEntries(
      Object.entries(assetIds).map(([slot, id]) => [slot, assets.get(id)?.dataUri ?? '']),
    ),
    aspectRatio: request.aspectRatio,
    metrics: await loadMetrics(),
    scale: PREVIEW_SCALE,
  });

  const spec = specFor(request.aspectRatio);
  const preview = await getRenderer().renderPreview(compiled.element, request.aspectRatio, {
    fittedDown: compiled.fittedDown,
  });

  return {
    svg: preview.svg,
    width: Math.round(spec.width * PREVIEW_SCALE),
    height: Math.round(spec.height * PREVIEW_SCALE),
    overflows: compiled.overflows,
    fittedDown: compiled.fittedDown,
  };
}
