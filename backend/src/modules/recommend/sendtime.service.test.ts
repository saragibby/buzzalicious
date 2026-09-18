import { describe, expect, it } from 'vitest';
import { makeTarget, makeTargets } from '../../../tests/fixtures/target-outcome';
import { SEND_TIME_SLOTS, daypartForHour } from '../brand/category.schemas';
import type { ClickHour } from '../link/rollup.service';
import {
  scoreSlots,
  slotForInstant,
  slotWeightsFromClicks,
  suggestedTimeFor,
} from './sendtime.service';
import { shrunkValue } from './shrinkage';

const DENVER = 'America/Denver';

/**
 * The DST requirement, pinned against a real boundary rather than an offset.
 *
 * 8 March 2026 is when the United States springs forward. Denver is UTC-7 (MST) before it
 * and UTC-6 (MDT) after, verified against the IANA database rather than assumed.
 *
 * A test that asserts a UTC instant would pass in a UTC-only environment while proving
 * nothing, so the assertion is on the **local wall time**, which is the value that has to
 * stay put, with the instants checked separately to prove a real conversion happened.
 */
describe('a suggested time survives a DST transition', () => {
  const beforeSpring = new Date('2026-03-06T15:00:00Z'); // Friday, MST
  const afterSpring = new Date('2026-03-09T15:00:00Z'); // Monday, MDT

  it('suggests the same local wall time on both sides of spring forward', () => {
    const before = suggestedTimeFor('weekday:midday', DENVER, beforeSpring);
    const after = suggestedTimeFor('weekday:midday', DENVER, afterSpring);

    expect(before.local).toBe('2026-03-06T11:00');
    expect(after.local).toBe('2026-03-09T11:00');
    expect(before.local.slice(11)).toBe(after.local.slice(11));
  });

  it('moves the UTC instant by exactly the offset change', () => {
    // POSITIVE CONTROL, and the assertion that makes the one above mean something. If the
    // conversion were a no-op — or if the suggestion were built from an instant and merely
    // rendered locally — these two would be the same hour and the test above would still
    // pass. 11:00 MST is 18:00Z; 11:00 MDT is 17:00Z.
    const before = suggestedTimeFor('weekday:midday', DENVER, beforeSpring);
    const after = suggestedTimeFor('weekday:midday', DENVER, afterSpring);

    expect(before.instant.toISOString()).toBe('2026-03-06T18:00:00.000Z');
    expect(after.instant.toISOString()).toBe('2026-03-09T17:00:00.000Z');
    expect(before.instant.getUTCHours()).not.toBe(after.instant.getUTCHours());
  });

  it('survives falling back as well as springing forward', () => {
    // 1 November 2026, the other direction. A bug that clamps rather than converts can
    // pass one boundary and fail the other.
    const before = suggestedTimeFor('weekday:midday', DENVER, new Date('2026-10-30T15:00:00Z'));
    const after = suggestedTimeFor('weekday:midday', DENVER, new Date('2026-11-02T15:00:00Z'));

    expect(before.local).toBe('2026-10-30T11:00');
    expect(after.local).toBe('2026-11-02T11:00');
    expect(before.instant.toISOString()).toBe('2026-10-30T17:00:00.000Z');
    expect(after.instant.toISOString()).toBe('2026-11-02T18:00:00.000Z');
  });

  it('is stable in a zone that has no DST at all', () => {
    // POSITIVE CONTROL of the opposite kind: in a fixed-offset zone the instants must NOT
    // move. Without this, an implementation that shifted everything by an hour
    // unconditionally would pass every assertion above.
    // Earlier in the day than the Denver cases deliberately: 11:00Z on 6 March is already
    // past at 15:00Z, so the search would correctly roll forward to the next weekday and
    // this control would be testing roll-forward rather than the offset.
    const before = suggestedTimeFor('weekday:midday', 'UTC', new Date('2026-03-06T09:00:00Z'));
    const after = suggestedTimeFor('weekday:midday', 'UTC', new Date('2026-03-09T09:00:00Z'));

    expect(before.instant.toISOString()).toBe('2026-03-06T11:00:00.000Z');
    expect(after.instant.toISOString()).toBe('2026-03-09T11:00:00.000Z');
    expect(before.instant.getUTCHours()).toBe(after.instant.getUTCHours());
  });

  it('does not skip a local date when walking across the transition day', () => {
    // Adding 24 hours to an instant skips or repeats a local date on a 23- or 25-hour day.
    // Walking local calendar dates cannot. Sunday 8 March is the 23-hour day itself.
    const sunday = suggestedTimeFor('weekend:early', DENVER, new Date('2026-03-08T06:00:00Z'));

    expect(sunday.local).toBe('2026-03-08T07:00');
    // 07:00 MDT, after the 02:00 jump — so the conversion resolved the post-transition
    // offset for a time on the transition day itself.
    expect(sunday.instant.toISOString()).toBe('2026-03-08T13:00:00.000Z');
  });

  it('starts the search from the local date, not the UTC one', () => {
    // Just after UTC midnight it is still Saturday evening in Denver. A search that starts
    // from the UTC date skips the rest of the local day and offers a slot a full day late.
    //
    // This is easy to leave unprotected: the `instant >= from` guard already rejects any
    // candidate in the past, so a wrong start date is invisible *except* in exactly this
    // window — where the UTC date has rolled over but a slot later today local has not yet
    // happened. A mutation that swapped the local start date for the UTC one survived the
    // rest of this file.
    const tonight = suggestedTimeFor('weekend:evening', DENVER, new Date('2026-03-08T00:00:00Z'));

    expect(tonight.local).toBe('2026-03-07T20:00');
    expect(tonight.instant.toISOString()).toBe('2026-03-08T03:00:00.000Z');

    // POSITIVE CONTROL, from the same instant: 16:00 local on the 7th *has* already passed,
    // so the afternoon slot must roll forward. Without this, an implementation that simply
    // always reached back a day would pass the assertion above.
    const tomorrow = suggestedTimeFor(
      'weekend:afternoon',
      DENVER,
      new Date('2026-03-08T00:00:00Z'),
    );

    expect(tomorrow.local).toBe('2026-03-08T16:00');
  });

  it('never suggests an hour inside the DST gap or inside quiet hours', () => {
    // 02:00 does not exist on a spring-forward morning. It is also inside quiet hours, and
    // that is the property that actually protects us — so it is asserted directly rather
    // than left as a happy consequence of the daypart table.
    for (const slot of SEND_TIME_SLOTS) {
      const suggestion = suggestedTimeFor(slot, DENVER, beforeSpring);
      const hour = Number(suggestion.local.slice(11, 13));

      expect(daypartForHour(hour)).not.toBeNull();
      expect(hour).toBeGreaterThanOrEqual(5);
      expect(hour).toBeLessThan(23);
    }
  });

  it('returns a time in the future for every slot', () => {
    // POSITIVE CONTROL for the loop above: it would pass on an implementation that
    // returned the same stale day for all eight slots.
    const locals = new Set(
      SEND_TIME_SLOTS.map((slot) => suggestedTimeFor(slot, DENVER, beforeSpring).local),
    );

    expect(locals.size).toBeGreaterThan(1);
    for (const slot of SEND_TIME_SLOTS) {
      const suggestion = suggestedTimeFor(slot, DENVER, beforeSpring);
      expect(suggestion.instant.getTime()).toBeGreaterThanOrEqual(beforeSpring.getTime());
    }
  });
});

describe('bucketing a published instant into a slot', () => {
  it('buckets in the brand’s zone, not UTC', () => {
    // 2026-01-06T02:00Z is Tuesday 19:00 the previous evening in Denver. In UTC it is
    // Tuesday early morning — a different day part and, near a weekend, a different day
    // type. Getting this wrong shifts the entire signal by several hours in exactly the
    // hours that matter most.
    const instant = new Date('2026-01-06T02:00:00Z');

    expect(slotForInstant(instant, DENVER)).toBe('weekday:evening');
    expect(slotForInstant(instant, 'UTC')).toBeNull();
  });

  it('excludes quiet hours rather than folding them into evening', () => {
    // 09:00Z is 02:00 in Denver. Folding it into `evening` would let one well-performing
    // insomniac post teach the scheduler to suggest 2am.
    expect(slotForInstant(new Date('2026-01-06T09:00:00Z'), DENVER)).toBeNull();
  });

  it('assigns weekday and weekend from the same local reading as the hour', () => {
    // Saturday 2026-01-03T05:00Z is Friday 22:00 in Denver: weekday evening, not weekend.
    // Taking the day from one zone and the hour from another is the failure this guards.
    expect(slotForInstant(new Date('2026-01-03T05:00:00Z'), DENVER)).toBe('weekday:evening');
    // POSITIVE CONTROL: a genuine local Saturday does bucket as a weekend.
    expect(slotForInstant(new Date('2026-01-03T22:00:00Z'), DENVER)).toBe('weekend:afternoon');
  });
});

describe('the cold-start click histogram', () => {
  const hours: ClickHour[] = [
    { dayOfWeek: 2, hour: 11, clicks: 40, botClicks: 0 },
    { dayOfWeek: 3, hour: 20, clicks: 10, botClicks: 0 },
  ];

  it('turns audience clicks into slot weights', () => {
    const weights = slotWeightsFromClicks(hours);

    expect(weights['weekday:midday']).toBe(1);
    expect(weights['weekday:evening']).toBeCloseTo(0.25, 10);
    expect(weights['weekend:midday']).toBeUndefined();
  });

  it('drops bot clicks rather than netting them off', () => {
    // Link-preview crawlers hit every short link at publish time, so unfiltered they pile
    // up in whatever hour the brand already publishes and the recommender confidently
    // learns to post exactly when it already posts. Subtracting them would be worse still:
    // it could push the brand's real publish hour below zero and out of contention.
    const withBots: ClickHour[] = [
      { dayOfWeek: 2, hour: 11, clicks: 40, botClicks: 500 },
      { dayOfWeek: 3, hour: 20, clicks: 10, botClicks: 0 },
    ];

    expect(slotWeightsFromClicks(withBots)).toEqual(slotWeightsFromClicks(hours));
  });

  it('gives a brand with no posts a defensible suggestion from its own traffic', () => {
    const scores = scoreSlots({ targets: [], timeZone: DENVER, clickHours: hours });

    expect(scores[0]!.slot).toBe('weekday:midday');
    expect(scores[0]!.priorBasis).toBe('brand-clicks');
    expect(scores[0]!.scored).toBe(0);
    expect(scores[0]!.claimable).toBe(false);
  });

  it('says it has no basis when there is nothing at all', () => {
    // POSITIVE CONTROL: the ordering above is the histogram being read. With no history,
    // no clicks and no seed, every slot must score identically and say `none` — a
    // recommender with no information must not produce a confident-looking ranking.
    const scores = scoreSlots({ targets: [], timeZone: DENVER });

    expect(new Set(scores.map((score) => shrunkValue(score.score))).size).toBe(1);
    for (const score of scores) expect(score.priorBasis).toBe('none');
  });

  it('prefers a category aggregate over the brand’s click histogram', () => {
    // Clicks are audience activity; an aggregate is measured outcome. Outcome wins.
    const scores = scoreSlots({
      targets: [],
      timeZone: DENVER,
      clickHours: hours,
      aggregates: { 'weekend:evening': { mean: 3, observations: 9 } },
    });

    expect(scores[0]!.slot).toBe('weekend:evening');
    expect(scores[0]!.priorBasis).toBe('category');
  });
});

describe('scoring slots against the brand’s own history', () => {
  it('returns all eight slots, including ones never posted in', () => {
    // A scheduler that only considers slots it has already used generates no observations
    // anywhere else, so the first lucky time becomes permanent and self-confirming.
    const targets = makeTargets(6, {
      publishedAt: new Date('2026-01-06T18:00:00Z'),
      linkClicks: 10,
    });

    const scores = scoreSlots({ targets, timeZone: DENVER });
    expect(scores).toHaveLength(SEND_TIME_SLOTS.length);
  });

  it('ranks a slot the brand does well in above one it does badly in', () => {
    const targets = [
      ...makeTargets(6, { publishedAt: new Date('2026-01-06T18:00:00Z'), linkClicks: 40 }),
      ...makeTargets(6, { publishedAt: new Date('2026-01-07T02:00:00Z'), linkClicks: 4 }),
      ...makeTargets(6, { publishedAt: new Date('2026-01-08T18:00:00Z'), linkClicks: 10 }),
    ];

    const scores = scoreSlots({ targets, timeZone: DENVER });
    const midday = scores.find((score) => score.slot === 'weekday:midday')!;
    const evening = scores.find((score) => score.slot === 'weekday:evening')!;

    expect(midday.scored).toBe(12);
    expect(evening.scored).toBe(6);
    expect(shrunkValue(midday.score)).toBeGreaterThan(shrunkValue(evening.score));
    expect(midday.claimable).toBe(true);
  });

  it('does not let an unmeasured post open the claim gate', () => {
    const targets = [
      // Three measurable posts in another slot, because a brand with a single measurable
      // post anywhere has no median and therefore no normalised score at all — which is
      // correct, but it is a different reason for `scored: 0` than the one under test.
      ...makeTargets(3, { publishedAt: new Date('2026-01-08T02:00:00Z'), linkClicks: 10 }),
      makeTarget({ publishedAt: new Date('2026-01-06T18:00:00Z'), linkClicks: 10 }),
      ...makeTargets(8, {
        publishedAt: new Date('2026-01-06T18:00:00Z'),
        linkClicks: null,
        impressions: null,
      }),
    ];

    const midday = scoreSlots({ targets, timeZone: DENVER }).find(
      (score) => score.slot === 'weekday:midday',
    )!;

    expect(midday.posts).toBe(9);
    expect(midday.scored).toBe(1);
    expect(midday.claimable).toBe(false);
  });
});
