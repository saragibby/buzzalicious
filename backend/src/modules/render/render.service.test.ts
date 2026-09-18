import { describe, expect, it } from 'vitest';
import { cacheKeyFor, loadVersions } from './render.service';
import { RendererMetaSchema } from './rendition.schemas';

/**
 * The parts of the service that need no database. Everything else is exercised in
 * `tests/db/render.test.ts`, behind `TEST_DATABASE_URL`.
 */

const base = {
  templateId: '11111111-1111-1111-1111-111111111111',
  templateVersion: 1,
  brandId: '22222222-2222-2222-2222-222222222222',
  slotValues: { headline: 'Open late on Fridays', cta: 'Book now' },
  aspectRatio: 'SQUARE_1_1' as const,
};

describe('loadVersions', () => {
  it('records a real version for every renderer in the pipeline', () => {
    const versions = loadVersions();

    // The regression this guards: `sharp` does not expose `./package.json` through its
    // `exports` map, so reading the manifest throws and the lookup falls back to
    // "unknown". That still validates, still persists, and quietly makes the column
    // useless for the one job it has — attributing an unexpected pixel change.
    for (const [name, value] of Object.entries(versions)) {
      expect(value, name).not.toBe('unknown');
      expect(value, name).toMatch(/^\d+\.\d+\.\d+/);
    }
  });

  it('produces metadata the Rendition column accepts', () => {
    expect(() => RendererMetaSchema.parse({ ...loadVersions(), templateVersion: 1 })).not.toThrow();
  });
});

describe('cacheKeyFor', () => {
  it('is stable across runs for the same inputs', () => {
    expect(cacheKeyFor(base)).toBe(cacheKeyFor({ ...base }));
  });

  it('ignores the order slot values were written in', () => {
    // Otherwise editing a slot and editing it back produces a cache miss, and the
    // "reopening a post is free" promise in docs/05 quietly stops holding.
    const reordered = { cta: base.slotValues.cta, headline: base.slotValues.headline };

    expect(cacheKeyFor({ ...base, slotValues: reordered })).toBe(cacheKeyFor(base));
  });

  it('changes when any input that affects pixels changes', () => {
    const original = cacheKeyFor(base);

    expect(cacheKeyFor({ ...base, aspectRatio: 'STORY_9_16' })).not.toBe(original);
    expect(cacheKeyFor({ ...base, templateVersion: 2 })).not.toBe(original);
    expect(cacheKeyFor({ ...base, brandId: base.templateId })).not.toBe(original);
    expect(
      cacheKeyFor({ ...base, slotValues: { ...base.slotValues, headline: 'Closed' } }),
    ).not.toBe(original);
  });

  it('does not depend on the platform', () => {
    // Renditions hang off Post, not PostTarget: one render per ratio, reused by every
    // platform that shares it. A platform in the key would multiply the work for
    // byte-identical output.
    expect(cacheKeyFor(base)).not.toContain('INSTAGRAM');
  });
});
