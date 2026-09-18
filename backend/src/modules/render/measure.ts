/**
 * Text measurement, line breaking and `$fit`.
 *
 * This is the part of a Satori implementation that usually breaks, because Satori exposes
 * no measurement API: you hand it a tree and get an image back. Anything that needs to
 * know whether text fits *before* rendering has to measure independently, and if that
 * measurement disagrees with Satori's the result is an image that silently clips.
 *
 * So measurement here mirrors what Satori actually does rather than approximating it:
 *
 * - advance widths come from the real font, per weight, via `metrics.json`
 * - line breaking is greedy on whitespace, then per character for a word that cannot fit,
 *   which is Satori's own behaviour
 * - line height is explicit everywhere, because Satori's default varies with the font and
 *   a compiled layout that does not state it cannot be measured reliably
 *
 * Kerning and ligatures are ignored. They are a sub-percent correction on Latin text, and
 * `SAFETY_MARGIN` is wider than the error. The margin errs towards declaring an overflow
 * that Satori would have squeaked through, which is the right direction: a false overflow
 * is a clear message in the composer, a missed one is a clipped CTA in a client's feed.
 */

import { loadMetrics, nearestWeight, type FamilyMetrics } from './fonts';
import { RenderError } from './render.errors';

/**
 * Measured widths are treated as 1.5% wider than calculated.
 *
 * Covers kerning, hinting and rounding differences between this arithmetic and Satori's
 * own layout pass.
 */
export const SAFETY_MARGIN = 1.015;

/** Satori's default when a style does not say. The compiler always says. */
export const DEFAULT_LINE_HEIGHT = 1.2;

/** An emoji is drawn as a square image at the current font size. */
const EMOJI_ADVANCE_EM = 1;

export interface TextStyle {
  family: string;
  weight: number;
  fontSize: number;
  lineHeight?: number;
  /** Extra tracking in ems, matching CSS `letter-spacing` expressed relatively. */
  letterSpacing?: number;
}

export interface MeasuredText {
  lines: string[];
  width: number;
  height: number;
}

function metricsFor(metrics: Map<string, FamilyMetrics>, family: string): FamilyMetrics {
  const entry = metrics.get(family);
  if (!entry) {
    throw new RenderError(
      `No metrics for font family "${family}". It is not in the curated set — see fonts.ts.`,
    );
  }
  return entry;
}

/**
 * The advance width of one character, in ems.
 *
 * A character the font has no width for is either an emoji, drawn as a square image, or
 * genuinely uncoverable — in which case `assertRenderableText` has already refused the
 * render and this is only reached for text that is never shown to a user. Both cases are
 * an em wide, which keeps measurement pessimistic rather than optimistic.
 */
function advanceEm(entry: FamilyMetrics, weight: number, codepoint: number): number {
  const units = entry.widths[weight]?.[codepoint];
  return units === undefined ? EMOJI_ADVANCE_EM : units / entry.unitsPerEm;
}

/** The rendered width of a single line, in pixels, with no wrapping applied. */
export function measureLine(
  text: string,
  style: TextStyle,
  metrics: Map<string, FamilyMetrics>,
): number {
  const entry = metricsFor(metrics, style.family);
  const weight = nearestWeight(style.family, style.weight);
  let ems = 0;

  for (const char of text) {
    ems += advanceEm(entry, weight, char.codePointAt(0) ?? 0);
    if (style.letterSpacing) ems += style.letterSpacing;
  }

  return ems * style.fontSize * SAFETY_MARGIN;
}

/**
 * Break a word that is wider than the whole line.
 *
 * Satori does not let a single long token bleed off the canvas; it breaks it. A URL or an
 * unspaced German compound is the realistic case.
 */
function breakWord(
  word: string,
  maxWidth: number,
  style: TextStyle,
  metrics: Map<string, FamilyMetrics>,
): string[] {
  const pieces: string[] = [];
  let current = '';

  for (const char of word) {
    const candidate = current + char;
    if (current !== '' && measureLine(candidate, style, metrics) > maxWidth) {
      pieces.push(current);
      current = char;
    } else {
      current = candidate;
    }
  }

  if (current !== '') pieces.push(current);
  return pieces;
}

/**
 * Greedy word wrap, matching Satori's line breaking.
 *
 * Explicit newlines in a multiline slot are honoured and wrap independently, so a
 * three-line address does not reflow into a paragraph.
 */
export function wrapText(
  text: string,
  maxWidth: number,
  style: TextStyle,
  metrics: Map<string, FamilyMetrics>,
): string[] {
  const lines: string[] = [];

  for (const paragraph of text.split('\n')) {
    let current = '';

    for (const word of paragraph.split(/\s+/).filter((token) => token !== '')) {
      const candidate = current === '' ? word : `${current} ${word}`;

      if (measureLine(candidate, style, metrics) <= maxWidth) {
        current = candidate;
        continue;
      }

      if (current !== '') lines.push(current);

      if (measureLine(word, style, metrics) > maxWidth) {
        const pieces = breakWord(word, maxWidth, style, metrics);
        lines.push(...pieces.slice(0, -1));
        current = pieces[pieces.length - 1] ?? '';
      } else {
        current = word;
      }
    }

    lines.push(current);
  }

  return lines;
}

/** Wrapped extent of a block of text within `maxWidth`. */
export function measureText(
  text: string,
  maxWidth: number,
  style: TextStyle,
  metrics: Map<string, FamilyMetrics>,
): MeasuredText {
  const lines = wrapText(text, maxWidth, style, metrics);
  const lineHeight = style.lineHeight ?? DEFAULT_LINE_HEIGHT;

  return {
    lines,
    width: Math.max(0, ...lines.map((line) => measureLine(line, style, metrics))),
    height: lines.length * style.fontSize * lineHeight,
  };
}

export interface FitBox {
  width: number;
  height: number;
}

export interface FitResult {
  fontSize: number;
  /** True when the text needed a size below `max` — reported in `Rendition.rendererMeta`. */
  shrunk: boolean;
  /** How far the text still overruns at `min`. Zero when it fits. */
  overflowPx: number;
  measured: MeasuredText;
}

/**
 * The largest font size in `[min, max]` at which `text` fits `box`.
 *
 * Integer binary search. Fitting is monotonic — text that fits at size *n* fits at every
 * smaller size — so this is sound, and it costs ~6 measurements instead of ~40 for a
 * linear walk from `max` down. That difference is most of the `$fit` budget.
 *
 * When nothing in range fits, the result reports the overflow at `min` rather than
 * throwing. The caller decides: a render refuses loudly, a preview may want to show the
 * clipped state. `overflowPx` is the vertical overrun, which is what actually clips;
 * horizontal overrun turns into extra lines via wrapping and so shows up as height.
 */
export function fitFontSize(
  text: string,
  box: FitBox,
  style: Omit<TextStyle, 'fontSize'>,
  bounds: { max: number; min: number },
  metrics: Map<string, FamilyMetrics>,
): FitResult {
  const max = Math.floor(bounds.max);
  const min = Math.max(1, Math.floor(bounds.min));

  if (min > max) {
    throw new RenderError(`$fit(${bounds.max}, ${bounds.min}) has a minimum above its maximum`);
  }

  const fitsAt = (fontSize: number): MeasuredText =>
    measureText(text, box.width, { ...style, fontSize }, metrics);

  let low = min;
  let high = max;
  let best: number | undefined;
  let bestMeasured: MeasuredText | undefined;

  while (low <= high) {
    const mid = (low + high) >> 1;
    const measured = fitsAt(mid);

    if (measured.height <= box.height) {
      best = mid;
      bestMeasured = measured;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  if (best !== undefined && bestMeasured) {
    return { fontSize: best, shrunk: best < max, overflowPx: 0, measured: bestMeasured };
  }

  const measured = fitsAt(min);
  return {
    fontSize: min,
    shrunk: true,
    overflowPx: measured.height - box.height,
    measured,
  };
}

/** Convenience wrapper that loads the manifest itself. */
export async function loadTextMetrics(): Promise<Map<string, FamilyMetrics>> {
  return loadMetrics();
}
