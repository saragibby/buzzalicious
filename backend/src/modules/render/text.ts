/**
 * Text that a render can and cannot draw.
 *
 * Satori's behaviour for a character no registered font covers is to draw a filled
 * `NO GLYPH` box. That is a successful render — status 200, a PNG in storage, a `Rendition`
 * row — of an image nobody can publish. Nothing downstream would ever notice.
 *
 * So the render path checks text up front and refuses. The rule the brief sets is that
 * overflow and unrenderable content fail loudly, and this is the second half of that.
 *
 * See docs/05 for the curated set's coverage and the emoji decision.
 */

import { emojiDataUri } from './emoji';
import { familyCovers, loadCoverage, type CoverageRange } from './fonts';
import { UnrenderableTextError } from './render.errors';

/**
 * Codepoints that are never drawn and so never need coverage.
 *
 * Whitespace and formatting characters are consumed by layout rather than rendered.
 * ZWJ and the variation selectors are part of emoji sequences and are handled by the
 * emoji lookup, which sees the whole grapheme.
 */
const NON_DRAWING = new Set([
  0x09, 0x0a, 0x0d, 0x20, 0xa0, 0x200b, 0x200c, 0x200d, 0xfe0e, 0xfe0f,
]);

/** Split on grapheme boundaries so an emoji sequence is examined as one unit. */
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function graphemes(text: string): string[] {
  return [...segmenter.segment(text)].map((entry) => entry.segment);
}

function drawnCodepoints(grapheme: string): number[] {
  return [...grapheme].map((char) => char.codePointAt(0) ?? 0).filter((cp) => !NON_DRAWING.has(cp));
}

async function isRenderable(
  grapheme: string,
  families: readonly string[],
  coverage: Map<string, CoverageRange[]>,
): Promise<boolean> {
  const codepoints = drawnCodepoints(grapheme);
  if (codepoints.length === 0) return true;

  if (codepoints.every((cp) => families.some((family) => familyCovers(coverage, family, cp)))) {
    return true;
  }

  // Not in any font. It is renderable only if Twemoji has a picture of it, which is the
  // same lookup Satori's `loadAdditionalAsset` will do during the render itself.
  return (await emojiDataUri(grapheme)) !== undefined;
}

/**
 * The distinct graphemes in `text` that neither the fonts nor Twemoji can draw.
 *
 * Returns them rather than throwing so a caller can report every problem character at
 * once. Deduplicated and order-preserving: a paragraph of Japanese should produce a
 * readable list, not one entry per character.
 */
export async function findUnrenderableGraphemes(
  text: string,
  families: readonly string[],
): Promise<string[]> {
  const coverage = await loadCoverage();
  const unrenderable: string[] = [];
  const seen = new Set<string>();

  for (const grapheme of graphemes(text)) {
    if (seen.has(grapheme)) continue;
    seen.add(grapheme);
    if (!(await isRenderable(grapheme, families, coverage))) unrenderable.push(grapheme);
  }

  return unrenderable;
}

/**
 * Refuse the render if any text cannot be drawn.
 *
 * `field` is the caller's name for where the text came from — a slot key, or a brand
 * field — so the error points at what the user has to change.
 */
export async function assertRenderableText(
  entries: ReadonlyArray<{ field: string; text: string }>,
  families: readonly string[],
): Promise<void> {
  const offences: Array<{ field: string; characters: string[] }> = [];

  for (const { field, text } of entries) {
    const characters = await findUnrenderableGraphemes(text, families);
    if (characters.length > 0) offences.push({ field, characters });
  }

  if (offences.length === 0) return;

  const summary = offences
    .map(({ field, characters }) => `${field} (${characters.join(' ')})`)
    .join('; ');

  throw new UnrenderableTextError(
    `No available font can draw some characters: ${summary}. ` +
      'The curated font set covers Latin scripts and Twemoji covers emoji; other scripts ' +
      'are not supported yet.',
    offences,
  );
}
