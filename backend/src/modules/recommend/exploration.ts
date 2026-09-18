import { getConfig } from '../../platform/config';
import { shrunkValue, type ShrunkScore } from './shrinkage';

/**
 * Reserving part of every result set for things we have not learned about yet.
 *
 * ## Why this is not optional, and not a nicety
 *
 * A pure-exploitation recommender generates no observations outside what it already
 * recommends. The first thing that happens to do well becomes the only thing ever offered,
 * its sample grows while everything else stays frozen at zero, and the gap widens on its
 * own. docs/06 is blunt about the outcome: every feed converges on the same local maximum,
 * "the exact Predis.ai failure this product exists to beat".
 *
 * The send-time case is worse than the template case, because a scheduler that only ever
 * posts at 11am never finds out what 7pm would have done. The first lucky slot becomes
 * permanent.
 *
 * ## Uncertainty is already in the score
 *
 * `ShrinkageBasis.brandWeight` is `n / (n + k)`, so `1 - brandWeight` is `k / (n + k)` —
 * the share of the score that is still prior rather than evidence. That is exactly
 * "how little we know about this", and it needs no extra state to compute.
 *
 * ## Deliberately deterministic
 *
 * docs/06 asks for high-uncertainty slots rather than uniformly random ones, and picking
 * the most uncertain candidate is both a better bandit strategy and a testable one.
 * Randomness here would make a result set unreproducible between two refreshes of the same
 * page, and would make every assertion in this file probabilistic — which in practice
 * means the tests get written to pass rather than to check.
 *
 * Ties break toward the higher shrunk score: optimism under uncertainty. Among things we
 * know equally little about, try the one the category prior likes.
 */

export type SelectionKind = 'exploit' | 'explore';

export interface Selection<T> {
  readonly item: T;
  /**
   * Why this is in the result set.
   *
   * The UI must not drop this. An exploration pick is a different claim — "we haven't
   * tested this for you yet" — and presenting it as a recommendation would be a lie about
   * provenance, of the same kind the `ShrunkScore` brand exists to prevent.
   *
   * It is also what the publish path turns into `scheduleSource = EXPLORATION`, without
   * which the loop reads its own experiments back as evidence of what the brand wants.
   */
  readonly kind: SelectionKind;
  /** `k / (n + k)`: the share of this item's score that is still prior. */
  readonly uncertainty: number;
}

export interface ExplorationInputs<T> {
  /** Candidates, best-first. Not re-sorted; ranking is the caller's decision. */
  readonly ranked: readonly T[];
  readonly scoreOf: (item: T) => ShrunkScore;
  /** How many slots the result set has. */
  readonly count: number;
  /** Overrides `RECOMMEND_EXPLORATION_FRACTION`. */
  readonly fraction?: number;
}

/**
 * Fill `count` slots, reserving a share of them for the least-known candidates.
 *
 * Returns exploit picks in rank order followed by exploration picks. They are not
 * interleaved: an exploration pick generally sits far down the ranking, and splicing it
 * into a ranked list would imply a position the score does not support. The `kind` field
 * is what the UI groups on.
 */
export function withExploration<T>(inputs: ExplorationInputs<T>): Selection<T>[] {
  const { ranked, scoreOf, count } = inputs;
  const fraction = inputs.fraction ?? getConfig().recommend.explorationFraction;

  if (count <= 0 || ranked.length === 0) return [];

  const uncertaintyOf = (item: T) => 1 - scoreOf(item).basis.brandWeight;

  // At least one, whenever there is anything to explore *with*. The acceptance criterion
  // is that exploration slots appear in EVERY result set, and a brand with a rich history
  // is precisely the case where rounding a fraction down to zero would quietly remove
  // them — the brand that most needs breaking out of its local maximum.
  const wanted = Math.max(1, Math.round(count * fraction));
  const exploreSlots = Math.min(wanted, Math.max(0, ranked.length - 1), count);
  const exploitSlots = count - exploreSlots;

  const exploit = ranked.slice(0, exploitSlots);
  const taken = new Set<T>(exploit);

  const explore = [...ranked]
    .filter((item) => !taken.has(item))
    .sort((a, b) => {
      const byUncertainty = uncertaintyOf(b) - uncertaintyOf(a);
      if (byUncertainty !== 0) return byUncertainty;
      // Optimism under uncertainty: among equally unknown candidates, try the one the
      // prior likes. Without a tiebreak the order would fall out of input order, which is
      // the ranking — and exploration would quietly become exploitation's tail.
      return shrunkValue(scoreOf(b)) - shrunkValue(scoreOf(a));
    })
    .slice(0, exploreSlots);

  return [
    ...exploit.map((item) => ({
      item,
      kind: 'exploit' as const,
      uncertainty: uncertaintyOf(item),
    })),
    ...explore.map((item) => ({
      item,
      kind: 'explore' as const,
      uncertainty: uncertaintyOf(item),
    })),
  ];
}

/**
 * The send-time variant, which reserves a larger share.
 *
 * Separate config rather than a shared constant because docs/06 asks for 20–30% and is
 * explicit that timing needs more exploration than templates do: a template a brand never
 * tries is a missed opportunity, whereas a time slot a brand never tries is a permanent
 * blind spot in a schedule that repeats every week.
 */
export function withSendTimeExploration<T>(
  inputs: Omit<ExplorationInputs<T>, 'fraction'> & { fraction?: number },
): Selection<T>[] {
  return withExploration({
    ...inputs,
    fraction: inputs.fraction ?? getConfig().recommend.sendTimeExplorationFraction,
  });
}
