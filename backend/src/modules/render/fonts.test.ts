import { describe, expect, it } from 'vitest';
import { access } from 'node:fs/promises';
import path from 'node:path';
import {
  CURATED_FONTS,
  FONT_ASSET_DIR,
  FONT_SUBSETS,
  fontFamilyStack,
  fontFileName,
  loadFonts,
  loadMetrics,
  nearestWeight,
  satoriFamilyName,
} from './fonts';

/**
 * The curated set is a cross-workstream contract: W3's typography picker offers exactly
 * these families, so a family that is listed but not shipped becomes a brand the renderer
 * cannot draw.
 */

describe('CURATED_FONTS', () => {
  it('ships every weight of every family it advertises', async () => {
    for (const font of CURATED_FONTS) {
      for (const weight of font.weights) {
        for (const subset of FONT_SUBSETS) {
          const file = path.join(FONT_ASSET_DIR, fontFileName(font.family, weight, subset));
          await expect(
            access(file),
            `${font.family} ${weight} ${subset} is advertised but not vendored`,
          ).resolves.toBeUndefined();
        }
      }
    }
  });

  it('is entirely open-licensed', () => {
    // Licensing is Q19 and not W4's to settle, but shipping something encumbered is not a
    // decision to defer either. Every family here is SIL OFL.
    for (const font of CURATED_FONTS) {
      expect(font.licence, font.family).toBe('OFL-1.1');
    }
  });

  it('offers a usable family for both heading and body roles', () => {
    // W3's typography picker filters on this, so a role with nothing in it is a picker
    // with an empty dropdown.
    const usableFor = (role: 'heading' | 'body'): number =>
      CURATED_FONTS.filter((font) => font.role === role || font.role === 'both').length;

    expect(usableFor('heading')).toBeGreaterThan(0);
    expect(usableFor('body')).toBeGreaterThan(0);
  });

  it('has unique family names', () => {
    const families = CURATED_FONTS.map((font) => font.family);

    expect(new Set(families).size).toBe(families.length);
  });
});

describe('fontFamilyStack', () => {
  /**
   * The bug this pins cost a debugging session. Registering both unicode subsets under one
   * family name looks tidier and silently drops every character outside `latin`: Satori
   * resolves a text run to a single face per family, so "Łódź" renders as a NO GLYPH box
   * followed by "ódź". The subsets must be distinct families joined by a CSS fallback list.
   */
  it('names every subset, quoted, in order', () => {
    expect(fontFamilyStack('Inter')).toBe('"Inter", "Inter Ext"');
  });

  it('keeps the bare family name for the primary subset', () => {
    // So that `Brand.typography.headingFamily` is itself a real Satori family.
    expect(satoriFamilyName('Inter', 'latin')).toBe('Inter');
    expect(satoriFamilyName('Inter', 'latin-ext')).toBe('Inter Ext');
  });
});

describe('nearestWeight', () => {
  it('snaps to the closest shipped weight', () => {
    // Satori has no synthetic bolding: an unshipped weight silently renders as whichever
    // face it does have, so picking deliberately beats picking accidentally.
    expect(nearestWeight('Inter', 500)).toBe(400);
    expect(nearestWeight('Inter', 900)).toBe(800);
  });

  it('refuses a family that is not in the curated set', () => {
    expect(() => nearestWeight('Comic Sans MS', 400)).toThrow(/curated font set/i);
  });
});

describe('loadFonts', () => {
  it('registers every family and subset Satori will be asked for', async () => {
    const fonts = await loadFonts();
    const names = new Set(fonts.map((font) => font.name));

    for (const font of CURATED_FONTS) {
      for (const subset of FONT_SUBSETS) {
        expect(names).toContain(satoriFamilyName(font.family, subset));
      }
    }
  });
});

describe('metrics', () => {
  it('covers ASCII and the Central European letters the subsets exist for', async () => {
    const metrics = await loadMetrics();
    const inter = metrics.get('Inter');

    expect(inter).toBeDefined();

    const covered = (codepoint: number): boolean =>
      inter!.coverage.some(([first, last]) => codepoint >= first && codepoint <= last);

    // 'H' and 'a' come from `latin`; 'Ł' from `latin-ext`. The first vendoring shipped
    // only `latin-ext` and rendered every ASCII character as a box, because the Google
    // subsets are complementary rather than nested.
    for (const char of 'Ha1?éñŁżź') {
      expect(covered(char.codePointAt(0)!), `Inter should cover ${char}`).toBe(true);
    }
  });

  it('records advance widths for every shipped weight', async () => {
    const metrics = await loadMetrics();

    for (const font of CURATED_FONTS) {
      const entry = metrics.get(font.family);
      expect(entry, font.family).toBeDefined();
      expect(entry!.unitsPerEm).toBeGreaterThan(0);

      for (const weight of font.weights) {
        expect(
          Object.keys(entry!.widths[weight] ?? {}).length,
          `${font.family} ${weight}`,
        ).toBeGreaterThan(0);
      }
    }
  });
});
