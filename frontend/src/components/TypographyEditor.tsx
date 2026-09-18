import { useMemo } from 'react';
import type { BrandTypography, FontOption } from '../lib/brandApi';

export interface TypographyEditorProps {
  value: BrandTypography;
  fonts: FontOption[];
  onChange: (typography: BrandTypography) => void;
}

/**
 * The typography picker.
 *
 * Families come from the server's catalogue rather than a list in this file, and are a
 * select rather than a text input, because Satori has no system font fallback: an
 * unresolvable family renders a *blank image* instead of raising. A free-text field would
 * let a user type "Helvetica" and discover at publish time that every post since is empty.
 *
 * Weights are filtered per family for the same reason — a family loaded at 400 and asked
 * to render at 800 does not synthesise a bold, it fails.
 */
export function TypographyEditor({ value, fonts, onChange }: TypographyEditorProps) {
  const headingFonts = useMemo(
    () => fonts.filter((font) => font.role === 'heading' || font.role === 'both'),
    [fonts],
  );
  const bodyFonts = useMemo(
    () => fonts.filter((font) => font.role === 'body' || font.role === 'both'),
    [fonts],
  );

  const weightsFor = (family: string) =>
    fonts.find((font) => font.family === family)?.weights ?? [400, 700];

  const changeFamily = (which: 'heading' | 'body', family: string) => {
    const weights = weightsFor(family);
    const currentWeight = which === 'heading' ? value.headingWeight : value.bodyWeight;

    // Snap to the nearest available weight rather than keeping one this family does not
    // ship. Silently keeping it is how a brand ends up rendering nothing.
    const weight = weights.includes(currentWeight)
      ? currentWeight
      : weights.reduce((best, candidate) =>
          Math.abs(candidate - currentWeight) < Math.abs(best - currentWeight) ? candidate : best,
        );

    onChange(
      which === 'heading'
        ? { ...value, headingFamily: family, headingWeight: weight }
        : { ...value, bodyFamily: family, bodyWeight: weight },
    );
  };

  return (
    <fieldset className="brand-section">
      <legend>Typography</legend>

      {fonts.length === 0 && <p className="field-hint">Loading the font list…</p>}

      <div className="type-grid">
        <label className="field">
          <span>Heading font</span>
          <select
            value={value.headingFamily}
            onChange={(event) => changeFamily('heading', event.target.value)}
          >
            {headingFonts.map((font) => (
              <option key={font.family} value={font.family}>
                {font.family}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Heading weight</span>
          <select
            value={value.headingWeight}
            onChange={(event) => onChange({ ...value, headingWeight: Number(event.target.value) })}
          >
            {weightsFor(value.headingFamily).map((weight) => (
              <option key={weight} value={weight}>
                {weight}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Body font</span>
          <select
            value={value.bodyFamily}
            onChange={(event) => changeFamily('body', event.target.value)}
          >
            {bodyFonts.map((font) => (
              <option key={font.family} value={font.family}>
                {font.family}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Body weight</span>
          <select
            value={value.bodyWeight}
            onChange={(event) => onChange({ ...value, bodyWeight: Number(event.target.value) })}
          >
            {weightsFor(value.bodyFamily).map((weight) => (
              <option key={weight} value={weight}>
                {weight}
              </option>
            ))}
          </select>
        </label>
      </div>

      <p
        className="type-preview"
        style={{ fontFamily: `${value.headingFamily}, serif`, fontWeight: value.headingWeight }}
      >
        Your headline looks like this
      </p>
      <p
        className="type-preview-body"
        style={{ fontFamily: `${value.bodyFamily}, sans-serif`, fontWeight: value.bodyWeight }}
      >
        And your body copy looks like this — the text under the headline that actually explains the
        thing.
      </p>
    </fieldset>
  );
}
