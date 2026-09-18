import { describe, expect, it } from 'vitest';
import { TrendStatus } from '@prisma/client';
import {
  FLAT_VELOCITY,
  STALE_AFTER_DAYS,
  isFeedable,
  lifecycleOf,
  saturationOf,
  scoreTrend,
  type ScoringInput,
} from './scoring';

const NOW = new Date('2026-03-01T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * DAY_MS);
}

/** `[daysAgo, volume]` pairs, oldest first, the way the seed expresses a history. */
function history(points: [number, number][], key = 'volume'): ScoringInput {
  return {
    firstSeenAt: daysAgo(points[0]![0]),
    signals: points.map(([d, volume]) => ({
      observedAt: daysAgo(d),
      metrics: { [key]: volume },
    })),
  };
}

describe('scoreTrend', () => {
  it('reads the volume W2\u2019s seed writes, not just the name in the schema', () => {
    // The seed writes `mentions`; TrendSignalMetricsSchema names the field `volume`. If
    // the scorer only understood one of them, every seeded trend would score zero and the
    // mismatch would look like a scoring bug rather than a vocabulary one.
    const asVolume = scoreTrend(
      history([
        [10, 1000],
        [5, 4000],
      ]),
      NOW,
    );
    const asMentions = scoreTrend(
      history(
        [
          [10, 1000],
          [5, 4000],
        ],
        'mentions',
      ),
      NOW,
    );

    expect(asMentions.velocity).toBeCloseTo(asVolume.velocity, 10);
    expect(asMentions.velocity).toBeGreaterThan(0);
  });

  it('ignores an observation with no volume rather than reading it as zero', () => {
    // A collector reporting engagement but not volume has not observed zero posts.
    // Treating it as zero invents a cliff and flips a rising trend to DECLINING.
    const score = scoreTrend(
      {
        firstSeenAt: daysAgo(10),
        signals: [
          { observedAt: daysAgo(10), metrics: { volume: 1000 } },
          { observedAt: daysAgo(5), metrics: { volume: 4000 } },
          { observedAt: daysAgo(1), metrics: { engagement: 90 } },
        ],
      },
      NOW,
    );

    expect(score.usableSignals).toBe(2);
    expect(score.velocity).toBeGreaterThan(0);
    expect(score.status).not.toBe(TrendStatus.DECLINING);
  });

  it('ranks a fast-growing small trend above a flat enormous one', () => {
    // The thesis of the whole engine (docs/07, ADR-0007). If this inverts, the feed is
    // a popularity list and the product has no differentiation left.
    const emerging = scoreTrend(
      history([
        [6, 12_000],
        [4, 26_000],
        [2, 58_000],
      ]),
      NOW,
    );
    const saturated = scoreTrend(
      history([
        [6, 9_800_000],
        [4, 9_850_000],
        [2, 9_860_000],
      ]),
      NOW,
    );

    expect(emerging.momentum).toBeGreaterThan(saturated.momentum);
    expect(emerging.status).toBe(TrendStatus.EMERGING);
  });

  it('does not let a trend of one mention going to twenty outrank a real one', () => {
    // Without VOLUME_FLOOR this scores a velocity of ~19 and buries everything else.
    const noise = scoreTrend(
      history([
        [2, 1],
        [1, 20],
      ]),
      NOW,
    );
    const real = scoreTrend(
      history([
        [2, 40_000],
        [1, 90_000],
      ]),
      NOW,
    );

    expect(real.momentum).toBeGreaterThan(noise.momentum);
  });

  it('normalizes velocity per day, so the same rise over longer is slower', () => {
    const fast = scoreTrend(
      history([
        [2, 10_000],
        [1, 15_000],
      ]),
      NOW,
    );
    const slow = scoreTrend(
      history([
        [12, 10_000],
        [1, 15_000],
      ]),
      NOW,
    );

    expect(fast.velocity).toBeGreaterThan(slow.velocity);
  });

  it('returns a zero score with no signals instead of throwing', () => {
    const score = scoreTrend({ firstSeenAt: daysAgo(3), signals: [] }, NOW);

    expect(score.momentum).toBe(0);
    expect(score.status).toBe(TrendStatus.EMERGING);
    expect(score.peakedAt).toBeNull();
  });

  it('claims no velocity from a single observation', () => {
    // One data point supports no rate of change. Inventing one would give the ranking
    // false confidence about a trend we have looked at exactly once.
    const score = scoreTrend(history([[1, 5000]]), NOW);

    expect(score.velocity).toBe(0);
    expect(score.acceleration).toBe(0);
    expect(score.usableSignals).toBe(1);
  });

  it('sorts signals by observation time rather than trusting insertion order', () => {
    // Signals are append-only and several collectors write them, so arrival order is not
    // observation order. Reading them unsorted inverts the sign of velocity.
    const ordered = scoreTrend(
      history([
        [6, 1000],
        [3, 4000],
        [1, 9000],
      ]),
      NOW,
    );
    const shuffled = scoreTrend(
      history([
        [3, 4000],
        [1, 9000],
        [6, 1000],
      ]),
      NOW,
    );

    expect(shuffled.velocity).toBeCloseTo(ordered.velocity, 10);
    expect(shuffled.status).toBe(ordered.status);
  });

  it('is deterministic, so re-running scoring over history reproduces the result', () => {
    // The acceptance criterion behind every `now`-as-a-parameter signature here.
    const input = history([
      [9, 900],
      [6, 2400],
      [3, 5100],
      [1, 7000],
    ]);

    expect(scoreTrend(input, NOW)).toEqual(scoreTrend(input, NOW));
  });

  it('leaves a still-climbing trend with no peak', () => {
    const score = scoreTrend(
      history([
        [5, 1000],
        [3, 3000],
        [1, 9000],
      ]),
      NOW,
    );

    expect(score.status).toBe(TrendStatus.EMERGING);
    expect(score.peakedAt).toBeNull();
  });

  it('records the peak instant once a trend has turned over', () => {
    const score = scoreTrend(
      history([
        [9, 4000],
        [6, 31_000],
        [1, 12_000],
      ]),
      NOW,
    );

    expect(score.status).toBe(TrendStatus.DECLINING);
    expect(score.peakedAt).toEqual(daysAgo(6));
  });
});

describe('lifecycleOf', () => {
  const base = { lastSeenAt: NOW.getTime() - DAY_MS, now: NOW.getTime() };

  it('treats silence as stale regardless of the last velocity seen', () => {
    // The last reading is the one thing we know is out of date.
    expect(
      lifecycleOf({
        velocity: 5,
        acceleration: 2,
        lastSeenAt: NOW.getTime() - (STALE_AFTER_DAYS + 1) * DAY_MS,
        now: NOW.getTime(),
      }),
    ).toBe(TrendStatus.STALE);
  });

  it('calls a rising, accelerating trend emerging', () => {
    expect(lifecycleOf({ ...base, velocity: 0.8, acceleration: 0.3 })).toBe(TrendStatus.EMERGING);
  });

  it('calls a rising but decelerating trend peaking, not emerging', () => {
    expect(lifecycleOf({ ...base, velocity: 0.8, acceleration: -0.4 })).toBe(TrendStatus.PEAKING);
  });

  it('does not call a flat trend emerging', () => {
    // Flat means the moment has passed; surfacing it spends a user's week on yesterday.
    expect(lifecycleOf({ ...base, velocity: FLAT_VELOCITY / 2, acceleration: 0.9 })).toBe(
      TrendStatus.PEAKING,
    );
  });

  it('calls a falling trend declining', () => {
    expect(lifecycleOf({ ...base, velocity: -0.6, acceleration: -0.2 })).toBe(
      TrendStatus.DECLINING,
    );
  });
});

describe('isFeedable', () => {
  it('surfaces only emerging and peaking trends', () => {
    expect(isFeedable(TrendStatus.EMERGING)).toBe(true);
    expect(isFeedable(TrendStatus.PEAKING)).toBe(true);
    expect(isFeedable(TrendStatus.DECLINING)).toBe(false);
    expect(isFeedable(TrendStatus.STALE)).toBe(false);
  });
});

describe('saturationOf', () => {
  it('rises with volume and stays within 0..1', () => {
    expect(saturationOf(0)).toBe(0);
    expect(saturationOf(50_000)).toBeLessThan(saturationOf(500_000));
    expect(saturationOf(50_000_000)).toBeLessThanOrEqual(1);
  });

  it('does not penalise a trend still small enough to own', () => {
    // A trend a small business can still be early to is not saturated, and scoring it as
    // half-saturated is what would push the feed back toward ranking by popularity.
    expect(saturationOf(8_000)).toBe(0);
    expect(saturationOf(60_000)).toBeLessThan(0.5);
    expect(saturationOf(5_000_000)).toBe(1);
  });
});
