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
  COVERAGE_FILE,
  CURATED_FONTS,
  FONT_ASSET_DIR,
  FONT_SUBSETS,
  fontFileName,
  type CoverageRange,
  type CuratedFont,
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

/**
 * The codepoints a font file can actually draw, read straight out of its `cmap`.
 *
 * Computed here rather than at runtime so the render path never parses a font twice and
 * never depends on Satori's bundled opentype fork, which is a transitive dependency and
 * not ours to rely on.
 */
interface ParsedFont {
  tables: { cmap: { glyphIndexMap: Record<string, number> } };
}

// Satori's own font parser, reached through `require` because it ships no types. Only the
// vendor script touches it; the render path reads the generated manifest instead.
const opentype = require('@shuding/opentype.js') as {
  parse(buffer: ArrayBuffer): ParsedFont;
};

function coverageOf(file: Buffer): number[] {
  const bytes = Uint8Array.prototype.slice.call(file);
  const font = opentype.parse(bytes.buffer as ArrayBuffer);
  return Object.keys(font.tables.cmap.glyphIndexMap)
    .map(Number)
    .sort((a, b) => a - b);
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

        // Weights of one family cover the same characters, so the union across weights is
        // the family's coverage and any single weight would do. Union anyway: a subset
        // that silently loses a glyph at one weight should widen nothing.
        coverage[font.family] = [...new Set([...(coverage[font.family] ?? []), ...coverageOf(file)])];

        process.stdout.write(`${path.basename(target)}\n`);
      }
    }

    const licence = await download(`${CDN}/${font.source}/LICENSE`);
    const licenceFile = path.join(FONT_ASSET_DIR, `${slug}-OFL.txt`);
    await writeFile(licenceFile, licence);
    process.stdout.write(`${path.basename(licenceFile)}\n`);
  }

  const ranges = Object.fromEntries(
    Object.entries(coverage).map(([family, codes]) => [
      family,
      toRanges(codes.sort((a, b) => a - b)),
    ]),
  );
  await writeFile(COVERAGE_FILE, `${JSON.stringify(ranges, null, 2)}\n`);
  process.stdout.write(`${path.basename(COVERAGE_FILE)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
