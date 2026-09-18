/**
 * Vendors the curated font set into `backend/assets/fonts/`.
 *
 * The files are committed, so this is not part of the build — it runs when the set in
 * `modules/render/fonts.ts` changes, and its output is reviewed like any other change.
 * Rendering must never depend on a network fetch: it happens on the critical path of a
 * live preview, and a font that fails to arrive renders a blank image rather than an
 * error (docs/05).
 *
 *   npm run fonts:vendor --workspace=backend
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  METRICS_FILE,
  CURATED_FONTS,
  FONT_ASSET_DIR,
  FONT_SUBSETS,
  fontFileName,
  type CoverageRange,
  type CuratedFont,
  type FamilyMetrics,
} from '../src/modules/render/fonts';

const CDN = 'https://cdn.jsdelivr.net/npm';

/** Fontsource names files by its own package slug, which is not our family name. */
function fontsourceSlug(font: CuratedFont): string {
  const withoutScope = font.source.replace('@fontsource/', '');
  return withoutScope.split('@')[0];
}

async function download(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GET ${url} -> ${response.status} ${response.statusText}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

interface ParsedGlyph {
  advanceWidth?: number;
}

interface ParsedFont {
  unitsPerEm: number;
  ascender: number;
  descender: number;
  glyphs: { get(index: number): ParsedGlyph | undefined };
  tables: { cmap: { glyphIndexMap: Record<string, number> } };
}

// Satori's own font parser, reached through `require` because it ships no types. Only the
// vendor script touches it; the render path reads the generated manifest instead.
const opentype = require('@shuding/opentype.js') as {
  parse(buffer: ArrayBuffer): ParsedFont;
};

/**
 * What a font file can draw, and how wide each character is.
 *
 * Both are read here rather than at runtime, for the same two reasons. The render path
 * should never parse ~830KB of fonts just to decide whether a headline fits — `$fit`
 * binary-searches font sizes and would re-measure on every step. And the only font parser
 * to hand is Satori's bundled opentype fork, a transitive dependency not ours to rely on.
 *
 * Advance widths are in font units; dividing by `unitsPerEm` gives ems, which scale
 * linearly with font size. Kerning is ignored — it is a sub-percent correction and
 * `measure.ts` carries a safety margin that covers it.
 */
function readFont(file: Buffer): {
  codepoints: number[];
  widths: Record<number, number>;
  unitsPerEm: number;
  ascender: number;
  descender: number;
} {
  const bytes = Uint8Array.prototype.slice.call(file);
  const font = opentype.parse(bytes.buffer as ArrayBuffer);
  const map = font.tables.cmap.glyphIndexMap;
  const widths: Record<number, number> = {};

  for (const [codepoint, glyphIndex] of Object.entries(map)) {
    const advance = font.glyphs.get(glyphIndex)?.advanceWidth;
    if (advance !== undefined) widths[Number(codepoint)] = advance;
  }

  return {
    codepoints: Object.keys(map).map(Number),
    widths,
    unitsPerEm: font.unitsPerEm,
    ascender: font.ascender,
    descender: font.descender,
  };
}

/** Codepoints collapse into ranges: ~370 per subset becomes a few dozen pairs. */
function toRanges(codepoints: number[]): CoverageRange[] {
  const ranges: CoverageRange[] = [];

  for (const code of codepoints) {
    const last = ranges[ranges.length - 1];
    if (last && code === last[1] + 1) last[1] = code;
    else ranges.push([code, code]);
  }

  return ranges;
}

async function main(): Promise<void> {
  await mkdir(FONT_ASSET_DIR, { recursive: true });
  const metrics: Record<string, FamilyMetrics> = {};
  const coverage: Record<string, number[]> = {};

  for (const font of CURATED_FONTS) {
    const slug = fontsourceSlug(font);

    for (const weight of font.weights) {
      // Both subsets, because they are complementary rather than nested: `latin-ext`
      // starts at U+0100 and contains no A-Z, so a font built from it alone renders
      // every ASCII character as a crossed box. See `fonts.ts`.
      for (const subset of FONT_SUBSETS) {
        const url = `${CDN}/${font.source}/files/${slug}-${subset}-${weight}-normal.woff`;
        const target = path.join(FONT_ASSET_DIR, fontFileName(font.family, weight, subset));
        const file = await download(url);
        await writeFile(target, file);

        const parsed = readFont(file);

        // Weights of one family cover the same characters, so the union across weights is
        // the family's coverage and any single weight would do. Union anyway: a subset
        // that silently loses a glyph at one weight should widen nothing.
        coverage[font.family] = [...new Set([...(coverage[font.family] ?? []), ...parsed.codepoints])];

        const entry = (metrics[font.family] ??= {
          unitsPerEm: parsed.unitsPerEm,
          ascender: parsed.ascender,
          descender: parsed.descender,
          coverage: [],
          widths: {},
        });
        // Subsets of one weight are disjoint, so this merges rather than overwrites.
        entry.widths[weight] = { ...entry.widths[weight], ...parsed.widths };

        process.stdout.write(`${path.basename(target)}\n`);
      }
    }

    const licence = await download(`${CDN}/${font.source}/LICENSE`);
    const licenceFile = path.join(FONT_ASSET_DIR, `${slug}-OFL.txt`);
    await writeFile(licenceFile, licence);
    process.stdout.write(`${path.basename(licenceFile)}\n`);
  }

  for (const [family, codes] of Object.entries(coverage)) {
    metrics[family].coverage = toRanges(codes.sort((a, b) => a - b));
  }

  await writeFile(METRICS_FILE, `${JSON.stringify(metrics)}\n`);
  process.stdout.write(`${path.basename(METRICS_FILE)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
