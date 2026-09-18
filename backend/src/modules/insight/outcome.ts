import { getConfig } from '../../platform/config';

/**
 * The outcome score — one number per published target, and the thing W8 ranks on.
 *
 * ## Why outcomes rather than engagement
 *
 * A like costs nothing and means nothing. The weights in config put clicks and saves
 * ahead of likes deliberately (docs/06): a save is someone intending to come back, a
 * click is someone who actually did. Ranking on raw engagement would recommend whatever
 * gets scrolled past most pleasantly, which is the thing this product exists not to do.
 *
 * ## Unavailable is not zero, and it changes the denominator
 *
 * Every input is nullable, because platforms differ in what they expose and a personal
 * Instagram account exposes almost nothing. Treating a missing metric as `0` would score
 * a post low for the sin of being published where we cannot measure — and because the
 * penalty is systematic per platform, the recommender would learn to avoid the platform
 * rather than the content.
 *
 * So a missing component is dropped from **both** the numerator and the denominator: the
 * score is the weighted average of the components we actually have. A post measured on
 * clicks alone is scored on clicks alone, and `components` reports what went in so a
 * caller can refuse to compare two scores built from different things.
 *
 * ## Not comparable across posts without a denominator
 *
 * This returns a rate-free weighted blend, not a percentage. Normalising against reach
 * belongs to W8, which owns shrinkage and has the corpus to do it against. Doing it here
 * with a sample of one would produce confident nonsense for every new account.
 */

export interface OutcomeInputs {
  linkClicks?: number | null;
  saves?: number | null;
  shares?: number | null;
  likes?: number | null;
  comments?: number | null;
}

export interface OutcomeScore {
  /** `null` when nothing was measurable — never `0`, which would be a claim. */
  score: number | null;
  /** Which weighted components contributed. Empty means the score is null. */
  components: OutcomeComponent[];
  /** Sum of the weights that contributed. 1 means everything was available. */
  coverage: number;
  /**
   * The un-normalised weighted total, for a caller that wants the other trade.
   *
   * Normalising by coverage is the right default — it stops a platform that reports
   * fewer metrics from ranking systematically below one that reports more, which would
   * look like a content signal and is not. The cost is that a score with a single
   * component is just that component's raw value, because the weight cancels: `1 click`
   * and `1 like` both come out at 1, and `comparable()` is what keeps them from being
   * ranked against each other.
   *
   * W8 owns ranking and may reasonably want a click to outrank a like even unblended, so
   * the raw sum is returned rather than discarded. Recorded here as an author's decision;
   * it has not been reviewed by anyone.
   */
  weightedSum: number | null;
}

export type OutcomeComponent = 'click' | 'save' | 'share' | 'engage';

/**
 * A component's value, or `null` where the platform did not report it.
 *
 * `engage` folds likes and comments together because they are the two cheapest signals
 * and neither is worth its own weight. It counts as measured when *either* is present:
 * requiring both would discard the component on every platform that exposes one, which
 * is most of them at the smaller account tiers this product serves.
 */
function componentValues(inputs: OutcomeInputs): Record<OutcomeComponent, number | null> {
  const engagement = [inputs.likes, inputs.comments].filter(
    (value): value is number => value !== null && value !== undefined,
  );

  return {
    click: inputs.linkClicks ?? null,
    save: inputs.saves ?? null,
    share: inputs.shares ?? null,
    engage: engagement.length === 0 ? null : engagement.reduce((sum, v) => sum + v, 0),
  };
}

/** Weight order, most meaningful first. */
const COMPONENTS: OutcomeComponent[] = ['click', 'save', 'share', 'engage'];

export function outcomeScore(inputs: OutcomeInputs): OutcomeScore {
  const weights = getConfig().outcome.weights;
  const values = componentValues(inputs);

  let weighted = 0;
  let coverage = 0;
  const components: OutcomeComponent[] = [];

  for (const key of COMPONENTS) {
    const value = values[key];
    // `null` means "not measured". `0` is a real measurement and must go in — a post
    // that genuinely earned nothing is information, not an absence.
    if (value === null) continue;

    weighted += value * weights[key];
    coverage += weights[key];
    components.push(key);
  }

  if (components.length === 0) {
    return { score: null, components: [], coverage: 0, weightedSum: null };
  }

  // Divide by the coverage actually achieved, so a post measured on one component is not
  // penalised against a post measured on four.
  return { score: weighted / coverage, components, coverage, weightedSum: weighted };
}

export function comparable(a: OutcomeScore, b: OutcomeScore): boolean {
  if (a.score === null || b.score === null) return false;
  return a.components.join(',') === b.components.join(',');
}
