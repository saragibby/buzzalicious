import { getConfig } from '../../platform/config';
import { priorIsAboutCategory } from './priors';
import { type ShrunkScore } from './shrinkage';

/**
 * Turning a score into a sentence we are willing to stand behind.
 *
 * ## Why this is a payload and not a string
 *
 * docs/06 wants the UI to render "why this" without re-deriving the reasoning, so that the
 * recommendation and its justification cannot disagree. A formatted string would push
 * copy, pluralisation and locale into a service, and — worse — would let the call site
 * pick its own wording for a number whose provenance it can no longer see.
 *
 * ## The hazard this file exists to contain
 *
 * A recommendation is ranked on a `ShrunkScore`. A claim is a statement about what we
 * **measured**. Those are different numbers and the whole module is built around not
 * confusing them, but this is the one place where a caller is actively looking for a
 * number to put in front of a user — so it is the likeliest place for the shrunk value to
 * be rendered as though it were an observation.
 *
 * `multiplier` is therefore taken from `basis.observed`, the brand's own raw mean, and
 * never from `shrunkValue()`. The difference is not cosmetic: at `n = 5` and `k = 5` a
 * shrunk value is half prior, so "2.4x your average" could be reporting a number the brand
 * never achieved, assembled partly from other businesses. That sentence would be a
 * fabrication with a true-looking number in it, which is the worst available outcome for a
 * feature whose entire purpose is earning trust.
 *
 * ## Three gates, and they are not interchangeable
 *
 * 1. **Sample.** Under `RECOMMEND_MIN_SAMPLE_FOR_CLAIM` posts, no brand-specific claim.
 * 2. **Materiality.** Above the sample floor a result can still be unremarkable; see
 *    `RECOMMEND_MIN_CLAIM_MULTIPLIER`.
 * 3. **Provenance.** Category framing is only honest when the prior actually came from the
 *    category. `priorIsAboutCategory` is what stops "popular with coffee shops" being
 *    rendered over a neutral prior — which is to say, over nothing at all.
 *
 * Failing a gate never produces silence. It produces a weaker, still-true claim.
 */

export type ExplanationKind =
  /** "Your Before/After posts drove 2.4x more link clicks than your average." */
  | 'brand-claim'
  /** "Popular with coffee shops." A statement about the category, not about this brand. */
  | 'category-claim'
  /** "You haven't tried this yet." No performance claim of any kind is supportable. */
  | 'no-claim';

export interface Explanation {
  readonly kind: ExplanationKind;
  /**
   * How much better than this brand's own typical post, on `brand-claim` only.
   *
   * **Raw, and measured.** This is `basis.observed`, never the shrunk value. `normalize.ts`
   * already scales a brand's outcomes so that `1.0` is its own median, so this number is
   * literally "x your average" with no further arithmetic — which is also why an error
   * here would be invisible: any plausible wrong number is still a plausible multiplier.
   *
   * `null` on every other kind. Not `1`, which would read as "exactly typical" — a claim.
   */
  readonly multiplier: number | null;
  /** Measurable posts behind the claim. The `n`, so the UI can say "over your last 8". */
  readonly sampleSize: number;
  /**
   * The category the framing refers to, on `category-claim` only.
   *
   * `null` means we have a category-derived prior but no label for it, and the UI must say
   * "businesses like yours" rather than naming one. Naming the wrong category is a more
   * damaging error than declining to name any.
   */
  readonly category: string | null;
  /**
   * Whether the brand has never posted this at all.
   *
   * Distinct from `sampleSize === 0`, which also covers "posted four times, none of them
   * measurable". "You haven't tried this" and "we couldn't measure what happened when you
   * did" are different sentences, and only one of them is about the user.
   */
  readonly untried: boolean;
  /**
   * Which number the materiality floor was applied to, and which number `multiplier` is.
   *
   * Recorded rather than left to be inferred, because the choice is not obvious and the
   * two options are indistinguishable downstream — both are plausible multipliers.
   *
   * It is `raw-observed` for a reason worth stating. A floor applied to the *shrunk* value
   * would be a second sample-size gate wearing a materiality label: shrinkage pulls every
   * estimate toward a prior of about `1.0`, so a thin sample is dragged under a `1.2` floor
   * by its thinness rather than by its performance — and `minSampleForClaim` is already the
   * gate for that, calibrated separately. Stacking them would mean a template with `n = 12`
   * and a genuine `1.3x` silently losing its sentence while its basis says the sample was
   * ample. Gating the raw number keeps the two gates answering the two different questions
   * they were each designed for: "did we see enough?" and "was what we saw worth saying?"
   */
  readonly claimBasis: ClaimBasis;
  /**
   * Why this is in the result set at all, passed through from the selection.
   *
   * An exploration pick is not a recommendation and the UI must not frame it as one, even
   * when the category prior likes it.
   */
  readonly selection: 'exploit' | 'explore';
}

export interface ExplanationInputs {
  readonly score: ShrunkScore;
  /** Measurable posts with this candidate. The claim gate's `n`. */
  readonly scored: number;
  /** Published posts with this candidate, measurable or not. */
  readonly posts: number;
  /** Whether the sample gate passed. Computed by the scorer, not re-derived here. */
  readonly claimable: boolean;
  readonly selection: 'exploit' | 'explore';
  /** Display name of the brand's category, when there is one. */
  readonly category?: string | null;
  /** Overrides `RECOMMEND_MIN_CLAIM_MULTIPLIER`. */
  readonly minMultiplier?: number;
}

/**
 * The candidate numbers a claim could be built from, keyed by the label that names them.
 *
 * This table is the point. `claimBasis` used to be a string literal written *alongside* the
 * comparison, which made it decorative: switch the comparison to the shrunk value and the
 * payload would keep announcing `raw-observed`, confidently and falsely, and nothing could
 * catch it. A provenance field that can be wrong about the thing it describes is worse than
 * no field at all, because downstream will believe it.
 *
 * Here the label **is** the selector. There is no way to read a different number without
 * naming a different basis, so the two cannot drift apart — the same argument that makes
 * `ShrunkScore` a brand rather than a comment.
 */
const CLAIM_SOURCES = {
  'raw-observed': (score: ShrunkScore) => score.basis.observed,
  shrunk: (score: ShrunkScore) => score.shrunkValue,
} as const;

export type ClaimBasis = keyof typeof CLAIM_SOURCES;

/** Which one we use, and therefore what every payload reports. See the field docs. */
const CLAIM_BASIS: ClaimBasis = 'raw-observed';

/** One decimal, which is the most precision a claim like this can honestly carry. */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Build the strongest claim the evidence supports, and no stronger.
 *
 * Reads top-down as a ladder: brand claim, else category framing, else nothing. Each rung
 * is reachable only by failing the one above it, so there is no combination of inputs that
 * produces a claim two rungs stronger than its evidence.
 */
export function explain(inputs: ExplanationInputs): Explanation {
  const { score, scored, posts, claimable, selection } = inputs;
  const minMultiplier = inputs.minMultiplier ?? getConfig().recommend.minClaimMultiplier;
  const category = inputs.category ?? null;
  const untried = posts === 0;

  const base = { sampleSize: scored, untried, selection, claimBasis: CLAIM_BASIS } as const;

  // Read through the same key that gets reported, so the number and its label are one
  // decision rather than two that happen to agree today.
  const observed = CLAIM_SOURCES[CLAIM_BASIS](score);

  if (claimable && observed !== null && observed >= minMultiplier) {
    return { ...base, kind: 'brand-claim', multiplier: round1(observed), category };
  }

  if (priorIsAboutCategory(score.basis.priorSource)) {
    return { ...base, kind: 'category-claim', multiplier: null, category };
  }

  return { ...base, kind: 'no-claim', multiplier: null, category: null };
}
