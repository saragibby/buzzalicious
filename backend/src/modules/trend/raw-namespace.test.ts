import { describe, expect, it } from 'vitest';
import {
  MAPPING_REVIEW_STATUSES,
  readCategoryMapping,
  readCuration,
  writeCategoryMapping,
  writeCuration,
  type TrendCategoryMapping,
} from './trend.schemas';

/**
 * These helpers are the whole compatibility story for storing W9's output without editing
 * W2's schema. If they stop round-tripping, curated angles and mapping provenance are lost
 * silently — the trend still renders, just without the thing that makes it useful.
 */

const ANGLE = 'Post the same view in February and July with the price under each one.';

const MAPPING: TrendCategoryMapping = {
  method: 'rules',
  confidence: 0.82,
  reviewStatus: 'OK',
  mappedAt: '2026-03-01T00:00:00.000Z',
  inputHash: 'abc123',
  evidence: [
    { categorySlug: 'vacation-rental', score: 0.82, reason: 'mentions "shoulder season"' },
  ],
};

describe('raw namespacing', () => {
  it('round-trips curation through raw', () => {
    const raw = writeCuration(null, {
      angles: [{ categorySlug: 'vacation-rental', angle: ANGLE }],
    });

    expect(readCuration(raw)?.angles[0]?.angle).toBe(ANGLE);
  });

  it('round-trips a category mapping through raw', () => {
    const raw = writeCategoryMapping({}, MAPPING);
    expect(readCategoryMapping(raw)).toEqual(MAPPING);
  });

  it('preserves the collector fields already in raw', () => {
    // `raw` belongs to the collector. Clobbering `collectorId` or `fetchedAt` while
    // writing curation would destroy the provenance scoring re-runs depend on.
    const raw = writeCuration(
      { collectorId: 'manual', fetchedAt: '2026-03-01T00:00:00.000Z', sourceNote: 'weekly pass' },
      { angles: [] },
    );

    expect(raw.collectorId).toBe('manual');
    expect(raw.sourceNote).toBe('weekly pass');
  });

  it('keeps curation and mapping independent of each other', () => {
    const raw = writeCategoryMapping(
      writeCuration({}, { angles: [{ categorySlug: 'tax-prep', angle: ANGLE }] }),
      MAPPING,
    );

    expect(readCuration(raw)?.angles).toHaveLength(1);
    expect(readCategoryMapping(raw)?.confidence).toBe(0.82);
  });

  it('returns undefined for malformed raw rather than throwing', () => {
    // `raw` is permissive by contract and may hold anything a collector wrote, including
    // from a newer version of this code. A feed that 500s on one odd row is worse than a
    // feed missing that row.
    expect(readCuration({ curation: 'not an object' })).toBeUndefined();
    expect(readCategoryMapping({ categoryMapping: { method: 'psychic' } })).toBeUndefined();
    expect(readCuration(null)).toBeUndefined();
    expect(readCuration('nonsense')).toBeUndefined();
    expect(readCuration([1, 2, 3])).toBeUndefined();
  });

  it('rejects an angle too short to be a usable idea', () => {
    // "Every surfaced trend carries a concrete suggested angle" is the acceptance
    // criterion. A one-word label satisfies the field but not the user.
    expect(() =>
      writeCuration({}, { angles: [{ categorySlug: 'tax-prep', angle: 'post it' }] }),
    ).toThrow();
  });

  it('exposes review statuses including the two that are sticky', () => {
    expect(MAPPING_REVIEW_STATUSES).toContain('NEEDS_REVIEW');
    expect(MAPPING_REVIEW_STATUSES).toContain('CONFIRMED');
    expect(MAPPING_REVIEW_STATUSES).toContain('REJECTED');
  });
});
