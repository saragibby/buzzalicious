import { describe, expect, it } from 'vitest';
import { contrastRatio } from './contrast';

/**
 * The contrast check exists because a low-contrast palette is invisible in a colour picker
 * and obvious in a published post. These pin the maths against the WCAG reference values,
 * since an off-by-a-gamma error would still produce plausible-looking numbers.
 */
describe('contrastRatio', () => {
  it('reports the maximum ratio for black on white', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
  });

  it('reports 1 for a colour against itself', () => {
    expect(contrastRatio('#b8005c', '#b8005c')).toBeCloseTo(1, 5);
  });

  it('is symmetric', () => {
    // The ratio is a property of the pair, not of which one is "text".
    expect(contrastRatio('#1b4965', '#fdfcf7')).toBeCloseTo(
      contrastRatio('#fdfcf7', '#1b4965'),
      10,
    );
  });

  it('applies the sRGB gamma rather than treating channels as linear', () => {
    // Mid-grey on white is ~3.95:1. A linear (no-gamma) calculation gives ~2.3, which
    // would quietly pass palettes that are genuinely hard to read.
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 1);
  });

  it('puts a readable seeded palette above the 4.5 threshold', () => {
    // Rise & Shore's actual seeded colours. If the seed drifts below this, the warning
    // would fire on the sample data and be trained away as noise.
    expect(contrastRatio('#12222e', '#fdfcf7')).toBeGreaterThan(4.5);
  });
});
