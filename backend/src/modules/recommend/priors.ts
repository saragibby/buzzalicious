import { getConfig } from '../../platform/config';
import type { PriorSource } from './shrinkage';

/**
 * Resolving `prior(category(b), s)` — the term that makes a cold start defensible.
 *
 * Pure by design: no Prisma, no `await`. Callers assemble the inputs and this decides
 * which tier wins and says which one it was. That keeps the tier logic testable without a
 * database, which matters because the tiers are where the reasoning lives and the queries
 * are where the reasoning does not.
 *
 * ## The stack
 *
 * 1. **`category-aggregate`** — what brands in this category actually achieved, in
 *    normalised units. The only tier with evidence behind it.
 * 2. **`category-seed`** — hand-seeded `BusinessCategory.priors`. An informed guess.
 * 3. **`platform-default`** — hand-seeded per-social-platform defaults. Weaker again, and
 *    used mainly for send-time, where every platform has a broadly known shape.
 * 4. **`neutral`** — `1.0`. Not an opinion, and labelled so nobody renders it as one.
 *
 * ## Two contamination rules the caller must honour, because this file cannot
 *
 * **Exclude `scheduleSource = EXPLORATION` and `SUGGESTED` posts from aggregates.** An
 * aggregate built over our own suggestions is a measurement of what we happened to suggest
 * first, dressed as a measurement of what works. The loop then converges on its own
 * opening move and every subsequent confirmation is circular.
 *
 * **Exclude the brand's own posts from its own category aggregate.** Shrinkage blends
 * `observed(b,a)` against `prior(category(b), a)`, and the arithmetic only means anything
 * if those two are independent. A brand that dominates its category would otherwise be
 * blended against itself and its estimate would look far better corroborated than it is —
 * with `brandWeight` reporting a reassuring fraction that is no longer true.
 *
 * Neither is enforceable here; both are asserted in `priors.test.ts` against the query
 * layer and stated at the call sites.
 */

/** Aggregate outcome for one dimension value, over a category. Already normalised. */
export interface CategoryAggregate {
  /** Mean normalised score. `1.0` is "typical for the brands measured". */
  readonly mean: number;
  /**
   * Brand-level observations behind `mean`.
   *
   * Brand-level, not post-level: one brand with forty posts is one brand's opinion, and
   * counting it as forty would let a single large account set its category's prior.
   */
  readonly observations: number;
}

export interface PriorInputs {
  /** Aggregate for the dimension value being scored, if the category has one. */
  readonly aggregate?: CategoryAggregate | null;
  /**
   * The whole hand-seeded record for this dimension, not just this value's entry.
   *
   * The whole record is required because the seed is rescaled against its own mean — see
   * `seedPrior`. Passing one entry would make that impossible and the rescaling would
   * have to be guessed.
   */
  readonly seed?: Readonly<Record<string, number>> | null;
  /** Hand-seeded per-social-platform defaults, same shape and same rescaling. */
  readonly platformDefaults?: Readonly<Record<string, number>> | null;
  /** The key being resolved: an archetype, or a `weekday:midday` send-time slot. */
  readonly key: string;
}

export interface ResolvedPrior {
  readonly prior: number;
  readonly source: PriorSource;
  /** Brand-level observations, when `source` is `category-aggregate`. `0` otherwise. */
  readonly observations: number;
}

/** The value that is not an opinion. Everything else is measured against it. */
export const NEUTRAL_PRIOR = 1;

/**
 * Put a 0..1 seed weight onto the neutral scale — a deviation from the schema's contract,
 * and the reason for it.
 *
 * `BusinessCategory.priors.archetypes` is documented as a 0..1 weight per archetype.
 * Normalised outcome scores live on a scale where `1.0` is "typical". Feeding a 0..1
 * weight straight into the shrinkage formula would make **every seeded prior a penalty**:
 * a perfectly enthusiastic seed of `0.8` would enter as "20% below typical", so a
 * cold-start brand's best archetype would still be scored as underperforming. The numbers
 * would look entirely plausible and every one of them would be wrong.
 *
 * The seed's *ordering* is the part that carries information; its *magnitude* is a hand
 * guess on an arbitrary scale. So the weights are rescaled to a mean of `1.0` across the
 * entries that have an opinion. Ordering survives exactly, the units become the right
 * ones, and no magnitude is invented that was not already in the seed.
 *
 * The magnitude that does survive is still a guess — `{0.9, 0.1}` rescales to `1.8` and
 * `0.2`, which is a very confident-looking spread. That never reaches a user, because the
 * `minSampleForClaim` gate means a cold-start brand gets category framing ("popular with
 * coffee shops") and never a numeric claim ("2.4× more clicks"). The gate is what makes
 * the spread safe; if that gate is ever removed, this rescaling needs a compression term.
 *
 * An **absent** entry is "no opinion", which the schema is explicit is not the same as
 * `0`. So it falls through to the next tier rather than being read as a zero weight.
 */
function seedPrior(seed: Readonly<Record<string, number>>, key: string): number | null {
  const weight = seed[key];
  if (weight === undefined) return null;

  const present = Object.values(seed).filter((value) => Number.isFinite(value));
  if (present.length === 0) return null;

  const mean = present.reduce((sum, value) => sum + value, 0) / present.length;
  // An all-zero seed has an ordering, but it is the empty one. Rescaling it would divide
  // by zero; treating it as an opinion would rank on noise.
  if (mean <= 0) return null;

  return weight / mean;
}

/**
 * Pick the strongest tier that has something to say, and report which one it was.
 *
 * The aggregate is only trusted above `minSampleForClaim` brands. That is the same
 * threshold the UI uses before making a brand-specific claim, reused deliberately rather
 * than given its own knob: both answer the same question — is there enough here to say
 * something about this category, or are we describing three brands and calling it an
 * industry?
 */
export function resolvePrior(inputs: PriorInputs): ResolvedPrior {
  const minSample = getConfig().recommend.minSampleForClaim;
  const { aggregate, seed, platformDefaults, key } = inputs;

  if (aggregate && aggregate.observations >= minSample && Number.isFinite(aggregate.mean)) {
    return {
      prior: aggregate.mean,
      source: 'category-aggregate',
      observations: aggregate.observations,
    };
  }

  if (seed) {
    const value = seedPrior(seed, key);
    if (value !== null) return { prior: value, source: 'category-seed', observations: 0 };
  }

  if (platformDefaults) {
    const value = seedPrior(platformDefaults, key);
    if (value !== null) return { prior: value, source: 'platform-default', observations: 0 };
  }

  return { prior: NEUTRAL_PRIOR, source: 'neutral', observations: 0 };
}

/**
 * Whether a prior is strong enough to be described to a user as being about their
 * industry.
 *
 * `category-seed` counts: "popular with coffee shops" is an honest rendering of a
 * hand-seeded category opinion, and the brief asks for exactly that framing at cold start.
 * `neutral` does not, and this is the function that stops it — a neutral prior renders as
 * "we don't know yet", never as a claim about businesses like yours.
 */
export function priorIsAboutCategory(source: PriorSource): boolean {
  return source === 'category-aggregate' || source === 'category-seed';
}
