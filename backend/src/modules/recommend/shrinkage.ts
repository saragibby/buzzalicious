import { getConfig } from '../../platform/config';

/**
 * Shrinkage toward a prior — the whole of the feedback loop's statistics (docs/06).
 *
 * ```
 * score(b, a) = ( n(b,a) · observed(b,a) + k · prior(category(b), a) ) / ( n(b,a) + k )
 * ```
 *
 * Fifteen lines, no training pipeline, explainable to a user in one sentence. It exists
 * because the PRD demands two things that a plain average cannot satisfy at once: rank by
 * what works for *this* brand, and give a brand-new brand useful recommendations on day
 * one. An average gives the new brand nothing and gives the brand with one lucky post a
 * confidently wrong answer.
 *
 * ## Why the result is not a `number`
 *
 * This is the one operation in the plan where "unmeasured" and "measured, then pulled
 * hard toward the prior" converge on the same output type. A group with a single thin
 * observation shrunk most of the way to the prior is an ordinary, non-null, entirely
 * plausible number. It does not misstate the value — it misstates the value's
 * **provenance**, and every assertion written against the value passes.
 *
 * W7's `a zero is a lie` guards the endpoint, where nothing was measurable at all. The
 * hazard is the interior, and the interior has no endpoint to guard.
 *
 * So shrinkage does not return a number. It returns a `ShrunkScore`, which is
 * structurally unassignable to `number`: `const x: number = shrunk` does not compile,
 * `shrunk > group.meanScore` does not compile, and reading the value is an explicit call
 * to `shrunkValue()` that a reviewer can see. The precedent is `effectiveCaption`, which
 * was made a named function *precisely because* the two readings look interchangeable and
 * are not — and whose documented convention was then violated twelve lines away in
 * `buildPublishInput`, publishing an empty caption for every target without an override.
 * A convention documented at the definition site does not survive contact with a call
 * site. A type does.
 *
 * `meanScore` and `scored` on `OutcomeGroup` are deliberately untouched by any of this.
 * They remain raw and unshrunk and mean exactly what they say.
 */

/** Where a prior came from. Part of the value's provenance, never inferred by a caller. */
export type PriorSource =
  /** Aggregate outcome data from other brands in the category. The best available. */
  | 'category-aggregate'
  /** Hand-seeded `BusinessCategory.priors`. An informed guess, and says so. */
  | 'category-seed'
  /** Hand-seeded per-social-platform defaults, when the category has no opinion. */
  | 'platform-default'
  /**
   * No prior of any kind. The value is the neutral `1.0`, which is not an opinion.
   *
   * Deliberately distinct from `platform-default`: "we have a seeded default for
   * Instagram" and "we have nothing at all and are standing on neutral" produce the same
   * number and mean entirely different things. Collapsing them would let a caller render
   * "typical for businesses like yours" over an empty table.
   */
  | 'neutral';

/**
 * Everything needed to decide how much of a `ShrunkScore` is the brand's own.
 *
 * This is the part that makes the interior hazard visible. `observations: 1` with
 * `brandWeight: 0.17` says plainly that five sixths of this number is a guess about
 * businesses like yours, which is a thing the UI can render honestly and a caller can
 * refuse to make a claim from.
 */
export interface ShrinkageBasis {
  /** `n(b,a)`. `0` means the value **is** the prior — nothing of the brand's is in it. */
  readonly observations: number;
  /** `k`, from config. In units of posts: "this prior is worth k of your own posts". */
  readonly priorWeight: number;
  /**
   * The brand's own raw mean over `observations` posts.
   *
   * Stays `null` when nothing was measurable, and is **not** the same field as the shrunk
   * value. Keeping them apart is the point: one is what we saw, the other is what we
   * believe, and they are never interchangeable.
   */
  readonly observed: number | null;
  readonly prior: number;
  readonly priorSource: PriorSource;
  /**
   * `n / (n + k)` — the fraction of the score that came from the brand's own data.
   *
   * `0` is a pure prior, `1` is a pure measurement, and anything between is a blend whose
   * composition the UI should be able to show rather than round away.
   */
  readonly brandWeight: number;
}

/**
 * A score that has been pulled toward a prior. **Not a measurement.**
 *
 * The `_shrunk` tag has no runtime purpose whatsoever — it exists so that TypeScript
 * refuses to let this stand where a measured number is expected. Removing it makes the
 * type structurally a `{ shrunkValue, basis }` bag that still cannot be assigned to
 * `number`, but the tag is what makes the intent unmistakable at a glance and what the
 * type-level test pins.
 */
export interface ShrunkScore {
  readonly _shrunk: true;
  readonly shrunkValue: number;
  readonly basis: ShrinkageBasis;
}

/**
 * Read the number out of a `ShrunkScore`.
 *
 * Deliberately a named function and not a property access at the call sites that rank, so
 * that "I am about to treat a shrunk estimate as a number" is a visible act in a diff.
 */
export function shrunkValue(score: ShrunkScore): number {
  return score.shrunkValue;
}

/** Order two shrunk scores. The only comparison that exists, because `>` will not compile. */
export function compareShrunk(a: ShrunkScore, b: ShrunkScore): number {
  return b.shrunkValue - a.shrunkValue;
}

export interface ShrinkInput {
  /** The brand's own mean over `observations` posts. `null` when nothing was measurable. */
  observed: number | null;
  /** `n(b,a)` — how many of the brand's posts contributed to `observed`. */
  observations: number;
  prior: number;
  priorSource: PriorSource;
  /** Overrides `SHRINKAGE_K`. For tests and for callers that scale `k` by dimension. */
  k?: number;
}

/**
 * Blend a brand's own observation with a prior.
 *
 * Three cases, and the middle one is the whole reason this function exists:
 *
 * | `n` | result |
 * |-----|--------|
 * | `0`, or `observed` is `null` | the prior exactly, `brandWeight: 0` |
 * | small | mostly prior — one fluke cannot dominate |
 * | large | the brand's own history, prior is noise |
 *
 * `observed === null` with `observations > 0` is a real state, not a contradiction: a
 * brand can have published five posts with an archetype and had none of them return a
 * measurable metric. Those posts tell us nothing, so they must not buy influence over the
 * prior — `n` is forced to `0` rather than trusted, because otherwise a brand publishing
 * into a measurement blackout would steadily override the only useful signal it has with
 * an absence.
 */
export function shrink(input: ShrinkInput): ShrunkScore {
  const k = input.k ?? getConfig().recommend.shrinkageK;

  // Unmeasurable observations carry no information, so they carry no weight either.
  const n = input.observed === null ? 0 : input.observations;

  // k = 0 disables shrinkage. With n = 0 as well there is nothing to divide by, and the
  // honest answer is the prior rather than a NaN that would propagate silently into a
  // ranking and sort unpredictably.
  const denominator = n + k;
  const value =
    denominator === 0 ? input.prior : (n * (input.observed ?? 0) + k * input.prior) / denominator;

  return {
    _shrunk: true,
    shrunkValue: value,
    basis: {
      observations: n,
      priorWeight: k,
      observed: input.observed,
      prior: input.prior,
      priorSource: input.priorSource,
      brandWeight: denominator === 0 ? 0 : n / denominator,
    },
  };
}
