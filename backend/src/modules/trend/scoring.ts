import { TrendStatus } from '@prisma/client';
import { engagementOf, volumeOf } from './trend.schemas';

/**
 * Scoring: velocity, momentum, lifecycle.
 *
 * Every function here is pure. No database, no `Date.now()` — `now` is always a parameter.
 * That is not stylistic: docs/07 requires that scoring can be re-run over the full signal
 * history whenever the algorithm changes, and a function that reads the clock produces a
 * different answer on every run, which makes "re-run and compare" meaningless. It is also
 * why the whole engine is testable without Postgres.
 *
 * The thesis, from docs/07 and ADR-0007: **velocity, not volume**, and saturation is a
 * penalty rather than a bonus. A hashtag at 10M posts and flat is useless to a small
 * business; one at 50K and doubling is actionable. Generic trend tools rank by popularity,
 * which is precisely the ranking that makes a small business look late and identical to
 * everyone else. Favouring emerging trends is the product, not a tuning choice.
 */

export interface ScoringInput {
  firstSeenAt: Date;
  signals: { observedAt: Date; metrics: unknown }[];
}

export interface TrendScore {
  velocity: number;
  acceleration: number;
  engagementRate: number;
  saturation: number;
  ageDecay: number;
  momentum: number;
  status: TrendStatus;
  /** The instant of the highest observed volume, or null if nothing has turned over. */
  peakedAt: Date | null;
  /** How much of the input was usable. Two points is the minimum for any velocity at all. */
  usableSignals: number;
}

/**
 * Momentum weights. They sum to 1 across the positive terms so momentum stays roughly
 * 0..1 and is comparable across trends, which is what makes `feedScore` a product of
 * interpretable factors rather than an arbitrary scale.
 */
export const WEIGHTS = {
  velocity: 0.45,
  acceleration: 0.25,
  engagement: 0.3,
  saturation: 0.35,
  ageDecay: 0.2,
} as const;

/**
 * Divisor floor for velocity. Without it, a trend going from 1 mention to 20 scores a
 * velocity of 19 and buries a genuine trend going from 40,000 to 90,000. Noise at the
 * very bottom of the volume range is not a trend; it is one person posting twice.
 */
export const VOLUME_FLOOR = 250;

/** Volume at which a trend counts as fully saturated. Log-scaled, so the exact value is soft. */
export const SATURATION_CEILING = 5_000_000;

/**
 * Volume below which a trend is not saturated at all.
 *
 * Without a floor the log curve is measured from a single post, which puts a trend at
 * 50K — squarely in the window a small business can still own — at nearly 0.8 saturated
 * and penalises it almost as hard as one at 10M. The floor is what makes the penalty
 * discriminate between "early" and "everywhere" rather than between "small" and "large".
 */
export const SATURATION_FLOOR = 10_000;

/** Velocity below this magnitude is flat, not a direction. Prevents lifecycle flapping. */
export const FLAT_VELOCITY = 0.05;

/** Days after which a trend with no fresh signal is stale regardless of its last velocity. */
export const STALE_AFTER_DAYS = 21;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Squashes an unbounded rate into 0..1 without a hard clip that flattens the top end. */
function norm(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const positive = Math.max(value, 0);
  return positive / (1 + positive);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

interface Observation {
  at: number;
  volume: number;
  engagement: number | null;
}

/**
 * Usable observations, oldest first.
 *
 * Signals are append-only and may arrive out of order from different collectors, so this
 * sorts rather than trusting insertion order. Observations with no volume are dropped —
 * see `volumeOf` on why a missing volume is not a zero.
 */
function observations(signals: ScoringInput['signals']): Observation[] {
  return signals
    .map((signal) => ({
      at: signal.observedAt.getTime(),
      volume: volumeOf(signal.metrics),
      engagement: engagementOf(signal.metrics),
    }))
    .filter((o): o is Observation => o.volume !== null)
    .sort((a, b) => a.at - b.at);
}

/**
 * Rate of change between two observations, normalized per day.
 *
 * Per-day normalization matters because collectors do not run on a uniform schedule. A
 * 50% rise over six hours and the same rise over six days are not the same trend, and
 * comparing the raw deltas would rank them identically.
 */
function velocityBetween(from: Observation, to: Observation): number {
  const days = Math.max((to.at - from.at) / DAY_MS, 1 / 24);
  const base = Math.max(from.volume, VOLUME_FLOOR);
  return (to.volume - from.volume) / base / days;
}

/**
 * Scores one trend from its signal history.
 *
 * Degrades rather than throws. A trend with a single observation has no velocity and is
 * left `EMERGING` at low momentum: that is genuinely what one data point supports, and
 * inventing a number from it would corrupt the ranking with false confidence.
 */
export function scoreTrend(input: ScoringInput, now: Date): TrendScore {
  const points = observations(input.signals);
  const nowMs = now.getTime();

  const empty: TrendScore = {
    velocity: 0,
    acceleration: 0,
    engagementRate: 0,
    saturation: 0,
    ageDecay: 0,
    momentum: 0,
    status: TrendStatus.EMERGING,
    peakedAt: null,
    usableSignals: points.length,
  };

  if (points.length === 0) return empty;

  const latest = points[points.length - 1]!;

  if (points.length === 1) {
    return {
      ...empty,
      saturation: saturationOf(latest.volume),
      ageDecay: ageDecayOf(latest.at, nowMs),
      engagementRate: engagementRateOf(latest),
    };
  }

  const previous = points[points.length - 2]!;
  const velocity = velocityBetween(previous, latest);

  // Acceleration compares the most recent interval against the one before it. With only
  // two points there is no prior interval, and zero is the honest answer.
  const acceleration =
    points.length >= 3 ? velocity - velocityBetween(points[points.length - 3]!, previous) : 0;

  const engagementRate = engagementRateOf(latest);
  const saturation = saturationOf(latest.volume);
  const ageDecay = ageDecayOf(latest.at, nowMs);

  const momentum = clamp01(
    WEIGHTS.velocity * norm(velocity) +
      WEIGHTS.acceleration * norm(acceleration) +
      WEIGHTS.engagement * engagementRate -
      WEIGHTS.saturation * saturation -
      WEIGHTS.ageDecay * ageDecay,
  );

  const peak = points.reduce(
    (best, point) => (point.volume > best.volume ? point : best),
    points[0]!,
  );
  const status = lifecycleOf({ velocity, acceleration, lastSeenAt: latest.at, now: nowMs });

  return {
    velocity,
    acceleration,
    engagementRate,
    saturation,
    ageDecay,
    momentum,
    status,
    // A trend that is still climbing has not peaked. Recording its current high as a peak
    // would make `peakedAt` mean "highest so far", which is not what the feed reads it as.
    peakedAt: status === TrendStatus.EMERGING ? null : new Date(peak.at),
    usableSignals: points.length,
  };
}

/** Engagement per unit of volume, squashed to 0..1. Absent engagement scores 0, not a guess. */
function engagementRateOf(point: Observation): number {
  if (point.engagement === null || point.volume <= 0) return 0;
  return norm(point.engagement / point.volume);
}

/**
 * How thoroughly a trend has already been covered, 0..1.
 *
 * Log-scaled between `SATURATION_FLOOR` and `SATURATION_CEILING`, because the interesting
 * distinction is between 20K and 500K, not between 4M and 5M — by either of the latter the
 * trend is equally exhausted for a small business.
 */
export function saturationOf(volume: number): number {
  if (volume <= SATURATION_FLOOR) return 0;
  return clamp01(
    Math.log10(volume / SATURATION_FLOOR) / Math.log10(SATURATION_CEILING / SATURATION_FLOOR),
  );
}

/** Staleness of the most recent observation, 0..1 over `STALE_AFTER_DAYS`. */
export function ageDecayOf(lastSeenAtMs: number, nowMs: number): number {
  const days = (nowMs - lastSeenAtMs) / DAY_MS;
  return clamp01(days / STALE_AFTER_DAYS);
}

export interface LifecycleInput {
  velocity: number;
  acceleration: number;
  lastSeenAt: number;
  now: number;
}

/**
 * `EMERGING → PEAKING → DECLINING → STALE`, from the sign of velocity and acceleration.
 *
 * Only `EMERGING` and early `PEAKING` reach the feed (docs/07), so the boundary between
 * "still climbing" and "rolling over" is the single most consequential line in this file:
 * it decides what a user is shown this week.
 *
 * Silence outranks everything. A trend nobody has observed in three weeks is stale no
 * matter how fast it was moving when we last looked — that reading is the one thing we
 * know is out of date.
 */
export function lifecycleOf({
  velocity,
  acceleration,
  lastSeenAt,
  now,
}: LifecycleInput): TrendStatus {
  if ((now - lastSeenAt) / DAY_MS >= STALE_AFTER_DAYS) return TrendStatus.STALE;

  if (velocity <= -FLAT_VELOCITY) return TrendStatus.DECLINING;

  // Flat is not emerging. A trend that has stopped moving has already had its moment,
  // and putting it in the feed spends a user's week on yesterday.
  if (velocity < FLAT_VELOCITY) return TrendStatus.PEAKING;

  // Rising but decelerating is the top of the curve — still worth surfacing, but it is
  // peaking rather than emerging, and the feed treats those differently.
  return acceleration < 0 ? TrendStatus.PEAKING : TrendStatus.EMERGING;
}

/** Statuses the per-brand feed may surface. Showing a declining trend wastes the week. */
export const FEEDABLE_STATUSES: readonly TrendStatus[] = [
  TrendStatus.EMERGING,
  TrendStatus.PEAKING,
];

export function isFeedable(status: TrendStatus): boolean {
  return FEEDABLE_STATUSES.includes(status);
}
