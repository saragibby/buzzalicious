import type { AspectRatio } from '@prisma/client';

/**
 * The renderer contract (ADR-0002).
 *
 * Kept deliberately narrow and implementation-free so that the Satori pipeline is one
 * implementation rather than the definition. A Puppeteer renderer for a future
 * complex-template tier, and the video renderers in v2/v3, implement this same interface —
 * which only works if nothing here leaks Satori's vocabulary.
 */

export interface RenditionSpec {
  aspectRatio: AspectRatio;
  width: number;
  height: number;
}

/**
 * The four v1 output sizes (docs/05).
 *
 * Pixel dimensions are fixed rather than derived from the ratio because platforms care
 * about absolute size, not proportion: 1080 wide is Instagram's upload ceiling before
 * recompression, and 1200×675 is X's card size.
 */
export const RENDITION_SPECS: Record<AspectRatio, RenditionSpec> = {
  SQUARE_1_1: { aspectRatio: 'SQUARE_1_1', width: 1080, height: 1080 },
  PORTRAIT_4_5: { aspectRatio: 'PORTRAIT_4_5', width: 1080, height: 1350 },
  STORY_9_16: { aspectRatio: 'STORY_9_16', width: 1080, height: 1920 },
  LANDSCAPE_16_9: { aspectRatio: 'LANDSCAPE_16_9', width: 1200, height: 675 },
};

export const ALL_ASPECT_RATIOS = Object.keys(RENDITION_SPECS) as AspectRatio[];

export function specFor(aspectRatio: AspectRatio): RenditionSpec {
  return RENDITION_SPECS[aspectRatio];
}

/**
 * The reference canvas every `$scale(n)` is expressed against.
 *
 * A template author writes `$scale(48)` meaning "48px on a 1080-wide canvas"; the
 * compiler rescales it for anything else. Without one agreed reference the same number
 * means something different in every template.
 */
export const REFERENCE_WIDTH = 1080;

export interface RenderRequest {
  /** The layout, already resolved against brand and slots by the compiler. */
  aspectRatio: AspectRatio;
  /** Set for the composer's live preview: smaller canvas, SVG only, no rasterization. */
  preview?: boolean;
}

export interface RenderedImage {
  aspectRatio: AspectRatio;
  width: number;
  height: number;
  png: Buffer;
  /** Nodes whose font size `$fit` had to shrink. Surfaced in `Rendition.rendererMeta`. */
  fittedDown: string[];
  durationMs: number;
}

export interface RenderedPreview {
  aspectRatio: AspectRatio;
  width: number;
  height: number;
  svg: string;
  fittedDown: string[];
  durationMs: number;
}

export interface Renderer {
  readonly kind: string;
  /** Font families this renderer loaded. A family absent here renders as nothing. */
  fontFamilies(): Promise<string[]>;
}
