import { describe, expect, it } from 'vitest';
import {
  DEFERRED,
  parseFit,
  resolveContent,
  resolveStyle,
  resolveStyleValue,
  scaleValue,
  type BrandKit,
  type ResolveContext,
} from './bindings';
import { REFERENCE_WIDTH } from './renderer';

const brand: BrandKit = {
  palette: {
    primary: '#1b4332',
    secondary: '#2d6a4f',
    accent: '#f4a259',
    neutral: '#d8d5cd',
    background: '#fdfcf7',
    text: '#12222e',
  },
  typography: {
    headingFamily: 'Fraunces',
    bodyFamily: 'Inter',
    headingWeight: 700,
    bodyWeight: 400,
    headingTransform: 'uppercase',
  },
  logo: 'data:image/png;base64,AAAA',
};

const context: ResolveContext = {
  brand,
  slots: { headline: 'Open late on Fridays' },
  canvasWidth: REFERENCE_WIDTH,
};

describe('scaleValue', () => {
  it('is identity at the reference width', () => {
    expect(scaleValue(72, REFERENCE_WIDTH)).toBe(72);
  });

  it('scales proportionally to the canvas', () => {
    // What makes one layout serve four ratios, and a third-size preview the same design
    // rather than a different one.
    expect(scaleValue(72, REFERENCE_WIDTH * 2)).toBe(144);
    expect(scaleValue(72, REFERENCE_WIDTH / 2)).toBe(36);
  });
});

describe('resolveStyleValue', () => {
  it('passes literals through untouched', () => {
    expect(resolveStyleValue(24, context)).toBe(24);
    expect(resolveStyleValue('center', context)).toBe('center');
  });

  it('resolves palette bindings', () => {
    expect(resolveStyleValue('$brand.palette.primary', context)).toBe('#1b4332');
  });

  it('resolves a font family to a fallback list naming every subset', () => {
    expect(resolveStyleValue('$brand.typography.headingFamily', context)).toBe(
      '"Fraunces", "Fraunces Ext"',
    );
  });

  it('resolves non-family typography values as-is', () => {
    expect(resolveStyleValue('$brand.typography.headingWeight', context)).toBe('700');
  });

  it('resolves slot bindings', () => {
    expect(resolveStyleValue('$slot.headline', context)).toBe('Open late on Fridays');
  });

  it('defers $fit to the layout pass, which knows the box', () => {
    expect(resolveStyleValue('$fit(64, 32)', context)).toBe(DEFERRED);
  });

  it('throws on an unknown binding rather than rendering it as text', () => {
    // The failure this prevents is the literal string "$brand.palete.text" baked into a
    // published image. W2's schema catches it at authoring time; this is the second line.
    expect(() => resolveStyleValue('$brand.palete.text', context)).toThrow();
    expect(() => resolveStyleValue('$nonsense(1)', context)).toThrow();
  });

  it('throws when a brand is missing a colour the layout binds', () => {
    expect(() => resolveStyleValue('$brand.palette.tertiary', context)).toThrow(/tertiary/);
  });

  it('resolves a missing slot to empty rather than to its own binding text', () => {
    expect(resolveStyleValue('$slot.absent', context)).toBe('');
  });
});

describe('resolveStyle', () => {
  it('separates resolved properties from deferred ones', () => {
    const { style, deferred } = resolveStyle(
      { color: '$brand.palette.text', padding: '$scale(48)', fontSize: '$fit(64, 32)' },
      context,
    );

    expect(style).toEqual({ color: '#12222e', padding: 48 });
    expect(deferred).toEqual(['fontSize']);
  });
});

describe('parseFit', () => {
  it('reads both bounds, tolerating whitespace', () => {
    expect(parseFit('$fit(64, 32)')).toEqual({ max: 64, min: 32 });
    expect(parseFit('$fit( 180 , 96 )')).toEqual({ max: 180, min: 96 });
  });

  it('returns nothing for anything else', () => {
    expect(parseFit('$scale(48)')).toBeUndefined();
    expect(parseFit(24)).toBeUndefined();
  });
});

describe('resolveContent', () => {
  it('resolves a slot binding', () => {
    expect(resolveContent('$slot.headline', context)).toBe('Open late on Fridays');
  });

  it('leaves literal copy baked into the template alone', () => {
    expect(resolveContent('Book now', context)).toBe('Book now');
  });
});
