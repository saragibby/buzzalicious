import { describe, expect, it } from 'vitest';
import { makeTarget, resetTargetSeq } from '../../../tests/fixtures/target-outcome';
import { localWeekStart, recommendCadence, summariseWeeks } from './cadence.service';
import { buildNormalizer, normalizedOutcome } from './normalize';
import { shrunkValue } from './shrinkage';

const DENVER = 'America/Denver';

/**
 * Build `weeks` consecutive local weeks, each containing `posts` posts with `clicks` link
 * clicks against a fixed 1,000 impressions.
 *
 * Posts are placed on Wednesday midday local so that nothing in these fixtures sits near a
 * week boundary — week bucketing is tested separately and should not be able to perturb
 * the scoring tests by accident.
 */
function weeksOf(options: {
  weeks: number;
  posts: number;
  clicks: number | null;
  startMonday: string;
}) {
  const out = [];
  for (let week = 0; week < options.weeks; week += 1) {
    const monday = new Date(`${options.startMonday}T00:00:00Z`);
    monday.setUTCDate(monday.getUTCDate() + week * 7 + 2);
    const day = monday.toISOString().slice(0, 10);

    for (let post = 0; post < options.posts; post += 1) {
      out.push(
        makeTarget({
          // The start date is in the id because two calls to this helper otherwise
          // generate the same ids and their posts silently merge into one.
          postId: `${options.startMonday}-w${week}-p${post}-${options.posts}`,
          publishedAt: new Date(`${day}T19:00:00Z`),
          linkClicks: options.clicks,
          impressions: options.clicks === null ? null : 1000,
        }),
      );
    }
  }
  return out;
}

describe('cadence is scored on total weekly outcome', () => {
  it('does not let one great post outrank eight good ones', () => {
    resetTargetSeq();
    // The requirement from docs/06, as arithmetic.
    //
    // 4 weeks of 8 posts at 10 clicks / 1,000 impressions, and 2 weeks of a single post at
    // 30 clicks. 32 of the 34 posts sit at a 0.01 click rate, so the brand median is 0.01
    // and the lone posts normalise to 3.0.
    //
    //   8-post week: each post 0.45*1.0 + 0.55 = 1.00  -> week total 8.00
    //   1-post week: each post 0.45*3.0 + 0.55 = 1.90  -> week total 1.90
    //
    // shrunk toward a prior of n posts, k = 5:
    //   band 8: (4*8.00 + 5*8) / 9 = 8.00
    //   band 1: (2*1.90 + 5*1) / 7 = 1.26
    const targets = [
      ...weeksOf({ weeks: 4, posts: 8, clicks: 10, startMonday: '2026-01-05' }),
      ...weeksOf({ weeks: 2, posts: 1, clicks: 30, startMonday: '2026-03-02' }),
    ];

    const result = recommendCadence({ targets, timeZone: DENVER });
    const band = (n: number) => result.bands.find((b) => b.postsPerWeek === n)!;

    expect(shrunkValue(band(8).score)).toBeCloseTo(8.0, 2);
    expect(shrunkValue(band(1).score)).toBeCloseTo(1.26, 2);
    expect(result.suggested).toEqual({ minPerWeek: 8, maxPerWeek: 8 });
  });

  it('would rank the other way on per-post average, which is the point', () => {
    resetTargetSeq();
    // FALSIFYING CONTROL for the test above. Without this, "band 8 wins" could simply mean
    // the fixture never posed the question — per-post average has to genuinely prefer the
    // single great post, or the assertion above is vacuous.
    const targets = [
      ...weeksOf({ weeks: 4, posts: 8, clicks: 10, startMonday: '2026-01-05' }),
      ...weeksOf({ weeks: 2, posts: 1, clicks: 30, startMonday: '2026-03-02' }),
    ];

    const normalizer = buildNormalizer(targets);
    const perPost = (posts: number) => {
      const scores = targets
        .filter((t) => t.postId.endsWith(`-${posts}`))
        .map((t) => normalizedOutcome(t, normalizer).score)
        .filter((s): s is number => s !== null);
      return scores.reduce((a, b) => a + b, 0) / scores.length;
    };

    // The rarely-posting band has the better average, and a per-post objective would
    // therefore recommend posting once a week.
    expect(perPost(1)).toBeCloseTo(1.9, 2);
    expect(perPost(8)).toBeCloseTo(1.0, 2);
    expect(perPost(1)).toBeGreaterThan(perPost(8));
  });

  it('shrinks a band toward n typical posts, not toward one', () => {
    resetTargetSeq();
    // The load-bearing prior. A neutral per-post prior of 1.0 applied to a week's *total*
    // would drag every high-volume band toward 1.0 and rebuild the "post less" bias by
    // another route — while looking exactly like shrinkage working.
    //
    // A single week of 6 entirely typical posts: observed total 6.0, prior 6*1.0 = 6, so
    // shrinkage cannot move it. If the prior were 1.0 it would land at (1*6 + 5*1)/6 =
    // 1.83 instead.
    const targets = weeksOf({ weeks: 1, posts: 6, clicks: 10, startMonday: '2026-01-05' });

    const result = recommendCadence({ targets, timeZone: DENVER });
    const band = result.bands.find((b) => b.postsPerWeek === 6)!;

    expect(shrunkValue(band.score)).toBeCloseTo(6.0, 2);
    expect(band.score.basis.prior).toBe(6);
    expect(shrunkValue(band.score)).toBeGreaterThan(1.83);
  });

  it('counts a cross-posted post once, and averages its targets', () => {
    resetTargetSeq();
    // One post, four platforms, one cadence decision. Summing targets would score a week
    // of two widely-distributed posts above a week of four, ranking distribution breadth
    // as though it were frequency.
    const targets = [
      makeTarget({ postId: 'multi', platform: 'X', publishedAt: new Date('2026-01-07T19:00:00Z') }),
      makeTarget({
        postId: 'multi',
        platform: 'INSTAGRAM',
        publishedAt: new Date('2026-01-07T19:00:00Z'),
      }),
      makeTarget({
        postId: 'multi',
        platform: 'FACEBOOK',
        publishedAt: new Date('2026-01-07T19:00:00Z'),
      }),
      makeTarget({
        postId: 'multi',
        platform: 'THREADS',
        publishedAt: new Date('2026-01-07T19:00:00Z'),
      }),
    ];

    const [week] = summariseWeeks(targets, DENVER);

    expect(week!.posts).toBe(1);
    // POSITIVE CONTROL: it is measured, so this is one-post-counted-once rather than
    // everything having been filtered out.
    expect(week!.totalOutcome).not.toBeNull();
    expect(week!.totalOutcome).toBeLessThan(2);
  });
});

describe('diminishing returns and the fatigue cliff', () => {
  it('reports a frequency above the range that actually did worse', () => {
    resetTargetSeq();
    // 6 weeks at 3 posts with 20 clicks, and 6 weeks at 7 posts with 2 clicks. 42 of the
    // 60 posts sit at 0.002, so that is the median and the 3-post weeks normalise to 10x.
    //
    //   band 3: post 0.45*10 + 0.55 = 5.05 -> total 15.15 -> (6*15.15 + 5*3)/11  = 9.63
    //   band 7: post 0.45*1.0 + 0.55 = 1.00 -> total  7.00 -> (6*7.00 + 5*7)/11  = 7.00
    const targets = [
      ...weeksOf({ weeks: 6, posts: 3, clicks: 20, startMonday: '2026-01-05' }),
      ...weeksOf({ weeks: 6, posts: 7, clicks: 2, startMonday: '2026-04-06' }),
    ];

    const result = recommendCadence({ targets, timeZone: DENVER });

    expect(result.suggested).toEqual({ minPerWeek: 3, maxPerWeek: 3 });
    expect(result.fatigueAbove).toBe(3);
  });

  it('reports no cliff when the higher frequency held up', () => {
    resetTargetSeq();
    // POSITIVE CONTROL for the cliff. A `fatigueAbove` that is set whenever any higher
    // band exists is not a cliff detector, it is a restatement of the band list — this is
    // the fixture that tells the two apart.
    const targets = [
      ...weeksOf({ weeks: 6, posts: 3, clicks: 10, startMonday: '2026-01-05' }),
      ...weeksOf({ weeks: 6, posts: 7, clicks: 10, startMonday: '2026-04-06' }),
    ];

    const result = recommendCadence({ targets, timeZone: DENVER });

    expect(result.suggested!.maxPerWeek).toBe(7);
    expect(result.fatigueAbove).toBeNull();
  });

  it('suggests a range rather than a point when bands are indistinguishable', () => {
    resetTargetSeq();
    // docs/06 requires a range. Two adjacent frequencies performing within the plateau
    // tolerance of one another must both be inside it — reporting a single number would
    // be false precision about a difference the data cannot support.
    const targets = [
      ...weeksOf({ weeks: 5, posts: 4, clicks: 10, startMonday: '2026-01-05' }),
      ...weeksOf({ weeks: 5, posts: 5, clicks: 10, startMonday: '2026-03-09' }),
    ];

    const result = recommendCadence({ targets, timeZone: DENVER });

    expect(result.suggested).toEqual({ minPerWeek: 4, maxPerWeek: 5 });
  });
});

describe('cadence refuses to invent a number', () => {
  it('returns no suggestion with no history at all', () => {
    resetTargetSeq();
    const result = recommendCadence({ targets: [], timeZone: DENVER });

    expect(result.suggested).toBeNull();
    expect(result.basis).toBe('none');
    expect(result.currentPerWeek).toBeNull();
  });

  it('returns no suggestion when history exists but none of it was measurable', () => {
    resetTargetSeq();
    // The interior case, not the endpoint. A brand that posted plenty into a measurement
    // blackout has weeks, bands and a current cadence — everything except evidence. The
    // hazard is that the bands still carry a shrunk score, which is entirely prior, and
    // ranking them would produce a confident recommendation made of nothing.
    const targets = weeksOf({ weeks: 4, posts: 3, clicks: null, startMonday: '2026-01-05' });

    const result = recommendCadence({ targets, timeZone: DENVER });

    expect(result.weeks).toHaveLength(4);
    expect(result.currentPerWeek).toBe(3);
    expect(result.bands).toHaveLength(1);
    // The band exists and is entirely prior, which is exactly why no range is offered.
    expect(result.bands[0]!.measuredWeeks).toBe(0);
    expect(result.bands[0]!.claimable).toBe(false);
    expect(result.suggested).toBeNull();
    expect(result.basis).toBe('none');
  });

  it('scores an unmeasured week as null rather than zero', () => {
    resetTargetSeq();
    // A zero would make the frequency look actively harmful rather than unmeasured, and
    // would drag its band down — the "a zero is a lie" rule, at week granularity.
    // Three measurable posts, not two: below the normaliser's minimum sample there is no
    // median, so the measurable week would come back null as well and the positive control
    // would be asserting the wrong thing.
    const targets = [
      ...weeksOf({ weeks: 1, posts: 3, clicks: 10, startMonday: '2026-01-05' }),
      ...weeksOf({ weeks: 1, posts: 3, clicks: null, startMonday: '2026-01-12' }),
    ];

    const weeks = summariseWeeks(targets, DENVER);

    // POSITIVE CONTROL: the measurable week did produce a number, so the null below is a
    // refusal to score rather than the normaliser failing for both.
    expect(weeks[0]!.totalOutcome).not.toBeNull();
    expect(weeks[1]!.totalOutcome).toBeNull();
    expect(weeks[1]!.posts).toBe(3);
  });
});

describe('weeks are local weeks', () => {
  it('keeps a Sunday evening post in the week it was local, not the UTC one', () => {
    // 2026-01-05 is a Monday. Sunday 11 January at 19:00 Denver is already Monday 12
    // January in UTC, so a UTC-bucketed week would push it into the following week —
    // silently, and only for brands west of Greenwich.
    const sundayEvening = new Date('2026-01-12T02:00:00Z');

    expect(localWeekStart(sundayEvening, DENVER)).toBe('2026-01-05');
    // POSITIVE CONTROL: read in UTC the very same instant belongs to the next week, so the
    // assertion above is a zone conversion and not a constant.
    expect(localWeekStart(sundayEvening, 'UTC')).toBe('2026-01-12');
  });

  it('starts weeks on Monday', () => {
    expect(localWeekStart(new Date('2026-01-05T18:00:00Z'), DENVER)).toBe('2026-01-05');
    expect(localWeekStart(new Date('2026-01-11T18:00:00Z'), DENVER)).toBe('2026-01-05');
    expect(localWeekStart(new Date('2026-01-12T18:00:00Z'), DENVER)).toBe('2026-01-12');
  });

  it('does not shift a week boundary across a DST transition', () => {
    // The week containing 8 March 2026 is 23 hours shorter than the others. Date-only
    // arithmetic cannot notice; instant arithmetic would.
    expect(localWeekStart(new Date('2026-03-09T18:00:00Z'), DENVER)).toBe('2026-03-09');
    expect(localWeekStart(new Date('2026-03-08T18:00:00Z'), DENVER)).toBe('2026-03-02');
    expect(localWeekStart(new Date('2026-11-01T18:00:00Z'), DENVER)).toBe('2026-10-26');
  });

  it('reports the median weekly cadence over the observed weeks', () => {
    resetTargetSeq();
    const targets = [
      ...weeksOf({ weeks: 2, posts: 2, clicks: 10, startMonday: '2026-01-05' }),
      ...weeksOf({ weeks: 3, posts: 6, clicks: 10, startMonday: '2026-02-02' }),
    ];

    const result = recommendCadence({ targets, timeZone: DENVER });

    // Five weeks: 2, 2, 6, 6, 6. The median is what the brand typically does, which is a
    // different question from what worked.
    expect(result.currentPerWeek).toBe(6);
  });
});
