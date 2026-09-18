import { describe, expect, it } from 'vitest';
import { makeTarget } from '../../../tests/fixtures/target-outcome';
import { scoreArchetypes } from './archetype.service';
import { explain } from './explanation';
import { shrink, type PriorSource, type ShrunkScore } from './shrinkage';

function score(
  observed: number | null,
  observations: number,
  priorSource: PriorSource = 'neutral',
  prior = 1,
): ShrunkScore {
  return shrink({ observed, observations, prior, priorSource, k: 5 });
}

const base = { selection: 'exploit' as const, category: 'coffee shops' };

describe('a claim reports what we measured, not what we believe', () => {
  it('takes the multiplier from the raw brand mean, not the shrunk value', () => {
    // The defining assertion of this file. At n=8 and k=5 the shrunk value is
    // (8*2.4 + 5*1)/13 = 1.87 — a perfectly ordinary number that would read as a claim and
    // would be reporting a figure assembled partly from other businesses. 2.4 is what this
    // brand actually did.
    const explanation = explain({
      ...base,
      score: score(2.4, 8),
      scored: 8,
      posts: 8,
      claimable: true,
    });

    expect(explanation.kind).toBe('brand-claim');
    expect(explanation.multiplier).toBe(2.4);
    // Stated explicitly so a future change that swaps the source fails here with the
    // reason attached, rather than merely failing an equality on a plausible number.
    expect(explanation.multiplier).not.toBeCloseTo(1.87, 1);
  });

  it('is unmoved by k, because a measurement does not shrink', () => {
    // A measurement is a measurement whatever prior we hold alongside it. If the
    // multiplier moved with k it would be the shrunk value wearing a claim's label.
    const heavy = explain({
      ...base,
      score: shrink({ observed: 2.4, observations: 8, prior: 1, priorSource: 'neutral', k: 50 }),
      scored: 8,
      posts: 8,
      claimable: true,
    });

    expect(heavy.multiplier).toBe(2.4);
  });

  it('reports the sample the claim rests on', () => {
    const explanation = explain({
      ...base,
      score: score(3, 12),
      scored: 12,
      posts: 14,
      claimable: true,
    });

    expect(explanation.sampleSize).toBe(12);
  });
});

describe('the sample gate', () => {
  it('falls back to category framing below the minimum sample', () => {
    const explanation = explain({
      ...base,
      score: score(4, 2, 'category-seed', 1.5),
      scored: 2,
      posts: 2,
      claimable: false,
    });

    expect(explanation.kind).toBe('category-claim');
    expect(explanation.multiplier).toBeNull();
  });

  it('makes the brand claim once the sample is there', () => {
    // The positive control. Every "falls back" assertion above is satisfied by a function
    // that never claims anything at all; this is what makes them mean something.
    const explanation = explain({
      ...base,
      score: score(4, 9, 'category-seed', 1.5),
      scored: 9,
      posts: 9,
      claimable: true,
    });

    expect(explanation.kind).toBe('brand-claim');
    expect(explanation.multiplier).toBe(4);
  });
});

describe('the materiality gate', () => {
  it('declines to put an unremarkable number in front of the user', () => {
    // "Your Before/After posts drove 1.1x your average" is true, reads as a finding, and
    // contains none.
    const explanation = explain({
      ...base,
      score: score(1.1, 20, 'category-aggregate', 1),
      scored: 20,
      posts: 20,
      claimable: true,
    });

    expect(explanation.kind).toBe('category-claim');
    expect(explanation.multiplier).toBeNull();
  });

  it('never recommends a template by reporting that it underperforms', () => {
    const explanation = explain({
      ...base,
      score: score(0.6, 30, 'category-aggregate', 1),
      scored: 30,
      posts: 30,
      claimable: true,
    });

    expect(explanation.kind).not.toBe('brand-claim');
  });

  it('claims at the floor exactly', () => {
    // The boundary, and the positive control for the gate: a floor that rejected its own
    // threshold would pass every test above while quietly needing 1.3x.
    const explanation = explain({
      ...base,
      score: score(1.2, 20, 'category-aggregate', 1),
      scored: 20,
      posts: 20,
      claimable: true,
      minMultiplier: 1.2,
    });

    expect(explanation.kind).toBe('brand-claim');
  });
});

describe('the provenance gate', () => {
  it('will not say "businesses like yours" over a neutral prior', () => {
    // A neutral prior is not an opinion about anybody. Rendering category framing over it
    // invents a peer group, and the number is 1.0 in both cases so nothing downstream can
    // tell the difference.
    const explanation = explain({
      ...base,
      score: score(null, 0, 'neutral', 1),
      scored: 0,
      posts: 0,
      claimable: false,
    });

    expect(explanation.kind).toBe('no-claim');
    expect(explanation.category).toBeNull();
  });

  it('will not say it over a platform default either', () => {
    const explanation = explain({
      ...base,
      score: score(null, 0, 'platform-default', 1.1),
      scored: 0,
      posts: 0,
      claimable: false,
    });

    expect(explanation.kind).toBe('no-claim');
  });

  it('says it over a seeded category prior', () => {
    // The cold-start headline from the brief: "Popular with coffee shops". Also the
    // positive control for the two assertions above.
    const explanation = explain({
      ...base,
      score: score(null, 0, 'category-seed', 1.4),
      scored: 0,
      posts: 0,
      claimable: false,
    });

    expect(explanation.kind).toBe('category-claim');
    expect(explanation.category).toBe('coffee shops');
  });

  it('says it over a category aggregate', () => {
    const explanation = explain({
      ...base,
      score: score(null, 0, 'category-aggregate', 1.6),
      scored: 0,
      posts: 0,
      claimable: false,
    });

    expect(explanation.kind).toBe('category-claim');
  });

  it('declines to name a category it has no label for', () => {
    const explanation = explain({
      score: score(null, 0, 'category-seed', 1.4),
      scored: 0,
      posts: 0,
      claimable: false,
      selection: 'exploit',
      category: null,
    });

    expect(explanation.kind).toBe('category-claim');
    expect(explanation.category).toBeNull();
  });
});

describe('untried is about the user, not about our measurement', () => {
  it('is true only when the brand has never posted this', () => {
    const never = explain({
      ...base,
      score: score(null, 0),
      scored: 0,
      posts: 0,
      claimable: false,
    });
    expect(never.untried).toBe(true);
  });

  it('is false when they posted and we could not measure it', () => {
    // scored === 0 in both cases. "You haven't tried this" and "we couldn't measure what
    // happened when you did" are different sentences and only one is about the user.
    const unmeasured = explain({
      ...base,
      score: score(null, 0),
      scored: 0,
      posts: 4,
      claimable: false,
    });

    expect(unmeasured.untried).toBe(false);
    expect(unmeasured.sampleSize).toBe(0);
  });
});

describe('selection provenance survives', () => {
  it('carries the exploration flag through even when the prior likes the candidate', () => {
    // An exploration pick is not a recommendation. If this were dropped the UI would frame
    // a slot we reserved as a finding we made.
    const explanation = explain({
      ...base,
      score: score(null, 0, 'category-seed', 1.8),
      scored: 0,
      posts: 0,
      claimable: false,
      selection: 'explore',
    });

    expect(explanation.selection).toBe('explore');
  });

  it('carries exploit through as well', () => {
    const explanation = explain({
      ...base,
      score: score(3, 9),
      scored: 9,
      posts: 9,
      claimable: true,
    });

    expect(explanation.selection).toBe('exploit');
  });
});

describe('a non-claim is never a disguised claim', () => {
  it('leaves the multiplier null rather than 1', () => {
    // `1` would render as "exactly typical", which is a claim, and is also what a caller
    // doing `multiplier ?? 1` would produce. Keeping it null makes that caller's bug
    // visible instead of plausible.
    for (const kind of ['category-claim', 'no-claim']) {
      const source: PriorSource = kind === 'category-claim' ? 'category-seed' : 'neutral';
      const explanation = explain({
        ...base,
        score: score(null, 0, source, 1.3),
        scored: 0,
        posts: 0,
        claimable: false,
      });

      expect(explanation.kind).toBe(kind);
      expect(explanation.multiplier).toBeNull();
    }
  });
});

describe('the gates are reachable by the brands we actually serve', () => {
  // Unit tests above each construct a fixture that clears the gate, because that is what
  // they are for. Collectively they cannot tell us whether the claim path ever fires for a
  // real small business — a feature that is correct in every case and reachable in none
  // would pass all of them.
  //
  // Realistic small brand: three posts a week for eight weeks, one platform, three
  // archetypes in rotation. 24 posts is roughly the point at which any archetype first
  // clears `minSampleForClaim`, so this is close to the earliest a claim is possible.
  function smallBrand(clicksByArchetype: Record<string, number>, fullCoverage: boolean) {
    const targets = Object.entries(clicksByArchetype).flatMap(([archetype, clicks]) =>
      Array.from({ length: 8 }, () =>
        makeTarget({
          archetype,
          linkClicks: clicks,
          platform: fullCoverage ? 'INSTAGRAM' : 'X',
          ...(fullCoverage
            ? { saves: clicks, shares: clicks, likes: clicks, comments: clicks }
            : {}),
        }),
      ),
    );

    return scoreArchetypes({ targets, candidates: Object.keys(clicksByArchetype) }).map((s) =>
      explain({
        score: s.score,
        scored: s.scored,
        posts: s.posts,
        claimable: s.claimable,
        selection: 'exploit',
        category: 'coffee shops',
      }),
    );
  }

  it('produces a brand-specific sentence for a plausible small brand', () => {
    // A 1.6x click-rate lift on the brand's best archetype — good, not freakish.
    const explanations = smallBrand({ BEFORE_AFTER: 16, TIP: 10, BTS: 7 }, false);
    const claims = explanations.filter((e) => e.kind === 'brand-claim');

    expect(claims).toHaveLength(1);
    expect(claims[0]?.multiplier).toBe(1.3);
  });

  it('stays silent for a brand whose archetypes all perform alike', () => {
    // The control. Reachability must not come from a gate that lets everything through.
    const explanations = smallBrand({ BEFORE_AFTER: 10, TIP: 10, BTS: 10 }, false);

    expect(explanations.filter((e) => e.kind === 'brand-claim')).toHaveLength(0);
  });

  it('needs a larger lift where fewer components are measurable', () => {
    // A characterisation of a real consequence, not a preference. Unmeasured components are
    // imputed at 1.0, so on a clicks-only platform a lift of x reaches 0.45x + 0.55, and
    // the effective bar for a 1.2 floor is about 1.44x. With all four components measured
    // the lift passes through and the bar is 1.2x.
    //
    // This is the coverage bias from normalize.ts surfacing in the sentence gate rather
    // than in ranking variance. It is defensible — on X we genuinely know less about the
    // post — but it means the same brand doing the same thing earns a sentence on
    // Instagram and not on X, which is a thing to know before a user asks.
    const lift = { BEFORE_AFTER: 14, TIP: 10, BTS: 8 };

    expect(smallBrand(lift, false).filter((e) => e.kind === 'brand-claim')).toHaveLength(0);
    expect(smallBrand(lift, true).filter((e) => e.kind === 'brand-claim')).toHaveLength(1);
  });
});
