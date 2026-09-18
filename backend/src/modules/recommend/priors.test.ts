import { describe, expect, it } from 'vitest';
import { NEUTRAL_PRIOR, priorIsAboutCategory, resolvePrior } from './priors';

/**
 * A seed shaped like a real one: a clear favourite, a middling option, an unloved one, and
 * one archetype with no entry at all — which the schema is explicit means "no opinion",
 * not "zero".
 */
const SEED = {
  BEFORE_AFTER: 0.8,
  BEHIND_THE_SCENES: 0.4,
  QUOTE: 0.2,
};

describe('the tier stack picks the strongest tier that has something to say', () => {
  it('prefers a category aggregate once enough brands are behind it', () => {
    const resolved = resolvePrior({
      key: 'BEFORE_AFTER',
      aggregate: { mean: 1.6, observations: 5 },
      seed: SEED,
    });

    expect(resolved.source).toBe('category-aggregate');
    expect(resolved.prior).toBe(1.6);
    expect(resolved.observations).toBe(5);
  });

  it('falls to the seed when the aggregate is one brand short', () => {
    // POSITIVE CONTROL for the threshold: identical inputs, one fewer brand. If the
    // threshold were not read at all, the test above would pass on its own and this one
    // would return the aggregate too.
    const resolved = resolvePrior({
      key: 'BEFORE_AFTER',
      aggregate: { mean: 1.6, observations: 4 },
      seed: SEED,
    });

    expect(resolved.source).toBe('category-seed');
    expect(resolved.prior).not.toBe(1.6);
  });

  it('falls to platform defaults when the category has no opinion on this key', () => {
    const resolved = resolvePrior({
      key: 'CAROUSEL',
      seed: SEED,
      platformDefaults: { CAROUSEL: 0.6, QUOTE: 0.3 },
    });

    expect(resolved.source).toBe('platform-default');
  });

  it('lands on a labelled neutral when nothing at all is known', () => {
    const resolved = resolvePrior({ key: 'CAROUSEL', seed: SEED });

    expect(resolved.prior).toBe(NEUTRAL_PRIOR);
    expect(resolved.source).toBe('neutral');
    // The whole reason `neutral` exists as its own source: 1.0 from an empty table and
    // 1.0 from a seeded default are the same number and entirely different claims.
    expect(resolved.source).not.toBe('platform-default');
  });
});

/**
 * The contract mismatch: seeds are 0..1 weights, scores are on a scale where 1.0 is
 * typical. Used raw, every seeded prior would enter the shrinkage formula as a penalty.
 */
describe('a 0..1 seed weight is rescaled onto the neutral scale', () => {
  it('does not treat an enthusiastic seed as below typical', () => {
    // Every seed entry here is below 1.0. Used raw, the category's *favourite* archetype
    // would be scored as 20% worse than typical for a brand with no data — plausible
    // numbers, all of them wrong.
    const favourite = resolvePrior({ key: 'BEFORE_AFTER', seed: SEED });

    expect(favourite.prior).toBeGreaterThan(1);
    expect(favourite.prior).not.toBeCloseTo(0.8, 10);
  });

  it('centres the seed on 1.0 and preserves its ordering exactly', () => {
    // mean(0.8, 0.4, 0.2) = 0.4666… → 1.714…, 0.857…, 0.428…
    const best = resolvePrior({ key: 'BEFORE_AFTER', seed: SEED }).prior;
    const middle = resolvePrior({ key: 'BEHIND_THE_SCENES', seed: SEED }).prior;
    const worst = resolvePrior({ key: 'QUOTE', seed: SEED }).prior;

    expect(best).toBeGreaterThan(middle);
    expect(middle).toBeGreaterThan(worst);
    expect((best + middle + worst) / 3).toBeCloseTo(1, 10);

    // Ratios are untouched, which is the claim: ordering and relative strength survive,
    // only the units change.
    expect(best / worst).toBeCloseTo(0.8 / 0.2, 10);
  });

  it('is scale-invariant, so the seed author’s choice of range does not matter', () => {
    // POSITIVE CONTROL of a different kind: a seed written as 0.08/0.04/0.02 expresses the
    // same opinion as 0.8/0.4/0.2. If rescaling were not happening, these would differ by
    // a factor of ten and cold-start rankings would depend on a formatting habit.
    const tenth = resolvePrior({
      key: 'BEFORE_AFTER',
      seed: { BEFORE_AFTER: 0.08, BEHIND_THE_SCENES: 0.04, QUOTE: 0.02 },
    });

    expect(tenth.prior).toBeCloseTo(resolvePrior({ key: 'BEFORE_AFTER', seed: SEED }).prior, 10);
  });

  it('treats an absent entry as no opinion rather than as zero', () => {
    const resolved = resolvePrior({
      key: 'CAROUSEL',
      seed: SEED,
      platformDefaults: { CAROUSEL: 0.5, QUOTE: 0.5 },
    });

    // Reading absent as 0 would rank CAROUSEL dead last on a seed that never mentioned it.
    expect(resolved.source).toBe('platform-default');
    expect(resolved.prior).toBeGreaterThan(0);
  });

  it('refuses an all-zero seed rather than dividing by its mean', () => {
    const resolved = resolvePrior({ key: 'QUOTE', seed: { QUOTE: 0, BEFORE_AFTER: 0 } });

    expect(resolved.source).toBe('neutral');
    expect(Number.isFinite(resolved.prior)).toBe(true);
  });

  it('refuses a non-finite aggregate', () => {
    // An aggregate over an empty set can arrive as NaN. NaN does not throw in a sort
    // comparator, it just orders unpredictably — so it must never become a prior.
    const resolved = resolvePrior({
      key: 'BEFORE_AFTER',
      aggregate: { mean: Number.NaN, observations: 50 },
      seed: SEED,
    });

    expect(resolved.source).toBe('category-seed');
    expect(Number.isFinite(resolved.prior)).toBe(true);
  });
});

/**
 * The gate that keeps "popular with coffee shops" off a brand we know nothing about.
 */
describe('only some priors may be described as being about the category', () => {
  it('allows aggregate and seed framing', () => {
    expect(priorIsAboutCategory('category-aggregate')).toBe(true);
    // A hand-seeded category opinion is honestly rendered as category framing — that is
    // precisely the cold-start copy the brief asks for.
    expect(priorIsAboutCategory('category-seed')).toBe(true);
  });

  it('refuses framing for a prior that is not about the category', () => {
    expect(priorIsAboutCategory('platform-default')).toBe(false);
    expect(priorIsAboutCategory('neutral')).toBe(false);
  });
});
