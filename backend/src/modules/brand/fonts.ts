import { ValidationError } from '../../platform/errors';
import { BrandTypographySchema, type BrandTypography } from './brand.schemas';

/**
 * The font families a brand may choose from.
 *
 * ## This is a placeholder for W4's set, and knowingly so
 *
 * W3's brief says typography is selected from "the curated font set W4 ships". W4 is
 * running in parallel and had not landed one at the time this was written, so rather than
 * inventing a competing list this file holds the smallest set that is certainly correct:
 * the two families the W2 seed already uses, which are therefore the two the render
 * pipeline definitely has buffers for.
 *
 * **W4:** replace `FONT_CATALOG` with an import from the render module's own catalogue and
 * delete this file. The typography *contract* is `BrandTypographySchema`, which is W2's
 * and does not change; only the enumeration of allowed families lives here.
 *
 * Why this is enforced at all rather than left as free text: Satori has no system font
 * fallback. A family it cannot resolve does not raise — it renders a blank image. A brand
 * kit that accepted any string would let a user configure their way into silently empty
 * posts, and the failure would surface at publish time.
 *
 * Font *licensing* is Q19 and is not settled here.
 */

export interface FontOption {
  family: string;
  /** Weights available as loaded buffers. Satori takes numeric weights only. */
  weights: readonly number[];
  /** What it is for, shown in the picker. */
  note: string;
}

export const FONT_CATALOG: readonly FontOption[] = [
  {
    family: 'Inter',
    weights: [400, 500, 600, 700],
    note: 'Neutral sans-serif. Reads cleanly at small sizes; safe for body text anywhere.',
  },
  {
    family: 'Fraunces',
    weights: [400, 600, 700, 900],
    note: 'High-contrast serif with warmth. Suits headings for hospitality and lifestyle.',
  },
];

export const FONT_FAMILIES: readonly string[] = FONT_CATALOG.map((font) => font.family);

export function findFont(family: string): FontOption | undefined {
  return FONT_CATALOG.find((font) => font.family === family);
}

/** Why a typography selection is not renderable, or `null` when it is. */
export function describeTypographyProblem(typography: BrandTypography): string | null {
  for (const [role, family, weight] of [
    ['heading', typography.headingFamily, typography.headingWeight],
    ['body', typography.bodyFamily, typography.bodyWeight],
  ] as const) {
    const font = findFont(family);

    if (!font) {
      return `${role} font "${family}" is not one of the available families (${FONT_FAMILIES.join(', ')}).`;
    }

    if (!font.weights.includes(weight)) {
      return `${family} is not available at weight ${weight} (available: ${font.weights.join(', ')}).`;
    }
  }

  return null;
}

/**
 * Parse typography and check the families resolve.
 *
 * Two steps rather than one because they fail for different reasons: the schema rejects a
 * malformed shape, this rejects a well-formed shape naming a font we cannot draw with.
 */
export function parseTypography(value: unknown): BrandTypography {
  const typography = BrandTypographySchema.parse(value);
  const problem = describeTypographyProblem(typography);
  if (problem) {
    throw new ValidationError(problem);
  }
  return typography;
}
