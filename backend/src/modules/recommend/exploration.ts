import { getConfig } from '../../platform/config';
import { shrunkValue, type ShrunkScore } from './shrinkage';
import { localWeekStart } from './cadence.service';

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
 *
 * ## Determinism alone starves, so the ordering rotates
 *
 * `brandWeight` is `n / (n + k)`, and `n` counts posts the brand actually *made* with a
 * candidate — not times we showed it. So a candidate that is offered and declined is,
 * next refresh, in precisely the state that got it offered: uncertainty `1`, tie-broken to
 * the front, chosen again. With a small reservation that is often a single slot, and one
 * declined candidate is enough to pin it permanently. Every other untried candidate waits
 * behind it forever, while the feature reports as working and every test stays green — the
 * explored set has size one.
 *
 * Randomness would fix this by accident and cost reproducibility: a result set that
 * changes on refresh is a support burden, and makes every assertion here probabilistic.
 * Instead the selection window rotates over a **caller-supplied bucket**. Within a bucket
 * the output is exactly reproducible; across buckets a declined candidate yields its slot.
 *
 * The bucket is a required parameter and is never read from the clock here. A default
 * would be `0`, which is the starving behaviour restored silently at any call site that
 * forgot to pass one — and that is the bug, not a degraded version of it.
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
  /**
   * Which rotation window to take. Required, and deliberately not defaulted.
   *
   * Callers pass `rotationBucket(now, brand.timeZone)`. Tests pass an integer directly, so
   * they stay exact. Equal buckets give identical output; consecutive buckets move the
   * window on, which is what stops a declined candidate holding the slot forever.
   */
  readonly rotation: number;
  /** Overrides `RECOMMEND_EXPLORATION_FRACTION`. */
  readonly fraction?: number;
}

/**
 * The rotation window for an instant: a week index in the brand's own zone.
 *
 * A week is long enough that a user refreshing a page, or coming back the next day to
 * finish something, sees the same recommendations — and short enough that a declined
 * candidate yields its slot while the decline is still relevant.
 *
 * Shares `localWeekStart` with cadence rather than defining a second notion of "week".
 * Two week definitions in one module would drift, and the failure would be a quiet
 * off-by-one in what got explored rather than anything that looks like a bug.
 */
export function rotationBucket(instant: Date, timeZone: string): number {
  const monday = localWeekStart(instant, timeZone);
  const days = Date.parse(`${monday}T00:00:00Z`) / MS_PER_DAY;
  return Math.round(days / 7);
}

const MS_PER_DAY = 86_400_000;

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

  const pool = [...ranked]
    .filter((item) => !taken.has(item))
    .sort((a, b) => {
      const byUncertainty = uncertaintyOf(b) - uncertaintyOf(a);
      if (byUncertainty !== 0) return byUncertainty;
      // Optimism under uncertainty: among equally unknown candidates, try the one the
      // prior likes. Without a tiebreak the order would fall out of input order, which is
      // the ranking — and exploration would quietly become exploitation's tail.
      return shrunkValue(scoreOf(b)) - shrunkValue(scoreOf(a));
    });

  const explore = rotate(pool, rotateOver(pool, scoreOf), inputs.rotation, exploreSlots);

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
 * Which part of the pool the rotation is allowed to move over.
 *
 * Only genuinely under-sampled candidates. Rotating over the whole pool would eventually
 * hand an exploration slot to something we have already measured properly, which is
 * exploitation wearing an `explore` label — a mislabel of exactly the kind the `kind`
 * field exists to prevent.
 *
 * Falls back to the whole pool when nothing is under-sampled, because the acceptance
 * criterion is that an exploration slot appears in *every* result set. For a brand that
 * has measured everything well, the least-known candidate is still the honest pick.
 */
function rotateOver<T>(pool: readonly T[], scoreOf: (item: T) => ShrunkScore): readonly T[] {
  const minSample = getConfig().recommend.minSampleForClaim;
  const underSampled = pool.filter((item) => scoreOf(item).basis.observations < minSample);
  return underSampled.length > 0 ? underSampled : pool;
}

/**
 * Take `slots` items from `source`, starting `rotation` windows in, then top up from
 * `pool` in order if `source` could not fill the reservation.
 *
 * The offset steps by whole windows rather than by one, so consecutive buckets show
 * disjoint sets and every under-sampled candidate gets a turn within
 * `ceil(source.length / slots)` buckets. Stepping by one would overlap the windows and
 * take proportionally longer to cover the pool.
 */
function rotate<T>(pool: readonly T[], source: readonly T[], rotation: number, slots: number): T[] {
  if (slots <= 0 || source.length === 0) return [];

  const window = Math.max(1, slots);
  // Modulo twice: a negative rotation is a caller error rather than a crash, and `%` in
  // JS keeps the sign of the left operand.
  const offset =
    (((Math.trunc(rotation) * window) % source.length) + source.length) % source.length;

  const picked: T[] = [];
  const seen = new Set<T>();
  for (let i = 0; i < source.length && picked.length < slots; i += 1) {
    const item = source[(offset + i) % source.length];
    if (seen.has(item)) continue;
    seen.add(item);
    picked.push(item);
  }
  for (const item of pool) {
    if (picked.length >= slots) break;
    if (seen.has(item)) continue;
    seen.add(item);
    picked.push(item);
  }
  return picked;
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
