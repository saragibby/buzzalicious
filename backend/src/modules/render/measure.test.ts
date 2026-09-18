import { beforeAll, describe, expect, it } from 'vitest';
import { loadMetrics } from './fonts';
import { fitFontSize, measureLine, measureText, wrapText, SAFETY_MARGIN } from './measure';

/**
 * Measurement is where a Satori implementation usually breaks, because Satori offers no
 * measurement API and any independent measurement that drifts from it produces images
 * that clip silently. These tests pin the properties `$fit` depends on.
 */

/**
 * Loaded once for the file. Not top-level `await`: the backend compiles to CommonJS, so
 * `tsc` rejects it even though Vitest runs it happily — a green test run and a red build.
 */
let metrics: Awaited<ReturnType<typeof loadMetrics>>;

beforeAll(async () => {
  metrics = await loadMetrics();
});

const style = { family: 'Inter', weight: 400, fontSize: 40, lineHeight: 1.2 };

describe('measureLine', () => {
  it('scales linearly with font size', () => {
    const at40 = measureLine('Hello world', style, metrics);
    const at80 = measureLine('Hello world', { ...style, fontSize: 80 }, metrics);

    expect(at80).toBeCloseTo(at40 * 2, 5);
  });

  it('uses real per-character advances, not a fixed width', () => {
    // A proportional font must not measure "iiii" and "MMMM" the same. A monospace
    // approximation would, and would then over-fit narrow text and clip wide text.
    expect(measureLine('MMMM', style, metrics)).toBeGreaterThan(
      measureLine('iiii', style, metrics) * 1.5,
    );
  });

  it('measures heavier weights as wider', () => {
    expect(measureLine('Hamburgefonstiv', { ...style, weight: 800 }, metrics)).toBeGreaterThan(
      measureLine('Hamburgefonstiv', { ...style, weight: 400 }, metrics),
    );
  });

  it('errs wide, so a borderline line is treated as overflowing', () => {
    expect(SAFETY_MARGIN).toBeGreaterThan(1);
  });
});

describe('wrapText', () => {
  it('breaks greedily on whitespace', () => {
    const lines = wrapText('one two three four five six', 200, style, metrics);

    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(measureLine(line, style, metrics)).toBeLessThanOrEqual(200);
    }
  });

  it('breaks a single word too long to fit, rather than letting it bleed', () => {
    const lines = wrapText('supercalifragilisticexpialidocious', 120, style, metrics);

    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join('')).toBe('supercalifragilisticexpialidocious');
  });

  it('honours explicit newlines instead of reflowing them away', () => {
    expect(wrapText('first\nsecond\nthird', 10_000, style, metrics)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });
});

describe('measureText', () => {
  it('reports height as lines times font size times line height', () => {
    const measured = measureText('one two three four five', 200, style, metrics);

    expect(measured.height).toBeCloseTo(measured.lines.length * 40 * 1.2, 5);
  });
});

describe('fitFontSize', () => {
  const box = { width: 600, height: 300 };
  const base = { family: 'Inter', weight: 400, lineHeight: 1.2 };

  it('returns the maximum when the text already fits', () => {
    const result = fitFontSize('Short', box, base, { max: 64, min: 24 }, metrics);

    expect(result.fontSize).toBe(64);
    expect(result.shrunk).toBe(false);
    expect(result.overflowPx).toBe(0);
  });

  it('shrinks long text rather than letting it overrun', () => {
    const long = 'word '.repeat(60);
    const result = fitFontSize(long, box, base, { max: 64, min: 8 }, metrics);

    expect(result.shrunk).toBe(true);
    expect(result.fontSize).toBeLessThan(64);
    expect(result.measured.height).toBeLessThanOrEqual(box.height);
  });

  it('finds the true maximum — one size larger does not fit', () => {
    // The property that makes the binary search sound. If this fails, the search is
    // returning a size that merely fits rather than the largest that fits.
    const text = 'word '.repeat(40);
    const result = fitFontSize(text, box, base, { max: 120, min: 8 }, metrics);

    expect(result.measured.height).toBeLessThanOrEqual(box.height);

    const oneLarger = measureText(
      text,
      box.width,
      { ...base, fontSize: result.fontSize + 1 },
      metrics,
    );
    expect(oneLarger.height).toBeGreaterThan(box.height);
  });

  it('reports the overrun instead of shrinking below the stated minimum', () => {
    // Deliberately impossible. An 8px CTA is as unusable as a clipped one, so `$fit`
    // stops at its minimum and says how far short it fell.
    const result = fitFontSize('word '.repeat(200), box, base, { max: 64, min: 48 }, metrics);

    expect(result.fontSize).toBe(48);
    expect(result.overflowPx).toBeGreaterThan(0);
  });

  it('rejects a minimum above its maximum rather than silently swapping them', () => {
    expect(() => fitFontSize('x', box, base, { max: 20, min: 40 }, metrics)).toThrow();
  });
});
