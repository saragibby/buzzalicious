import { describe, expect, it } from 'vitest';
import { Platform, TrendStatus, type Trend } from '@prisma/client';
import { explain, freshnessOf, platformFitFor, type BrandFeedContext } from './feed.service';

const BRAND: BrandFeedContext = {
  brandId: 'brand-1',
  brandName: 'Rise & Shore',
  categoryId: 'cat-1',
  categorySlug: 'vacation-rental',
  categoryName: 'Vacation Rental',
  targetPlatforms: [Platform.INSTAGRAM, Platform.FACEBOOK],
};

function trend(overrides: Partial<Trend> = {}): Trend {
  return {
    id: 'trend-1',
    platform: Platform.INSTAGRAM,
    kind: 'FORMAT',
    externalRef: null,
    title: 'Shoulder-season value posts',
    description: null,
    exampleUrls: [],
    firstSeenAt: new Date('2026-02-01T00:00:00Z'),
    lastSeenAt: new Date('2026-02-20T00:00:00Z'),
    peakedAt: null,
    status: TrendStatus.EMERGING,
    velocity: 0.6,
    momentum: 0.7,
    raw: null,
    createdAt: new Date('2026-02-01T00:00:00Z'),
    updatedAt: new Date('2026-02-20T00:00:00Z'),
    ...overrides,
  } as Trend;
}

describe('platformFitFor', () => {
  it('excludes a trend from a platform the brand does not post to', () => {
    // There is no point telling a business about a format they have no account for.
    expect(platformFitFor(Platform.X, BRAND.targetPlatforms)).toBe(0);
  });

  it('includes a trend on a platform the brand does post to', () => {
    expect(platformFitFor(Platform.INSTAGRAM, BRAND.targetPlatforms)).toBe(1);
  });

  it('treats a platform-less trend as fitting everyone', () => {
    expect(platformFitFor(null, BRAND.targetPlatforms)).toBeGreaterThan(0);
  });

  it('does not exclude everything when a brand has chosen no platforms', () => {
    // A brand mid-setup has an empty targetPlatforms array. Scoring that as zero fit
    // would give them a silently empty feed with nothing to explain it.
    expect(platformFitFor(Platform.X, [])).toBeGreaterThan(0);
  });
});

describe('freshnessOf', () => {
  const now = new Date('2026-03-01T00:00:00Z');

  it('prefers a recent observation', () => {
    const recent = freshnessOf(new Date('2026-02-28T00:00:00Z'), now);
    const older = freshnessOf(new Date('2026-02-10T00:00:00Z'), now);

    expect(recent).toBeGreaterThan(older);
  });

  it('floors rather than reaching zero', () => {
    // A zero would annihilate feedScore entirely and make an otherwise strong trend
    // indistinguishable from an irrelevant one.
    expect(freshnessOf(new Date('2025-01-01T00:00:00Z'), now)).toBeGreaterThan(0);
  });
});

describe('explain', () => {
  it('names the category the recommendation is based on', () => {
    const text = explain({ trend: trend(), brand: BRAND, categoryScore: 0.9 });
    expect(text).toContain('Vacation Rental');
  });

  it('says an emerging trend means being early, not popular', () => {
    // The product thesis, stated to the user. Ranking by popularity is what makes a small
    // business look late and identical to everyone else.
    const text = explain({
      trend: trend({ status: TrendStatus.EMERGING }),
      brand: BRAND,
      categoryScore: 0.9,
    });
    expect(text).toContain('early');
  });

  it('frames a peaking trend as a closing window', () => {
    const text = explain({
      trend: trend({ status: TrendStatus.PEAKING }),
      brand: BRAND,
      categoryScore: 0.6,
    });
    expect(text).toContain('window');
  });

  it('quotes the mapping evidence when there is some', () => {
    const text = explain({
      trend: trend(),
      brand: BRAND,
      categoryScore: 0.9,
      reason: 'mentions "shoulder season"',
    });

    expect(text).toContain('shoulder season');
  });

  it('still explains itself when a brand has no category name', () => {
    const text = explain({
      trend: trend(),
      brand: { ...BRAND, categoryName: null },
      categoryScore: 0.5,
    });

    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toContain('null');
  });
});
