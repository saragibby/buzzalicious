import { describe, expect, it } from 'vitest';
import {
  BrandGoalsSchema,
  BrandPaletteSchema,
  BrandTypographySchema,
  BrandVoiceGuideSchema,
} from '../brand/brand.schemas';
import {
  DEFAULT_GOALS,
  DEFAULT_PALETTE,
  DEFAULT_TYPOGRAPHY,
  DEFAULT_VOICE_GUIDE,
  defaultWorkspaceName,
  slugify,
  uniqueSlug,
} from './onboarding';

describe('slugify', () => {
  it('produces a URL-safe slug', () => {
    expect(slugify('Rise & Shore')).toBe('rise-shore');
  });

  it('keeps the letter when stripping an accent', () => {
    // "cafe", not "caf" — dropping the character silently mangles the name.
    expect(slugify('Café Lumière')).toBe('cafe-lumiere');
  });

  it('never leaves a leading or trailing separator', () => {
    expect(slugify('  --Hello--  ')).toBe('hello');
  });

  it('never ends on a separator after truncation', () => {
    // Truncating mid-separator would produce "...-", which is a legal string and a bad URL.
    const slug = slugify(`${'a'.repeat(47)} bbbb`);
    expect(slug.endsWith('-')).toBe(false);
    expect(slug.length).toBeLessThanOrEqual(48);
  });

  it('returns empty rather than punctuation when nothing survives', () => {
    // The caller substitutes a generated slug; "-" or "--" would pass a truthiness check.
    expect(slugify('日本語')).toBe('');
    expect(slugify('!!!')).toBe('');
  });
});

describe('uniqueSlug', () => {
  it('uses the base when it is free', async () => {
    expect(await uniqueSlug('acme', () => Promise.resolve(false))).toBe('acme');
  });

  it('suffixes rather than failing, because this runs during sign-in', async () => {
    const taken = new Set(['acme']);
    expect(await uniqueSlug('acme', (c) => Promise.resolve(taken.has(c)))).toBe('acme-2');
  });

  it('walks past a run of collisions', async () => {
    const taken = new Set(['acme', 'acme-2', 'acme-3']);
    expect(await uniqueSlug('acme', (c) => Promise.resolve(taken.has(c)))).toBe('acme-4');
  });

  it('gives up on counting and randomises, rather than looping forever', async () => {
    // An unbounded retry against a unique constraint is a hang, not a fallback.
    expect(
      await uniqueSlug(
        'acme',
        () => Promise.resolve(true),
        () => 'z9q1x2',
      ),
    ).toBe('acme-z9q1x2');
  });

  it('substitutes a default when the name yields no slug at all', async () => {
    expect(await uniqueSlug('', () => Promise.resolve(false))).toBe('workspace');
  });
});

describe('defaultWorkspaceName', () => {
  it('uses the display name when Google supplies one', () => {
    expect(defaultWorkspaceName({ name: 'Dana Whitlock', email: 'd@x.com' })).toBe(
      "Dana Whitlock's workspace",
    );
  });

  it('falls back to the email local part, which is always present', () => {
    expect(defaultWorkspaceName({ name: null, email: 'dana@x.com' })).toBe("dana's workspace");
    expect(defaultWorkspaceName({ name: '   ', email: 'dana@x.com' })).toBe("dana's workspace");
  });
});

describe('default brand kit', () => {
  it('is valid against every schema it has to satisfy', () => {
    // Brand.palette, typography and voiceGuide are non-nullable and every render path
    // assumes they parse. A default that drifted out of schema would only surface when a
    // template tried to render it.
    expect(() => BrandPaletteSchema.parse(DEFAULT_PALETTE)).not.toThrow();
    expect(() => BrandTypographySchema.parse(DEFAULT_TYPOGRAPHY)).not.toThrow();
    expect(() => BrandVoiceGuideSchema.parse(DEFAULT_VOICE_GUIDE)).not.toThrow();
    expect(() => BrandGoalsSchema.parse(DEFAULT_GOALS)).not.toThrow();
  });

  it('defaults to a font the render pipeline actually ships', () => {
    // Satori has no system font fallback: an unavailable family renders a blank image
    // rather than raising. Inter is what the seed uses for both roles.
    expect(DEFAULT_TYPOGRAPHY.headingFamily).toBe('Inter');
    expect(DEFAULT_TYPOGRAPHY.bodyFamily).toBe('Inter');
  });
});
