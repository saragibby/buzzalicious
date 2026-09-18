/**
 * `TemplateLayout` JSON → a Satori element tree.
 *
 * One layout renders four ratios. That works because nothing in a template is expressed in
 * absolute pixels: dimensions are `$scale(n)` against a 1080px reference canvas, and font
 * sizes that must adapt are `$fit(max, min)`, solved here against the box the text
 * actually lands in.
 *
 * Two things this file is deliberate about:
 *
 * **Vertical distribution is explicit.** The hand-translated step-1 sample had
 * `justifyContent: center` fighting an `auto` margin, and the result was a composition
 * that looked almost right and moved when the copy changed. Every stack gets an explicit
 * `display: flex` and direction, and nothing relies on Satori's defaults.
 *
 * **Overflow raises.** `$fit` shrinks text to its stated minimum; if it still does not
 * fit, the compiler collects the overrun and the caller throws `RenderOverflowError`. It
 * does not clip, and it does not shrink past the minimum — an unreadable 8px CTA is the
 * same failure as a clipped one, just harder to notice.
 */

import type { AspectRatio } from '@prisma/client';
import type { LayoutNode, TemplateLayout } from '../template/template.schemas';
import {
  parseFit,
  resolveContent,
  resolveStyle,
  scaleValue,
  type BrandKit,
  type ResolveContext,
} from './bindings';
import { fontFamilyStack, nearestWeight } from './fonts';
import { fitFontSize, measureText, DEFAULT_LINE_HEIGHT } from './measure';
import type { FamilyMetrics } from './fonts';
import { RenderError, type OverflowDetail } from './render.errors';
import { contentBox } from './safe-area';
import type { SatoriElement } from './satori-renderer';

export interface CompileInput {
  layout: TemplateLayout;
  brand: BrandKit;
  /** Text slot values, already validated against the template's `slotSchema`. */
  slots: Record<string, string>;
  /** Image slot values, resolved to data URIs by `assets.ts`. */
  images?: Record<string, string>;
  aspectRatio: AspectRatio;
  metrics: Map<string, FamilyMetrics>;
  /** Fraction of full size. Previews compile at `PREVIEW_SCALE`; renders at 1. */
  scale?: number;
}

export interface CompileResult {
  element: SatoriElement;
  /** Node ids whose text `$fit` had to shrink. Recorded in `Rendition.rendererMeta`. */
  fittedDown: string[];
  /** Non-empty means the render must be refused. */
  overflows: OverflowDetail[];
}

/**
 * The share of a stack's cross-axis a child may claim when solving `$fit`.
 *
 * A column stack splits its height between children, and the compiler does not run
 * Satori's flex solver, so it cannot know the exact split before laying out. Giving each
 * text node an equal share of the remaining height is pessimistic — it under-fits a
 * headline paired with a short caption — but it never over-fits, and over-fitting is what
 * produces a clipped image. `$fit` bounds keep the error visually small.
 */
function shareOf(available: number, siblings: number): number {
  return siblings > 0 ? available / siblings : available;
}

interface Frame {
  width: number;
  height: number;
}

function countTextChildren(node: LayoutNode): number {
  if (node.type !== 'stack') return 0;
  return node.children.filter((child) => child.type === 'text').length;
}

export function compileLayout(input: CompileInput): CompileResult {
  const scale = input.scale ?? 1;
  const box = contentBox(input.layout, input.aspectRatio);
  const canvasWidth = Math.round(box.width * scale);

  const context: ResolveContext = {
    brand: input.brand,
    slots: input.slots,
    canvasWidth,
  };

  const fittedDown: string[] = [];
  const overflows: OverflowDetail[] = [];

  const compileNode = (node: LayoutNode, frame: Frame): SatoriElement => {
    const { style } = resolveStyle(node.style, context);

    switch (node.type) {
      case 'stack':
        return compileStack(node, frame, style);
      case 'text':
        return compileText(node, frame, style);
      case 'image':
        return compileImage(node, style);
      case 'logo':
        return compileLogo(style);
    }
  };

  const compileStack = (
    node: Extract<LayoutNode, { type: 'stack' }>,
    frame: Frame,
    style: Record<string, unknown>,
  ): SatoriElement => {
    const gap = typeof style.gap === 'number' ? style.gap : 0;
    const padding = typeof style.padding === 'number' ? style.padding : 0;
    const textChildren = countTextChildren(node);

    // What a child can occupy, before flex distributes anything. Gaps and padding come off
    // the top so `$fit` does not solve for space that is already spoken for.
    const inner: Frame = {
      width: Math.max(1, frame.width - padding * 2),
      height: Math.max(1, frame.height - padding * 2 - gap * Math.max(0, node.children.length - 1)),
    };

    const childFrame: Frame =
      node.direction === 'column'
        ? { width: inner.width, height: shareOf(inner.height, Math.max(1, textChildren)) }
        : { width: shareOf(inner.width, node.children.length), height: inner.height };

    return {
      type: 'div',
      props: {
        style: {
          display: 'flex',
          flexDirection: node.direction,
          ...style,
        },
        children: node.children.map((child) => compileNode(child, childFrame)),
      },
    };
  };

  const compileText = (
    node: Extract<LayoutNode, { type: 'text' }>,
    frame: Frame,
    style: Record<string, unknown>,
  ): SatoriElement => {
    const text = resolveContent(node.content, context);
    const family = familyOf(style, input.brand);
    const weight = nearestWeight(family, Number(style.fontWeight ?? 400));
    const lineHeight = typeof style.lineHeight === 'number' ? style.lineHeight : DEFAULT_LINE_HEIGHT;
    const letterSpacing =
      typeof style.letterSpacing === 'number' ? style.letterSpacing : undefined;

    const fit = parseFit(node.style?.fontSize);
    let fontSize: number;

    if (fit) {
      const result = fitFontSize(
        text,
        frame,
        { family, weight, lineHeight, letterSpacing },
        { max: scaleValue(fit.max, canvasWidth), min: scaleValue(fit.min, canvasWidth) },
        input.metrics,
      );

      fontSize = result.fontSize;
      if (result.shrunk) fittedDown.push(node.id ?? node.content);
      if (result.overflowPx > 0) {
        overflows.push({
          node: node.id ?? node.content,
          slot: node.content.startsWith('$slot.')
            ? node.content.slice('$slot.'.length)
            : undefined,
          overflowPx: result.overflowPx,
          minFontSize: scaleValue(fit.min, canvasWidth),
        });
      }
    } else {
      fontSize = typeof style.fontSize === 'number' ? style.fontSize : 16;

      // A fixed size cannot adapt, so it can only be checked.
      const measured = measureText(
        text,
        frame.width,
        { family, weight, fontSize, lineHeight, letterSpacing },
        input.metrics,
      );

      if (measured.height > frame.height) {
        overflows.push({
          node: node.id ?? node.content,
          slot: node.content.startsWith('$slot.')
            ? node.content.slice('$slot.'.length)
            : undefined,
          overflowPx: measured.height - frame.height,
        });
      }
    }

    return {
      type: 'div',
      props: {
        style: {
          display: 'flex',
          ...style,
          fontFamily: fontFamilyStack(family),
          fontSize,
          lineHeight,
        },
        children: applyTransform(text, input.brand, style),
      },
    };
  };

  const compileImage = (
    node: Extract<LayoutNode, { type: 'image' }>,
    style: Record<string, unknown>,
  ): SatoriElement => {
    const slot = node.source.slice('$slot.'.length);
    const src = input.images?.[slot];

    if (!src) {
      throw new RenderError(
        `Image slot "${slot}" has no resolved asset. Images must be resolved to data URIs ` +
          'before compiling — Satori performs no I/O.',
      );
    }

    return {
      type: 'img',
      props: { src, style: { objectFit: 'cover', ...style } },
    };
  };

  const compileLogo = (style: Record<string, unknown>): SatoriElement => {
    // A brand without a logo renders the rest of the design rather than failing. Templates
    // place the logo as a finishing touch, and refusing the whole image over a missing one
    // blocks a workspace from publishing anything at all until they upload it.
    if (!input.brand.logo) {
      return { type: 'div', props: { style: { display: 'flex' } } };
    }

    return {
      type: 'img',
      props: { src: input.brand.logo, style: { objectFit: 'contain', ...style } },
    };
  };

  const root = compileNode(input.layout.root, { width: canvasWidth, height: Math.round(box.height * scale) });

  return {
    element: wrapInCanvas(root, input.aspectRatio, input.layout, scale),
    fittedDown,
    overflows,
  };
}

function familyOf(style: Record<string, unknown>, brand: BrandKit): string {
  const raw = style.fontFamily;
  if (typeof raw !== 'string' || raw === '') return brand.typography.bodyFamily;

  // `$brand.typography.*Family` already resolved to a quoted fallback list; the first
  // entry is the family whose metrics apply.
  const first = raw.split(',')[0].trim().replace(/^["']|["']$/g, '');
  return first;
}

/** Satori has no `text-transform`, so the brand's heading transform is applied to the string. */
function applyTransform(text: string, brand: BrandKit, style: Record<string, unknown>): string {
  const isHeading =
    typeof style.fontFamily === 'string' &&
    style.fontFamily.includes(brand.typography.headingFamily);

  if (!isHeading) return text;

  switch (brand.typography.headingTransform) {
    case 'uppercase':
      return text.toUpperCase();
    case 'lowercase':
      return text.toLowerCase();
    default:
      return text;
  }
}

/**
 * The safe area, as a positioned frame around the compiled root.
 *
 * The outer div is the full canvas so the background reaches the edges; the inner one is
 * inset by the safe area so content does not. Padding the root instead would leave the
 * platform's chrome sitting on the template's own background colour, which is the
 * intended look.
 */
function wrapInCanvas(
  root: SatoriElement,
  aspectRatio: AspectRatio,
  layout: TemplateLayout,
  scale: number,
): SatoriElement {
  const box = contentBox(layout, aspectRatio);
  const inset = {
    top: Math.round(box.top * scale),
    left: Math.round(box.left * scale),
    width: Math.round(box.width * scale),
    height: Math.round(box.height * scale),
  };

  const rootStyle = (root.props.style ?? {}) as Record<string, unknown>;

  return {
    type: 'div',
    props: {
      style: {
        display: 'flex',
        width: '100%',
        height: '100%',
        position: 'relative',
        // The root's own background fills the whole canvas, including under the chrome.
        backgroundColor: rootStyle.backgroundColor ?? '#ffffff',
      },
      children: [
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              position: 'absolute',
              top: inset.top,
              left: inset.left,
              width: inset.width,
              height: inset.height,
            },
            children: [
              {
                ...root,
                props: {
                  ...root.props,
                  style: { width: '100%', height: '100%', ...rootStyle },
                },
              },
            ],
          },
        },
      ],
    },
  };
}
