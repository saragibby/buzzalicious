/**
 * The curated font set.
 *
 * Satori has no system font fallback and no web font loading: every font must be handed
 * to it as an explicit buffer, and a family it cannot resolve renders as *nothing* rather
 * than raising. So the set of fonts that exist is a closed list, defined here, and
 * `Brand.typography` may only name a family in it.
 *
 * W3's typography picker consumes `CURATED_FONTS` — family, weights, role and the
 * human-facing description are all here so the picker never hardcodes a parallel list
 * that can drift out of step with what actually renders.
 *
 * ## Why static WOFF and not variable TTF
 *
 * Every one of these families ships from Google Fonts as a *variable* TTF, and Satori's
 * bundled `@shuding/opentype.js` throws parsing the `fvar` table on all of them:
 *
 *     TypeError: Cannot read properties of undefined (reading '256')
 *         at parseFvarAxis (@shuding/opentype.js/dist/opentype.js:10285)
 *
 * It is not a soft failure or a wrong-weight render; the renderer dies. So we vendor
 * per-weight *static* WOFF files from Fontsource instead, which Satori parses happily and
 * which make `fontWeight` actually select a different face. Do not replace these with the
 * upstream variable files.
 *
 * ## Licensing
 *
 * Every family here is SIL Open Font License 1.1, which explicitly permits embedding and
 * redistribution — the only licence class picked while Q19 (font licensing) is open. Each
 * family's `OFL.txt` is vendored beside its files. A family whose licence is unclear does
 * not ship; it gets flagged instead.
 *
 * ## Coverage, and why each weight is two files
 *
 * Google Fonts splits a family into complementary unicode subsets, and `latin-ext` is
 * **not** a superset of `latin` — it holds U+0100 and up and contains no A–Z at all. A
 * font built from it alone renders every ASCII character as `.notdef`, which Satori draws
 * as a crossed box. So both subsets ship per weight and Satori falls back between them
 * per glyph.
 *
 * Together they cover ASCII, the accented Latin range and Central European letters, so
 * "café", "Muñoz" and "Łódź" all render. Non-Latin scripts do not, and Satori's behaviour
 * for an uncoverable glyph is to draw nothing — `assertRenderableText` turns that into a
 * loud failure instead. See docs/05.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { RenderError } from './render.errors';

/** Where the vendored files live, relative to the compiled or source module. */
export const FONT_ASSET_DIR = path.resolve(__dirname, '../../../assets/fonts');

/**
 * Satori types `weight` as a union of the nine CSS steps rather than `number`, so the
 * manifest uses the same union. It also means a typo'd weight fails to compile instead of
 * silently falling back to the nearest loaded face at render time.
 */
export type FontWeight = 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900;

export type FontRole = 'heading' | 'body' | 'both';
export type FontClassification = 'sans' | 'serif' | 'display';

export interface CuratedFont {
  /** The name a `Brand.typography.*Family` must use, and the name Satori matches on. */
  family: string;
  role: FontRole;
  classification: FontClassification;
  /** Shown in W3's typography picker. Written for a small business owner, not a typographer. */
  description: string;
  /** Weights we ship. `fontWeight` outside this list snaps to the nearest one. */
  weights: FontWeight[];
  licence: 'OFL-1.1';
  /** The Fontsource package the vendored files came from. `scripts/vendor-fonts.ts` reads this. */
  source: string;
}

export const CURATED_FONTS: CuratedFont[] = [
  {
    family: 'Inter',
    role: 'both',
    classification: 'sans',
    description: 'Clean and neutral. The safe default — readable at any size, on any ratio.',
    weights: [400, 600, 700, 800],
    licence: 'OFL-1.1',
    source: '@fontsource/inter@5.3.0',
  },
  {
    family: 'Fraunces',
    role: 'heading',
    classification: 'serif',
    description: 'Warm and characterful. Good for food, hospitality and anything hand-made.',
    weights: [400, 600, 700, 900],
    licence: 'OFL-1.1',
    source: '@fontsource/fraunces@5.3.0',
  },
  {
    family: 'Playfair Display',
    role: 'heading',
    classification: 'serif',
    description: 'High-contrast and elegant. Suits beauty, interiors and premium services.',
    weights: [400, 700, 800],
    licence: 'OFL-1.1',
    source: '@fontsource/playfair-display@5.3.0',
  },
  {
    family: 'Space Grotesk',
    role: 'both',
    classification: 'sans',
    description: 'Technical and a little quirky. Fits trades, software and modern retail.',
    weights: [400, 500, 700],
    licence: 'OFL-1.1',
    source: '@fontsource/space-grotesk@5.3.0',
  },
  {
    family: 'Bebas Neue',
    role: 'heading',
    classification: 'display',
    description: 'Tall, condensed capitals. Built for one big number or three loud words.',
    weights: [400],
    licence: 'OFL-1.1',
    source: '@fontsource/bebas-neue@5.3.0',
  },
];

export const CURATED_FONT_FAMILIES: string[] = CURATED_FONTS.map((font) => font.family);

export function findCuratedFont(family: string): CuratedFont | undefined {
  return CURATED_FONTS.find((font) => font.family === family);
}

export function isCuratedFamily(family: string): boolean {
  return findCuratedFont(family) !== undefined;
}

/** The unicode subsets shipped per weight. Order matters: Satori falls back left to right. */
export const FONT_SUBSETS = ['latin', 'latin-ext'] as const;
export type FontSubset = (typeof FONT_SUBSETS)[number];

/** `Inter` at 700, latin → `inter-700-latin.woff`. The vendor script writes the same name. */
export function fontFileName(family: string, weight: number, subset: FontSubset): string {
  return `${family.toLowerCase().replace(/\s+/g, '-')}-${weight}-${subset}.woff`;
}

/**
 * Snap an arbitrary CSS weight to a weight we actually ship.
 *
 * Satori matches weights itself, but only among the faces it was given: asking for 500
 * when we loaded 400 and 700 does not interpolate, it picks one. Doing the snapping here
 * means the choice is ours and is visible in `rendererMeta.fonts` rather than being an
 * undocumented library behaviour.
 */
export function nearestWeight(font: CuratedFont, weight: number): FontWeight {
  return font.weights.reduce((best, candidate) =>
    Math.abs(candidate - weight) < Math.abs(best - weight) ? candidate : best,
  );
}

/** The shape Satori's `fonts` option takes. */
export interface LoadedFont {
  name: string;
  data: Buffer;
  weight: FontWeight;
  style: 'normal';
}

let cache: LoadedFont[] | undefined;

/**
 * Load every curated face into memory, once.
 *
 * Called at worker start so that rendering never touches the filesystem: a render is on
 * the critical path of a live preview, and 15 file reads per keystroke is not a budget
 * anyone should be spending. A missing file throws — Satori's own failure mode for a
 * missing font is a blank image, which is precisely the silent corruption this avoids.
 */
export async function loadFonts(): Promise<LoadedFont[]> {
  if (cache) return cache;

  const loaded: LoadedFont[] = [];
  const missing: string[] = [];

  for (const font of CURATED_FONTS) {
    for (const weight of font.weights) {
      for (const subset of FONT_SUBSETS) {
        const file = path.join(FONT_ASSET_DIR, fontFileName(font.family, weight, subset));
        try {
          loaded.push({ name: font.family, data: await readFile(file), weight, style: 'normal' });
        } catch {
          missing.push(path.relative(FONT_ASSET_DIR, file));
        }
      }
    }
  }

  if (missing.length > 0) {
    throw new RenderError(
      `Missing vendored font files: ${missing.join(', ')}. ` +
        'Run `npm run fonts:vendor --workspace=backend` to restore them.',
    );
  }

  cache = loaded;
  return cache;
}

/** Test-only. */
export function resetFontCacheForTests(): void {
  cache = undefined;
}
