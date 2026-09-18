import type { ClickHour } from '../link/rollup.service';
import type { TargetOutcome } from '../insight/insight.service';
import { getConfig } from '../../platform/config';
import { daypartForHour, SEND_TIME_SLOTS, type SendTimeSlot } from '../brand/category.schemas';
import { utcToZonedTime, zonedTimeToUtc } from '../../platform/time';
import { buildNormalizer, normalizedOutcome } from './normalize';
import { RecommendInvariantError } from './recommend.errors';
import { resolvePrior, type CategoryAggregate } from './priors';
import { compareShrunk, shrink, type PriorSource, type ShrunkScore } from './shrinkage';

/**
 * Learning when to post, in eight coarse slots.
 *
 * ## Why the intent is stored and the instant is derived, not the other way round
 *
 * A suggestion is a **local wall time plus a zone** — `2026-03-08T09:00` in
 * `America/Denver` — and the UTC instant is computed from it at the moment of scheduling.
 * Doing it the other way, storing an instant and rendering it locally, is the bug docs/06
 * exists to prevent: "every Tuesday at 9am" becomes 8am or 10am the week the clocks
 * change, and it keeps working perfectly for months before it does.
 *
 * This matters more here than anywhere else in the product, because a send-time
 * recommender is the one component whose whole output is a time. If the recommendation
 * drifts an hour twice a year, the feedback loop then measures the drifted time, decides
 * the slot underperforms, and moves the brand off a slot that was fine. The failure is
 * silent, self-confirming, and looks like learning.
 *
 * `suggestedTimeFor` therefore returns the local string as the primary value and the
 * instant as a derived convenience. `sendtime.service.test.ts` pins this across a real
 * boundary — 8 March 2026 in `America/Denver` — rather than asserting a UTC offset, which
 * a test running in UTC would pass without proving anything.
 *
 * ## Slots come from `publishedAt`, not from `scheduleSlot`
 *
 * `Post.scheduleSlot` records the slot we *scheduled into*, and is null for every post the
 * user timed themselves — which is most of them, and disproportionately the ones whose
 * timing carries real information. Bucketing `publishedAt` in the brand's zone works for
 * every post regardless of how it was scheduled, and describes when the post actually went
 * out rather than when we meant it to.
 *
 * ## Quiet hours have no bucket
 *
 * `daypartForHour` returns `null` between 23:00 and 05:00, and a post published then is
 * excluded from slot scoring rather than folded into `evening`. Folding would let the
 * scheduler suggest 2am off the back of one well-performing insomniac post, and docs/06
 * forbids auto-scheduling overnight in the audience's zone without opt-in.
 */

/** Where a slot's score came from before any outcome data existed. */
export type SlotPriorBasis =
  /** The brand's own audience click histogram. Its data, not a category's. */
  | 'brand-clicks'
  /** Category priors or hand-seeded defaults. See `priors.ts`. */
  | 'category'
  /** Nothing. The slot scores neutral and must not be described as a recommendation. */
  | 'none';

export interface SlotScore {
  readonly slot: SendTimeSlot;
  readonly score: ShrunkScore;
  /** Posts in this slot with a normalisable outcome. */
  readonly scored: number;
  /** Published posts in this slot, measurable or not. */
  readonly posts: number;
  /** Where the prior came from, for copy that has to be honest about its basis. */
  readonly priorBasis: SlotPriorBasis;
  /** Whether a brand-specific claim about this slot is permitted. */
  readonly claimable: boolean;
}

/** The slot a moment falls in, in the brand's zone. `null` during quiet hours. */
export function slotForInstant(instant: Date, timeZone: string): SendTimeSlot | null {
  const local = utcToZonedTime(instant, timeZone);
  const hour = Number(local.slice(11, 13));
  const daypart = daypartForHour(hour);
  if (!daypart) return null;

  // Derived from the same local string as the hour, so a post near midnight cannot be
  // assigned a weekday from one zone and an hour from another.
  const dayOfWeek = new Date(`${local}:00Z`).getUTCDay();
  const dayType = dayOfWeek === 0 || dayOfWeek === 6 ? 'weekend' : 'weekday';

  return `${dayType}:${daypart}` as SendTimeSlot;
}

/**
 * Turn a click histogram into slot weights on the 0..1 scale `priors.ts` expects.
 *
 * Bot clicks are dropped, not netted off: a crawler hit is not a negative human click, and
 * subtracting it would let publish-time crawler traffic push the brand's own publish hour
 * *below* zero and out of contention.
 */
export function slotWeightsFromClicks(hours: ClickHour[]): Record<string, number> {
  const totals = new Map<string, number>();

  for (const bucket of hours) {
    const daypart = daypartForHour(bucket.hour);
    if (!daypart) continue;
    const dayType = bucket.dayOfWeek === 0 || bucket.dayOfWeek === 6 ? 'weekend' : 'weekday';
    const slot = `${dayType}:${daypart}`;
    totals.set(slot, (totals.get(slot) ?? 0) + bucket.clicks);
  }

  const max = Math.max(0, ...totals.values());
  if (max <= 0) return {};

  return Object.fromEntries([...totals].map(([slot, clicks]) => [slot, clicks / max]));
}

export interface SlotScoreInputs {
  readonly targets: TargetOutcome[];
  /** IANA zone. Never a UTC offset, which changes twice a year. */
  readonly timeZone: string;
  /** The brand's own audience click histogram, the strongest cold-start basis. */
  readonly clickHours?: ClickHour[] | null;
  /** Category aggregates by slot, with the brand's own posts already excluded. */
  readonly aggregates?: Readonly<Record<string, CategoryAggregate>> | null;
  /** Hand-seeded `BusinessCategory.priors.sendTimeSlots`. */
  readonly seed?: Readonly<Record<string, number>> | null;
  /** Hand-seeded per-platform slot defaults. */
  readonly platformDefaults?: Readonly<Record<string, number>> | null;
  readonly k?: number;
}

/**
 * Score all eight slots, best first.
 *
 * Every slot is always returned, including ones the brand has never posted in — the same
 * reason archetype candidates are passed in rather than derived. A scheduler that only
 * considers slots it has already used generates no observations anywhere else, and the
 * first lucky time becomes permanent.
 */
export function scoreSlots(inputs: SlotScoreInputs): SlotScore[] {
  const minSample = getConfig().recommend.minSampleForClaim;
  const { targets, timeZone, clickHours, aggregates, seed, platformDefaults, k } = inputs;

  const normalizer = buildNormalizer(targets);
  const clickWeights = clickHours?.length ? slotWeightsFromClicks(clickHours) : {};
  const hasClickSignal = Object.keys(clickWeights).length > 0;

  const scores = SEND_TIME_SLOTS.map((slot) => {
    const mine = targets.filter(
      (target) => target.publishedAt && slotForInstant(target.publishedAt, timeZone) === slot,
    );
    const values = mine
      .map((target) => normalizedOutcome(target, normalizer).score)
      .filter((value): value is number => value !== null);

    // An explicit tier chain rather than one `resolvePrior` call with the brand's clicks
    // smuggled into the `seed` slot. The send-time stack has four rungs where the
    // archetype stack has three, and overloading an argument to carry the extra one would
    // make `priorSource` mean something different here than it does in `priors.ts` —
    // provenance that changes meaning by call site is not provenance.
    const prior = resolveSlotPrior({
      slot,
      aggregate: aggregates?.[slot],
      clickWeights: hasClickSignal ? clickWeights : null,
      seed,
      platformDefaults,
    });

    return {
      slot,
      score: shrink({
        observed: values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length,
        observations: values.length,
        prior: prior.prior,
        priorSource: prior.source,
        k,
      }),
      scored: values.length,
      posts: mine.length,
      priorBasis: prior.basis,
      claimable: values.length >= minSample,
    };
  });

  return scores.sort((a, b) => compareShrunk(a.score, b.score));
}

/**
 * The send-time prior stack from the brief: the brand's own click histogram, then category
 * priors, then hand-seeded platform defaults.
 *
 * The click histogram sits **above** category priors and below a category aggregate built
 * from real outcomes. It is the brand's own audience, which beats other businesses'
 * guesses; it is not an outcome, which is why measured category performance still wins.
 */
function resolveSlotPrior(inputs: {
  slot: SendTimeSlot;
  aggregate?: CategoryAggregate | null;
  clickWeights: Record<string, number> | null;
  seed?: Readonly<Record<string, number>> | null;
  platformDefaults?: Readonly<Record<string, number>> | null;
}): { prior: number; source: PriorSource; basis: SlotPriorBasis } {
  const { slot, aggregate, clickWeights, seed, platformDefaults } = inputs;

  const fromAggregate = resolvePrior({ key: slot, aggregate });
  if (fromAggregate.source === 'category-aggregate') {
    return { ...fromAggregate, basis: 'category' };
  }

  if (clickWeights) {
    const fromClicks = resolvePrior({ key: slot, seed: clickWeights });
    // Reported as `category-seed` because that is what it structurally is to shrinkage —
    // a rescaled weight, not a measured outcome — while `basis` records that the weight
    // was this brand's own traffic. Two facts, two fields.
    if (fromClicks.source === 'category-seed') {
      return { ...fromClicks, basis: 'brand-clicks' };
    }
  }

  const fromSeed = resolvePrior({ key: slot, seed, platformDefaults });
  return { ...fromSeed, basis: fromSeed.source === 'neutral' ? 'none' : 'category' };
}

/** A concrete time to post, expressed the way it must be stored. */
export interface SuggestedTime {
  readonly slot: SendTimeSlot;
  /** `YYYY-MM-DDTHH:mm`. **The intent, and the value that must be persisted.** */
  readonly local: string;
  /** IANA zone the local time is expressed in. */
  readonly timeZone: string;
  /** Derived from `local` + `timeZone`. Convenience — never the source of truth. */
  readonly instant: Date;
}

/**
 * The hour within each daypart a suggestion lands on.
 *
 * Mid-bucket rather than the boundary: a slot is a four-to-five hour band and the
 * boundaries are arbitrary product lines, so suggesting 09:00 for `midday` would put every
 * suggestion one minute from being reclassified as `early`.
 */
const DAYPART_HOUR = { early: 7, midday: 11, afternoon: 16, evening: 20 } as const;

/**
 * The next occurrence of `slot` at or after `from`, as a local wall time.
 *
 * Returns the local string first and the instant second, deliberately. Callers persist
 * `local` and `timeZone` into `Post.scheduledLocal` / `scheduledTz`, which is what keeps a
 * recurring suggestion stable across a DST transition; `instant` is for `scheduledAt` and
 * is recomputed from the intent, never the other way round.
 */
export function suggestedTimeFor(
  slot: SendTimeSlot,
  timeZone: string,
  from: Date = new Date(),
): SuggestedTime {
  const [dayType, daypart] = slot.split(':') as ['weekday' | 'weekend', keyof typeof DAYPART_HOUR];
  const hour = DAYPART_HOUR[daypart];

  // Walk forward in local days rather than by adding 24 hours to an instant. A DST day is
  // 23 or 25 hours long, so instant arithmetic would skip or repeat a local date — and it
  // would do so exactly once every six months, which is the hardest kind of bug to catch.
  const startLocal = utcToZonedTime(from, timeZone).slice(0, 10);

  for (let offset = 0; offset < 14; offset += 1) {
    const date = addLocalDays(startLocal, offset);
    const dayOfWeek = new Date(`${date}T00:00:00Z`).getUTCDay();
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
    if ((dayType === 'weekend') !== isWeekend) continue;

    const local = `${date}T${String(hour).padStart(2, '0')}:00`;
    const instant = zonedTimeToUtc(local, timeZone);
    if (instant.getTime() < from.getTime()) continue;

    return { slot, local, timeZone, instant };
  }

  // Unreachable: every day type recurs within a week, so fourteen days always contains
  // one. Throwing rather than returning a silently wrong time, because a send-time
  // recommender that returns a plausible-looking wrong instant is worse than one that
  // fails loudly.
  throw new RecommendInvariantError(
    `No ${slot} occurrence within 14 days of ${startLocal} in ${timeZone}`,
  );
}

/** Add whole calendar days to a `YYYY-MM-DD`, with no instant arithmetic involved. */
function addLocalDays(date: string, days: number): string {
  const shifted = new Date(`${date}T00:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}
