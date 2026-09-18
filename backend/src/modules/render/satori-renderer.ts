import { Resvg } from '@resvg/resvg-js';
import satori from 'satori';
import sharp from 'sharp';
import type { AspectRatio } from '@prisma/client';
import { loadFonts } from './fonts';
import { RenderError } from './render.errors';
import { specFor, type RenderedImage, type RenderedPreview, type Renderer } from './renderer';

/**
 * The Satori → resvg → sharp implementation of `Renderer` (ADR-0002).
 *
 * This file knows about Satori and nothing else does. The compiler produces a plain
 * element tree; everything Satori-specific — font handing, the SVG, rasterization — stops
 * here, so a second renderer is a new file rather than an excavation.
 */

/**
 * The element shape Satori consumes. It looks like React's, and Satori will accept actual
 * JSX, but building plain objects avoids pulling React into the worker for a tree that is
 * never reconciled and never re-rendered.
 */
export interface SatoriElement {
  type: string;
  props: {
    style?: Record<string, unknown>;
    children?: SatoriElement | SatoriElement[] | string | (SatoriElement | string)[];
    [key: string]: unknown;
  };
}

/**
 * Previews render at a fraction of full size.
 *
 * `$scale` makes this safe: every dimension is proportional, so a third-size preview is
 * the same design, not a different one. Rasterization is skipped entirely — the composer
 * displays the SVG — which is what keeps a debounced preview inside 150ms.
 */
export const PREVIEW_SCALE = 1 / 3;

export interface SatoriRenderOptions {
  /** Nodes whose text `$fit` shrank, passed through to `Rendition.rendererMeta`. */
  fittedDown?: string[];
  /** Resolve an image or emoji Satori asks for. Never performs network I/O. */
  loadAdditionalAsset?: (code: string, segment: string) => Promise<string>;
}

export class SatoriRenderer implements Renderer {
  readonly kind = 'satori' as const;

  async fontFamilies(): Promise<string[]> {
    const fonts = await loadFonts();
    return [...new Set(fonts.map((font) => font.name))];
  }

  /**
   * Element tree → SVG.
   *
   * Satori's failure mode for a malformed tree is a blank or subtly wrong image rather
   * than a throw, so anything it *does* throw is worth wrapping rather than swallowing.
   */
  async toSvg(
    element: SatoriElement,
    width: number,
    height: number,
    options: SatoriRenderOptions = {},
  ): Promise<string> {
    const fonts = await loadFonts();

    try {
      return await satori(element as never, {
        width,
        height,
        fonts,
        loadAdditionalAsset: options.loadAdditionalAsset,
      });
    } catch (cause) {
      throw new RenderError(`Satori failed to build the SVG: ${String(cause)}`, { cause });
    }
  }

  /**
   * SVG → PNG.
   *
   * `sharp` strips metadata on the way out, which matters twice: it shaves bytes off every
   * upload, and it makes the output a function of the input alone. resvg embeds no
   * timestamp, but PNG encoders routinely do, and a rendition that differs byte-for-byte
   * between two runs makes the cache key a lie.
   */
  async toPng(svg: string, width: number): Promise<Buffer> {
    try {
      const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: width } });
      const rendered = resvg.render().asPng();

      return await sharp(rendered)
        .png({ compressionLevel: 9, palette: false })
        .withMetadata({})
        .toBuffer();
    } catch (cause) {
      throw new RenderError(`Rasterizing the SVG failed: ${String(cause)}`, { cause });
    }
  }

  async render(
    element: SatoriElement,
    aspectRatio: AspectRatio,
    options: SatoriRenderOptions = {},
  ): Promise<RenderedImage> {
    const started = Date.now();
    const spec = specFor(aspectRatio);
    const svg = await this.toSvg(element, spec.width, spec.height, options);
    const png = await this.toPng(svg, spec.width);

    return {
      aspectRatio,
      width: spec.width,
      height: spec.height,
      png,
      fittedDown: options.fittedDown ?? [],
      durationMs: Date.now() - started,
    };
  }

  /** SVG only. The composer scales it in the browser; nothing is rasterized. */
  async renderPreview(
    element: SatoriElement,
    aspectRatio: AspectRatio,
    options: SatoriRenderOptions = {},
  ): Promise<RenderedPreview> {
    const started = Date.now();
    const spec = specFor(aspectRatio);
    const width = Math.round(spec.width * PREVIEW_SCALE);
    const height = Math.round(spec.height * PREVIEW_SCALE);

    return {
      aspectRatio,
      width,
      height,
      svg: await this.toSvg(element, width, height, options),
      fittedDown: options.fittedDown ?? [],
      durationMs: Date.now() - started,
    };
  }
}

let cached: SatoriRenderer | undefined;

export function getRenderer(): SatoriRenderer {
  cached ??= new SatoriRenderer();
  return cached;
}
