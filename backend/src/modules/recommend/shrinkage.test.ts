import { describe, expect, it } from 'vitest';
import { compareShrunk, shrink, shrunkValue, type ShrunkScore } from './shrinkage';

/**
 * ## The type-level half of this file is not decorative
 *
 * The guarantee W8 owes is that "I shrank this" cannot be confused with "this is what we
 * measured". That is a **compile-time** property, so a runtime test cannot prove it: if
 * the `_shrunk` tag were deleted tomorrow, every `expect()` below would still pass.
 *
 * The `@ts-expect-error` lines are the actual assertion, and `npm run type-check` is what
 * runs them. Deleting the brand makes the suppressions unnecessary and `tsc` fails with
 * `TS2578: Unused '@ts-expect-error' directive` — verified against this repo's config, not
 * assumed. Each is paired with an adjacent line that **must** compile, because a file that
 * failed to parse at all would otherwise look identical to a file whose guards all held.
 */
describe('ShrunkScore is not a number', () => {
  const score = shrink({
    observed: 4,
    observations: 10,
    prior: 1,
    priorSource: 'category-seed',
  });

  it('cannot be assigned or compared where a measurement is expected', () => {
    // POSITIVE CONTROL. If this line stops compiling the file is broken rather than
    // guarded, and the suppressions below would be "passing" for the wrong reason.
    const unwrapped: number = shrunkValue(score);
    expect(unwrapped).toBeCloseTo(3.0, 10);

    // @ts-expect-error a shrunk estimate must not stand in for a measured number
    const leaked: number = score;
    expect(leaked).toBeDefined();

    // @ts-expect-error ...and must not be ordered against one either
    const compared = score > 2;
    expect(compared).toBeDefined();

    // @ts-expect-error ...nor summed into one
    const summed = score + 1;
    expect(summed).toBeDefined();
  });

  it('does not accept a raw number where a shrunk score is expected', () => {
    // POSITIVE CONTROL: the real thing goes in fine.
    expect(compareShrunk(score, score)).toBe(0);

    // @ts-expect-error the confusion has to be blocked in both directions
    expect(() => compareShrunk(3.0, score)).toBeDefined();
  });

  it('keeps the measured value in a different field from the shrunk one', () => {
    // The interior hazard in one assertion: these two numbers are both present, both
    // plausible, and mean entirely different things. A design that returned only one of
    // them would make the distinction unrecoverable downstream.
    expect(score.basis.observed).toBe(4);
    expect(score.shrunkValue).not.toBe(score.basis.observed);
  });
});

describe('shrink', () => {
  it('returns the prior exactly when the brand has no posts', () => {
    const score = shrink({
      observed: null,
      observations: 0,
      prior: 0.7,
      priorSource: 'category-seed',
    });

    expect(score.shrunkValue).toBe(0.7);
    expect(score.basis.brandWeight).toBe(0);
    expect(score.basis.observations).toBe(0);
    // Provenance, not just value: a cold-start score must be able to say it is a guess.
    expect(score.basis.priorSource).toBe('category-seed');
  });

  it('gives unmeasurable posts no weight, however many there are', () => {
    // A brand can publish five posts and have none return a measurable metric. Those
    // posts know nothing, so they must not buy influence over the prior — otherwise
    // publishing into a measurement blackout steadily erases the only signal available.
    const blackout = shrink({
      observed: null,
      observations: 5,
      prior: 0.7,
      priorSource: 'category-seed',
    });

    expect(blackout.shrunkValue).toBe(0.7);
    expect(blackout.basis.observations).toBe(0);
    expect(blackout.basis.brandWeight).toBe(0);

    // POSITIVE CONTROL: the same five posts *with* a measurement do move the score,
    // so the assertion above is about measurability and not about `observations` being
    // ignored outright.
    const measured = shrink({
      observed: 0.2,
      observations: 5,
      prior: 0.7,
      priorSource: 'category-seed',
    });
    expect(measured.shrunkValue).not.toBe(0.7);
    expect(measured.basis.observations).toBe(5);
  });

  it('reports how much of the score is the brand and how much is the prior', () => {
    // n = 1, k = 5 → brandWeight = 1/6. This is the number that makes the interior
    // hazard legible: the value is ordinary, its composition is not.
    const thin = shrink({ observed: 10, observations: 1, prior: 1, priorSource: 'category-seed' });
    expect(thin.basis.brandWeight).toBeCloseTo(1 / 6, 10);

    const thick = shrink({
      observed: 10,
      observations: 45,
      prior: 1,
      priorSource: 'category-seed',
    });
    expect(thick.basis.brandWeight).toBeCloseTo(0.9, 10);
  });
});

/**
 * `k` is config, not a constant — asserted by driving it to both edges.
 *
 * A test that only checked the default would pass against a hard-coded 5.
 */
describe('the smoothing constant is configurable', () => {
  const input = {
    observed: 10,
    observations: 2,
    prior: 1,
    priorSource: 'category-seed' as const,
  };

  it('returns the raw observed mean at k = 0', () => {
    const score = shrink({ ...input, k: 0 });
    expect(score.shrunkValue).toBe(10);
    expect(score.basis.brandWeight).toBe(1);
  });

  it('collapses toward the prior at a large k', () => {
    // n = 2, k = 50 → (2·10 + 50·1)/52 = 70/52 ≈ 1.346
    const score = shrink({ ...input, k: 50 });
    expect(score.shrunkValue).toBeCloseTo(70 / 52, 10);
    expect(score.basis.brandWeight).toBeCloseTo(2 / 52, 10);
  });

  it('falls back to the prior rather than NaN when k = 0 and there is nothing to average', () => {
    // n + k = 0 is a real reachable state once k is tunable. A NaN here would propagate
    // into a sort comparator, where it does not throw — it just orders unpredictably.
    const score = shrink({
      observed: null,
      observations: 0,
      prior: 0.4,
      priorSource: 'platform-default',
      k: 0,
    });

    expect(score.shrunkValue).toBe(0.4);
    expect(Number.isNaN(score.shrunkValue)).toBe(false);
  });
});

/**
 * The property the brief actually asks for: one outlier at low `n` must not dominate.
 *
 * ## The arithmetic, because these numbers look arbitrary and are not
 *
 * The obvious fixture does not work, and a test written without doing the sums would
 * encode a false belief about shrinkage and pass. With `k = 5` and a prior of `1.0`:
 *
 * ```
 *   outlier   n=1,  observed=10.0  →  (1·10 + 5·1) / 6  = 2.500
 *   steady    n=8,  observed= 3.0  →  (8·3  + 5·1) / 13 = 2.231
 * ```
 *
 * The outlier **still wins**. Shrinkage is not a guarantee of reordering; it is a
 * proportional pull toward the prior, and a 10× result survives it at n=1.
 *
 * What shrinkage actually delivers is that the outlier's *advantage* collapses — from
 * 10/3 = 3.33× down to 2.50/2.23 = 1.12× — and that the ordering flips across a plausible
 * range. So the fixture below uses a genuinely flipping pair:
 *
 * ```
 *   outlier   n=1,  observed=6.0   →  (1·6  + 5·1) / 6  = 1.833
 *   steady    n=8,  observed=2.5   →  (8·2.5 + 5·1) / 13 = 1.923   ← wins
 * ```
 *
 * Do not "simplify" these values without redoing the division.
 */
describe('one outlier at low n cannot dominate', () => {
  const PRIOR = 1;
  const outlier = shrink({
    observed: 6.0,
    observations: 1,
    prior: PRIOR,
    priorSource: 'category-seed',
  });
  const steady = shrink({
    observed: 2.5,
    observations: 8,
    prior: PRIOR,
    priorSource: 'category-seed',
  });

  it('ranks the consistent archetype above the one-post fluke', () => {
    expect(outlier.shrunkValue).toBeCloseTo(11 / 6, 10);
    expect(steady.shrunkValue).toBeCloseTo(25 / 13, 10);

    const ranked = [outlier, steady].sort(compareShrunk);
    expect(ranked[0]).toBe(steady);
  });

  it('would rank the fluke first on a plain average of the same fixture', () => {
    // POSITIVE CONTROL, and the load-bearing half of this pair. Without it the test
    // above passes on a fixture containing no outlier at all — it would be asserting
    // that 2.5 beats 2.5, which shrinkage plays no part in.
    const byPlainAverage = [outlier, steady].sort(
      (a, b) => (b.basis.observed ?? 0) - (a.basis.observed ?? 0),
    );
    expect(byPlainAverage[0]).toBe(outlier);
  });

  it('collapses the outlier advantage even where it does not flip the order', () => {
    // The honest general property, stated on the fixture that does NOT reorder, so the
    // suite records what shrinkage does rather than only where it happens to look best.
    const bigOutlier = shrink({
      observed: 10,
      observations: 1,
      prior: PRIOR,
      priorSource: 'category-seed',
    });
    const bigSteady = shrink({
      observed: 3,
      observations: 8,
      prior: PRIOR,
      priorSource: 'category-seed',
    });

    const rawAdvantage = 10 / 3;
    const shrunkAdvantage = bigOutlier.shrunkValue / bigSteady.shrunkValue;

    expect(rawAdvantage).toBeCloseTo(3.333, 3);
    expect(shrunkAdvantage).toBeCloseTo(1.12, 2);
    expect(shrunkAdvantage).toBeLessThan(rawAdvantage);

    // And it is still the outlier on top here. Recorded deliberately: a reader who
    // assumes shrinkage always reorders will write the wrong test next time.
    const ranked: ShrunkScore[] = [bigSteady, bigOutlier].sort(compareShrunk);
    expect(ranked[0]).toBe(bigOutlier);
  });
});
