import { describe, expect, it } from 'vitest';
import {
  CHECKPOINT_HOURS,
  checkpointAt,
  dueCheckpoints,
  hoursSincePublish,
  pollingComplete,
} from './poll.schedule';
import { comparable, outcomeScore } from './outcome';

const PUBLISHED = new Date('2024-01-01T00:00:00Z');
const hoursLater = (hours: number) => new Date(PUBLISHED.getTime() + hours * 3_600_000);

describe('poll schedule', () => {
  it('covers the burst and the long tail out to 30 days', () => {
    expect([...CHECKPOINT_HOURS]).toEqual([1, 24, 168, 336, 504, 720]);
  });

  it('owes nothing before the first checkpoint arrives', () => {
    // 59 minutes in. A schedule that returned the 1h checkpoint early would snapshot a
    // post mid-burst and label it "1 hour", making it incomparable with every other
    // 1-hour reading while looking perfectly well-formed.
    expect(dueCheckpoints(PUBLISHED, hoursLater(0.98), [])).toEqual([]);
  });

  it('owes exactly the checkpoints that have arrived', () => {
    const due = dueCheckpoints(PUBLISHED, hoursLater(25), []);
    expect(due.map((c) => c.hour)).toEqual([1, 24]);
    expect(due.map((c) => c.capturedAt)).toEqual([hoursLater(1), hoursLater(24)]);
  });

  it('stamps a checkpoint with the checkpoint time, not the time it ran', () => {
    // This is the whole idempotency mechanism: a redelivered job computes the same
    // capturedAt and collides with the row it already wrote. Stamping now() instead
    // would write a second snapshot a few seconds later, and nothing downstream could
    // tell that pair apart from a platform genuinely restating a number.
    const due = dueCheckpoints(PUBLISHED, hoursLater(9.7), []);
    expect(due[0]!.capturedAt).toEqual(hoursLater(1));
    expect(due[0]!.capturedAt).not.toEqual(hoursLater(9.7));
  });

  it('backfills a checkpoint missed while the worker was down', () => {
    // Down for two days, so 1h and 24h both passed unseen. Returning only the most
    // recent would drop the 24h reading permanently, leaving a gap indistinguishable
    // from "this post earned nothing overnight".
    const due = dueCheckpoints(PUBLISHED, hoursLater(48), []);
    expect(due.map((c) => c.hour)).toEqual([1, 24]);
  });

  it('fills a hole in the middle rather than assuming the first N were done', () => {
    // 1h and 168h captured, 24h missing — the shape a partial outage leaves behind.
    const captured = [hoursLater(1), hoursLater(168)];
    const due = dueCheckpoints(PUBLISHED, hoursLater(200), captured);
    expect(due.map((c) => c.hour)).toEqual([24]);
  });

  it('does not re-owe a checkpoint already captured', () => {
    const captured = CHECKPOINT_HOURS.map((hour) => hoursLater(hour));
    expect(dueCheckpoints(PUBLISHED, hoursLater(1000), captured)).toEqual([]);
  });

  it('knows when a post is finished being measured', () => {
    const all = CHECKPOINT_HOURS.map((hour) => hoursLater(hour));

    expect(pollingComplete(PUBLISHED, hoursLater(1000), all)).toBe(true);
    // Past the window but with a hole: not complete, because the hole is still fillable.
    expect(pollingComplete(PUBLISHED, hoursLater(1000), all.slice(1))).toBe(false);
    // Inside the window: not complete however much has been captured.
    expect(pollingComplete(PUBLISHED, hoursLater(500), all)).toBe(false);
  });

  it('records hours since publish so snapshots compare like-for-like', () => {
    expect(hoursSincePublish(PUBLISHED, checkpointAt(PUBLISHED, 24))).toBe(24);
    expect(hoursSincePublish(PUBLISHED, hoursLater(0.5))).toBe(0.5);
  });
});

describe('outcome score', () => {
  it('weights a click above a like within a blend', () => {
    // Same total activity, distributed differently. The click-heavy post must score
    // higher — this is the product claim, and if the weights were ever flattened this
    // is the assertion that notices.
    const clickHeavy = outcomeScore({ linkClicks: 10, saves: 0, shares: 0, likes: 0 });
    const likeHeavy = outcomeScore({ linkClicks: 0, saves: 0, shares: 0, likes: 10 });

    expect(clickHeavy.score).toBeGreaterThan(likeHeavy.score!);
    // Both measured on all four components, so they are genuinely comparable and the
    // difference above is the weighting rather than a coverage artefact.
    expect(comparable(clickHeavy, likeHeavy)).toBe(true);
  });

  /**
   * A consequence of coverage normalisation worth stating out loud, because it surprised
   * the author of this file.
   *
   * Dividing by the coverage achieved means a score with one component is just that
   * component's raw value — the weight cancels. So `1 click` and `1 like` both score 1
   * when each is all their platform reported. That is not the weights failing; it is the
   * reason `comparable()` exists, and those two scores are explicitly not rankable
   * against each other.
   *
   * The alternative — not normalising — makes every weight bite but systematically
   * ranks platforms that report fewer metrics below ones that report more, which is a
   * worse failure because it looks like a content signal.
   */
  it('cancels the weight when only one component is available', () => {
    const click = outcomeScore({ linkClicks: 1 });
    const like = outcomeScore({ likes: 1 });

    expect(click.score).toBe(1);
    expect(like.score).toBe(1);

    // Equal numbers, different quantities — and the API says so rather than letting a
    // caller sort them against each other.
    expect(comparable(click, like)).toBe(false);
  });

  it('blends the components it has by their weights', () => {
    const score = outcomeScore({ linkClicks: 10, saves: 10, shares: 10, likes: 5, comments: 5 });

    // Every component present and every value equal to 10 (likes + comments = 10), so
    // the weighted average is 10 whatever the weights are — which makes this a test of
    // the averaging, independent of the tuning.
    expect(score.score).toBeCloseTo(10, 10);
    expect(score.coverage).toBeCloseTo(1, 9);
    expect(score.components).toEqual(['click', 'save', 'share', 'engage']);
  });

  it('returns null rather than zero when nothing was measurable', () => {
    const score = outcomeScore({ linkClicks: null, saves: null, shares: null, likes: null });

    expect(score.score).toBeNull();
    // Specifically not 0. A zero would rank an unmeasurable post below a post that was
    // measured and genuinely earned nothing, which is a claim we cannot support.
    expect(score.score).not.toBe(0);
    expect(score.components).toEqual([]);
  });

  it('counts a real zero, because earning nothing is information', () => {
    const score = outcomeScore({ linkClicks: 0 });

    expect(score.score).toBe(0);
    // And it is a *measured* zero, which is what separates it from the case above.
    expect(score.components).toEqual(['click']);
  });

  it('does not penalise a post for what its platform cannot report', () => {
    // Same 10 clicks. One platform reports only clicks, the other reports everything and
    // happens to have earned 10 of each. Dropping the missing components from the
    // denominator as well as the numerator is what keeps these equal — a `?? 0` would
    // score the first at a quarter of the second purely for being measured less.
    const sparse = outcomeScore({ linkClicks: 10 });
    const full = outcomeScore({ linkClicks: 10, saves: 10, shares: 10, likes: 10 });

    expect(sparse.score).toBeCloseTo(10, 10);
    expect(full.score).toBeCloseTo(10, 10);
  });

  it('reports partial coverage so a caller can judge the score\u2019s weight', () => {
    const sparse = outcomeScore({ linkClicks: 10 });

    expect(sparse.coverage).toBeGreaterThan(0);
    expect(sparse.coverage).toBeLessThan(1);
    expect(sparse.components).toEqual(['click']);
  });

  it('treats engagement as measured when either half is present', () => {
    const likesOnly = outcomeScore({ likes: 4 });
    expect(likesOnly.components).toEqual(['engage']);
    expect(likesOnly.score).toBeCloseTo(4, 10);

    const both = outcomeScore({ likes: 4, comments: 6 });
    expect(both.components).toEqual(['engage']);
    expect(both.score).toBeCloseTo(10, 10);
  });

  it('refuses to compare scores built from different components', () => {
    const clicks = outcomeScore({ linkClicks: 10 });
    const likes = outcomeScore({ likes: 10 });
    const alsoClicks = outcomeScore({ linkClicks: 3 });

    // Same number, different quantity. Ranking these against each other sorts the
    // leaderboard by which platform exposes the most fields.
    expect(comparable(clicks, likes)).toBe(false);
    expect(comparable(clicks, alsoClicks)).toBe(true);

    // A null score is comparable with nothing, including another null.
    const nothing = outcomeScore({});
    expect(comparable(nothing, nothing)).toBe(false);
  });
});

describe('weighted sum', () => {
  it('exposes the un-normalised total so W8 can make the other trade', () => {
    // Under the normalised score these are equal, because each cancels its own weight.
    const click = outcomeScore({ linkClicks: 1 });
    const like = outcomeScore({ likes: 1 });
    expect(click.score).toBe(like.score);

    // Under the raw weighted sum the click wins, which is the interpretation a caller
    // that wants unblended ranking needs and would otherwise have to reconstruct.
    expect(click.weightedSum).toBeGreaterThan(like.weightedSum!);
  });

  it('is null exactly when the score is', () => {
    const nothing = outcomeScore({});
    expect(nothing.score).toBeNull();
    expect(nothing.weightedSum).toBeNull();

    // And not null for a measured zero — the distinction has to hold on both fields or
    // a caller switching between them would get different answers about availability.
    const zero = outcomeScore({ linkClicks: 0 });
    expect(zero.weightedSum).toBe(0);
  });
});
