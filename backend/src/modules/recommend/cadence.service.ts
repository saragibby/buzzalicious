import type { TargetOutcome } from '../insight/insight.service';
import { getConfig } from '../../platform/config';
import { utcToZonedTime } from '../../platform/time';
import { buildNormalizer, normalizedOutcome } from './normalize';
import { NEUTRAL_PRIOR, resolvePrior, type CategoryAggregate } from './priors';
import { compareShrunk, shrink, shrunkValue, type ShrunkScore } from './shrinkage';

/**
 * How often to post.
 *
 * ## Total weekly outcome, never per-post average
 *
 * docs/06: "Optimizing per-post average pushes toward posting almost never, which scores
 * beautifully and grows nothing." This is not a rounding-error preference — the two
 * objectives disagree about the *direction* of the answer, and the wrong one is the one
 * that looks better on a dashboard. A brand that posts once a month and gets a good result
 * has an excellent per-post average and a dying account.
 *
 * So a week is the unit of observation and its score is a **sum**.
 *
 * ## Why the prior is `n`, and why this is the subtle part
 *
 * Everything else in this module shrinks toward a per-post neutral of `1.0`, meaning
 * "typical for this brand". A week of eight typical posts is not worth `1.0`; it is worth
 * `8.0`.
 *
 * Shrinking an eight-post week toward `1.0` would pull every high-volume band down hard
 * and every low-volume band barely at all, and the ranking would recommend posting less —
 * **reconstructing exactly the bias docs/06 forbids**, by way of a prior rather than by
 * way of an average. It would look like shrinkage working correctly.
 *
 * The prior for a band of `n` posts per week is therefore `n × perPostPrior`: "if every
 * post you publish is typical for you, a week of n posts is worth n." A band only beats
 * that by containing posts that did better than the brand's own typical.
 *
 * ## One score per post, not per target
 *
 * A post cross-published to four platforms is one cadence decision. Summing its four
 * targets would let a week of two widely-distributed posts outrank a week of four, scoring
 * distribution breadth as though it were frequency. Targets are averaged into a post
 * score first; posts are then summed into a week.
 *
 * ## Advisory only
 *
 * docs/06 requires a *range*, never a point, and never auto-scheduling. Getting cadence
 * wrong is visible to a brand's real audience in a way a mistimed post is not. The range
 * returned here is the observed plateau — the run of frequencies that are not
 * distinguishable from the best one — which is an honest description of what the data
 * supports rather than a false optimum.
 */

/** A single local week of the brand's history. */
export interface CadenceWeek {
  /** Monday of the week, as a local `YYYY-MM-DD` in the brand's zone. */
  readonly weekStart: string;
  /** Distinct posts published that week. */
  readonly posts: number;
  /**
   * Summed normalised outcome for the week, or `null` if nothing in it was measurable.
   *
   * `null` rather than `0`: a week whose posts all landed in a measurement blackout tells
   * us nothing about that cadence, and scoring it as zero would make the frequency look
   * actively harmful.
   */
  readonly totalOutcome: number | null;
}

/** All the weeks in which the brand posted exactly this many times. */
export interface CadenceBand {
  /** Posts per week. The band key. */
  readonly postsPerWeek: number;
  /** Weeks observed at this frequency, measurable or not. */
  readonly weeks: number;
  /** Weeks at this frequency with a measurable total. The `n` in the shrinkage formula. */
  readonly measuredWeeks: number;
  /** Expected total weekly outcome at this frequency. Not a number, by construction. */
  readonly score: ShrunkScore;
  /** Whether a brand-specific numeric claim about this frequency is permitted. */
  readonly claimable: boolean;
}

export interface CadenceRecommendation {
  readonly weeks: CadenceWeek[];
  readonly bands: CadenceBand[];
  /** Median posts per week across observed weeks, or `null` with no history. */
  readonly currentPerWeek: number | null;
  /**
   * The advisory range, or `null` when nothing measurable supports one.
   *
   * `null` is a real answer and the UI must render it as "not enough history yet", not as
   * a default suggestion. A cadence number invented from no evidence is the one output in
   * this module that a brand can act on to its own detriment.
   */
  readonly suggested: { readonly minPerWeek: number; readonly maxPerWeek: number } | null;
  /**
   * Set when a frequency above the suggested range performed *worse* than the range.
   *
   * docs/06: diminishing returns and a fatigue cliff "look identical in the data until you
   * cross the cliff". This reports only the case where the brand has actually crossed it —
   * it is evidence of a cliff, never a prediction of one.
   */
  readonly fatigueAbove: number | null;
  readonly basis: 'brand-weeks' | 'none';
}

export interface CadenceInputs {
  readonly targets: TargetOutcome[];
  /** IANA zone the brand's weeks are measured in. */
  readonly timeZone: string;
  /** Per-post category prior, if one is known. Scaled by band size before shrinking. */
  readonly aggregate?: CategoryAggregate | null;
  /** Overrides `SHRINKAGE_K`. */
  readonly k?: number;
  /**
   * How far below the best band's trend line a neighbouring frequency may sit and still be
   * reported as indistinguishable from it, in units of one typical post.
   *
   * Not a proportion of the best total, which was the first thing tried and is wrong: two
   * bands differ in total *by construction* because they differ in size, so a 10% window
   * around a 5-post week's total can never contain a 4-post week however well it did. A
   * proportional tolerance silently collapses every range to a single number — which is
   * the false precision docs/06 explicitly warns against.
   *
   * So the comparison is against what the best band's per-post efficiency predicts at the
   * neighbour's size, and the slack is one typical post: the granularity of the decision
   * the user is actually making.
   *
   * Not an env var. It is a statement about the unit of the decision, not a tuning knob.
   */
  readonly slackPosts?: number;
}

const DEFAULT_SLACK_POSTS = 1;

export function recommendCadence(inputs: CadenceInputs): CadenceRecommendation {
  const { targets, timeZone, aggregate, k } = inputs;
  const slackPosts = inputs.slackPosts ?? DEFAULT_SLACK_POSTS;
  const minSample = getConfig().recommend.minSampleForClaim;

  const weeks = summariseWeeks(targets, timeZone);
  if (weeks.length === 0) {
    return {
      weeks,
      bands: [],
      currentPerWeek: null,
      suggested: null,
      fatigueAbove: null,
      basis: 'none',
    };
  }

  // The per-post prior, resolved once. `resolvePrior` already refuses to invent a category
  // opinion that is not there, falling through to the neutral 1.0.
  const perPost = resolvePrior({ key: 'cadence', aggregate });

  const byCount = new Map<number, CadenceWeek[]>();
  for (const week of weeks) {
    const bucket = byCount.get(week.posts);
    if (bucket) bucket.push(week);
    else byCount.set(week.posts, [week]);
  }

  const bands: CadenceBand[] = [...byCount.entries()]
    .map(([postsPerWeek, inBand]) => {
      const totals = inBand
        .map((week) => week.totalOutcome)
        .filter((total): total is number => total !== null);

      return {
        postsPerWeek,
        weeks: inBand.length,
        measuredWeeks: totals.length,
        score: shrink({
          observed: meanOrNull(totals),
          observations: totals.length,
          // The load-bearing line. See the header.
          prior: postsPerWeek * perPost.prior,
          priorSource: perPost.source,
          k,
        }),
        claimable: totals.length >= minSample,
      };
    })
    .sort((a, b) => a.postsPerWeek - b.postsPerWeek);

  const measured = bands.filter((band) => band.measuredWeeks > 0);
  if (measured.length === 0) {
    return {
      weeks,
      bands,
      currentPerWeek: medianCount(weeks),
      suggested: null,
      fatigueAbove: null,
      basis: 'none',
    };
  }

  const best = [...measured].sort((a, b) => compareShrunk(a.score, b.score))[0]!;

  // What one more typical post is worth at this brand's own level, which is the slack unit
  // and also the trend line the neighbours are judged against.
  const efficiency = shrunkValue(best.score) / best.postsPerWeek;
  const slack = slackPosts * perPost.prior;

  // The range has to be contiguous in *frequency*, not merely consecutive in the observed
  // list. A brand that has only ever posted once or eight times a week has two adjacent
  // entries in that list and two frequencies seven apart in reality; treating them as
  // neighbours would produce the range "1 to 8 posts a week", which is not advice.
  const plateau = contiguousRun(
    measured,
    best,
    (band) => shrunkValue(band.score) >= efficiency * band.postsPerWeek - slack,
  );

  const top = plateau[plateau.length - 1]!;
  const beyond = measured.filter((band) => band.postsPerWeek > top.postsPerWeek);
  const fatigueAbove = beyond.length > 0 ? top.postsPerWeek : null;

  return {
    weeks,
    bands,
    currentPerWeek: medianCount(weeks),
    suggested: {
      minPerWeek: plateau[0]!.postsPerWeek,
      maxPerWeek: top.postsPerWeek,
    },
    fatigueAbove,
    basis: 'brand-weeks',
  };
}

/**
 * Collapse targets into local weeks.
 *
 * Exported because the week summary is worth showing on its own — "you posted 3, 5, 2, 6
 * times over the last four weeks" is more useful to a brand than any single number, and it
 * is the evidence behind the range.
 */
export function summariseWeeks(targets: TargetOutcome[], timeZone: string): CadenceWeek[] {
  const normalizer = buildNormalizer(targets);

  // Post id -> its target scores, so a cross-post counts once. Collected before bucketing
  // because a post's targets all share its publish instant.
  const byPost = new Map<string, { weekStart: string; scores: number[] }>();
  for (const target of targets) {
    if (!target.publishedAt) continue;
    const weekStart = localWeekStart(target.publishedAt, timeZone);
    const entry = byPost.get(target.postId) ?? { weekStart, scores: [] };
    const score = normalizedOutcome(target, normalizer).score;
    if (score !== null) entry.scores.push(score);
    byPost.set(target.postId, entry);
  }

  const byWeek = new Map<string, { posts: number; scores: number[] }>();
  for (const { weekStart, scores } of byPost.values()) {
    const week = byWeek.get(weekStart) ?? { posts: 0, scores: [] };
    week.posts += 1;
    // One score per post: the mean of its targets, not their sum. See the header.
    if (scores.length > 0) week.scores.push(mean(scores));
    byWeek.set(weekStart, week);
  }

  return [...byWeek.entries()]
    .map(([weekStart, week]) => ({
      weekStart,
      posts: week.posts,
      totalOutcome: week.scores.length > 0 ? sum(week.scores) : null,
    }))
    .sort((a, b) => (a.weekStart < b.weekStart ? -1 : 1));
}

/**
 * The Monday of the local week an instant falls in, as `YYYY-MM-DD`.
 *
 * Derived from the local date, not the UTC one. A Sunday evening post in Denver is already
 * Monday in UTC, and bucketing it into the following week would move outcome across a week
 * boundary — quietly, and only for brands west of Greenwich.
 */
export function localWeekStart(instant: Date, timeZone: string): string {
  const localDate = utcToZonedTime(instant, timeZone).slice(0, 10);
  // Date-only arithmetic in UTC, which has no DST and so cannot shift a calendar date.
  const day = new Date(`${localDate}T00:00:00Z`);
  const weekday = day.getUTCDay();
  const backToMonday = weekday === 0 ? 6 : weekday - 1;
  day.setUTCDate(day.getUTCDate() - backToMonday);
  return day.toISOString().slice(0, 10);
}

/**
 * Walk outward from the best band through *consecutive frequencies* that qualify.
 *
 * `ordered[i - 1]` is only a neighbour of `ordered[i]` if their frequencies differ by one.
 * An unobserved frequency ends the run: we have no evidence about it, and stepping over it
 * would assert that a gap we never tested behaves like its ends.
 */
function contiguousRun(
  bands: CadenceBand[],
  seed: CadenceBand,
  included: (band: CadenceBand) => boolean,
): CadenceBand[] {
  const ordered = [...bands].sort((a, b) => a.postsPerWeek - b.postsPerWeek);
  const start = ordered.findIndex((band) => band.postsPerWeek === seed.postsPerWeek);

  let low = start;
  while (
    low - 1 >= 0 &&
    ordered[low - 1]!.postsPerWeek === ordered[low]!.postsPerWeek - 1 &&
    included(ordered[low - 1]!)
  ) {
    low -= 1;
  }

  let high = start;
  while (
    high + 1 < ordered.length &&
    ordered[high + 1]!.postsPerWeek === ordered[high]!.postsPerWeek + 1 &&
    included(ordered[high + 1]!)
  ) {
    high += 1;
  }

  return ordered.slice(low, high + 1);
}

function medianCount(weeks: CadenceWeek[]): number | null {
  if (weeks.length === 0) return null;
  const counts = weeks.map((week) => week.posts).sort((a, b) => a - b);
  const mid = Math.floor(counts.length / 2);
  return counts.length % 2 === 0 ? (counts[mid - 1]! + counts[mid]!) / 2 : counts[mid]!;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function mean(values: number[]): number {
  return sum(values) / values.length;
}

function meanOrNull(values: number[]): number | null {
  return values.length === 0 ? null : mean(values);
}

/** Re-exported so callers can state the per-post neutral the band priors are built from. */
export { NEUTRAL_PRIOR };
