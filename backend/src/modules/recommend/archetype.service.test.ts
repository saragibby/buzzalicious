import { describe, expect, it } from 'vitest';
import { makeTarget, makeTargets } from '../../../tests/fixtures/target-outcome';
import { scoreArchetypes } from './archetype.service';
import { shrunkValue } from './shrinkage';

const CANDIDATES = ['OUTLIER', 'STEADY', 'FILLER', 'NEVER_TRIED'];

function byName(scores: ReturnType<typeof scoreArchetypes>, archetype: string) {
  const found = scores.find((score) => score.archetype === archetype);
  if (!found) throw new Error(`no score for ${archetype}`);
  return found;
}

/**
 * The acceptance criterion the whole shrinkage design exists for.
 *
 * Twelve filler posts at 10 clicks per 1000 impressions fix the brand's median click rate
 * at 0.01, so a normalised value of 1.0 means "typical for this brand".
 *
 *   OUTLIER  1 post,  288 clicks / 10,000 impressions → 0.0288 → 2.88× typical
 *   STEADY   8 posts,  20 clicks /  1,000 impressions → 0.0200 → 2.00× typical
 *
 * Blended over four components with three imputed at 1.0:
 *
 *   OUTLIER  0.45·2.88 + 0.55 = 1.846
 *   STEADY   0.45·2.00 + 0.55 = 1.450
 *
 * On the raw means the outlier wins, and it wins on one post. Shrunk at k = 5 against a
 * neutral prior:
 *
 *   OUTLIER  (1·1.846 + 5·1) /  6 = 1.141
 *   STEADY   (8·1.450 + 5·1) / 13 = 1.277   ← wins
 *
 * The flip is the assertion. Note that it is a flip and not a rout: shrinkage does not
 * discard the outlier, it declines to bet eight posts' worth of confidence on one.
 */
describe('one outlier at low n cannot dominate', () => {
  function brand() {
    return [
      ...makeTargets(12, { archetype: 'FILLER', linkClicks: 10, impressions: 1000 }),
      makeTarget({ archetype: 'OUTLIER', linkClicks: 288, impressions: 10_000 }),
      ...makeTargets(8, { archetype: 'STEADY', linkClicks: 20, impressions: 1000 }),
    ];
  }

  it('ranks the steady archetype above the one-post outlier', () => {
    const scores = scoreArchetypes({ targets: brand(), candidates: CANDIDATES });

    const outlier = byName(scores, 'OUTLIER');
    const steady = byName(scores, 'STEADY');

    expect(shrunkValue(outlier.score)).toBeCloseTo(1.141, 3);
    expect(shrunkValue(steady.score)).toBeCloseTo(1.277, 3);
    expect(shrunkValue(steady.score)).toBeGreaterThan(shrunkValue(outlier.score));
  });

  it('would have ranked the outlier first on a plain average', () => {
    // POSITIVE CONTROL, and the one that makes the test above mean anything. Without it a
    // fixture where the outlier simply performed worse would pass identically, and the
    // test would be asserting nothing about shrinkage at all.
    const scores = scoreArchetypes({ targets: brand(), candidates: CANDIDATES });

    const outlierRaw = byName(scores, 'OUTLIER').score.basis.observed;
    const steadyRaw = byName(scores, 'STEADY').score.basis.observed;

    expect(outlierRaw).toBeCloseTo(1.846, 3);
    expect(steadyRaw).toBeCloseTo(1.45, 3);
    expect(outlierRaw!).toBeGreaterThan(steadyRaw!);
  });

  it('keeps the raw mean raw', () => {
    // `observed` must never quietly become the shrunk value — the interior hazard this
    // workstream is built around.
    const outlier = byName(
      scoreArchetypes({ targets: brand(), candidates: CANDIDATES }),
      'OUTLIER',
    );

    expect(outlier.score.basis.observed).not.toBeCloseTo(shrunkValue(outlier.score), 3);
    expect(outlier.score.basis.observations).toBe(1);
    expect(outlier.score.basis.brandWeight).toBeCloseTo(1 / 6, 10);
  });
});

/**
 * The contamination trap. Two signals live in the same rows and only one of them may read
 * an exploration post as evidence of what the brand wants.
 */
describe('exploration posts are outcome evidence but not preference evidence', () => {
  const targets = [
    ...makeTargets(12, { archetype: 'FILLER', linkClicks: 10 }),
    ...makeTargets(4, {
      archetype: 'OUTLIER',
      linkClicks: 20,
      scheduleSource: 'EXPLORATION',
      postId: 'explored',
    }),
    ...makeTargets(2, { archetype: 'STEADY', linkClicks: 20, scheduleSource: 'SUGGESTED' }),
  ];

  it('does not count an exploration post as the user choosing that archetype', () => {
    const scores = scoreArchetypes({ targets, candidates: CANDIDATES });

    expect(byName(scores, 'OUTLIER').userChoices).toBe(0);
    // Accepting a default is not choosing one. A suggestion accepted eight times is still
    // our opinion coming back to us.
    expect(byName(scores, 'STEADY').userChoices).toBe(0);
  });

  it('does count a genuine user choice', () => {
    // POSITIVE CONTROL. Without it the assertions above pass on an implementation that
    // excludes everything, which is the exact defect this repo has hit fourteen times.
    const scores = scoreArchetypes({ targets, candidates: CANDIDATES });

    expect(byName(scores, 'FILLER').userChoices).toBe(12);
  });

  it('still measures the exploration post’s outcome', () => {
    // The other half, and the one that is easy to get backwards: excluding exploration
    // from scoring would make exploring a pure cost. We pay for the slot, take the risk,
    // and throw away the only thing we bought.
    const scores = scoreArchetypes({ targets, candidates: CANDIDATES });

    expect(byName(scores, 'OUTLIER').scored).toBe(4);
    expect(byName(scores, 'OUTLIER').score.basis.observed).not.toBeNull();
  });

  it('counts a choice once per post, not once per platform', () => {
    // Publishing one post to four platforms is one decision. Counting targets would make
    // a cross-posting habit look like four times the enthusiasm.
    const crossPosted = [
      makeTarget({ archetype: 'STEADY', postId: 'p1', platform: 'X' }),
      makeTarget({ archetype: 'STEADY', postId: 'p1', platform: 'FACEBOOK' }),
      makeTarget({ archetype: 'STEADY', postId: 'p1', platform: 'INSTAGRAM' }),
      makeTarget({ archetype: 'STEADY', postId: 'p1', platform: 'THREADS' }),
    ];

    const scores = scoreArchetypes({ targets: crossPosted, candidates: CANDIDATES });
    expect(byName(scores, 'STEADY').userChoices).toBe(1);
    // POSITIVE CONTROL: the four rows are genuinely there, so the 1 above is deduplication
    // rather than three rows having been dropped on the way in.
    expect(byName(scores, 'STEADY').posts).toBe(4);
  });
});

describe('an archetype the brand has never used', () => {
  const targets = makeTargets(12, { archetype: 'FILLER', linkClicks: 10 });

  it('still appears in the result set', () => {
    // Deriving candidates from history would make an untried archetype unrecommendable —
    // the brand would only ever be offered what it had already done.
    const scores = scoreArchetypes({ targets, candidates: CANDIDATES });

    expect(scores.map((score) => score.archetype).sort()).toEqual([...CANDIDATES].sort());
  });

  it('is scored at its prior and says so', () => {
    const untried = byName(scoreArchetypes({ targets, candidates: CANDIDATES }), 'NEVER_TRIED');

    expect(untried.scored).toBe(0);
    expect(untried.posts).toBe(0);
    expect(untried.score.basis.observed).toBeNull();
    expect(untried.score.basis.brandWeight).toBe(0);
    expect(shrunkValue(untried.score)).toBe(untried.score.basis.prior);
  });

  it('takes its ordering from the seed at cold start', () => {
    const seed = { NEVER_TRIED: 0.9, OUTLIER: 0.3, STEADY: 0.3, FILLER: 0.3 };
    const scores = scoreArchetypes({ targets: [], candidates: CANDIDATES, seed });

    expect(scores[0]!.archetype).toBe('NEVER_TRIED');
    expect(scores[0]!.score.basis.priorSource).toBe('category-seed');

    // POSITIVE CONTROL: without a seed the same brand has no basis for an ordering, so the
    // first result above is the seed being read rather than an incidental array order.
    const unseeded = scoreArchetypes({ targets: [], candidates: CANDIDATES });
    const values = unseeded.map((score) => shrunkValue(score.score));
    expect(new Set(values).size).toBe(1);
    expect(unseeded[0]!.score.basis.priorSource).toBe('neutral');
  });
});

describe('the claim gate', () => {
  it('refuses a brand-specific claim below the sample threshold', () => {
    const targets = [
      ...makeTargets(12, { archetype: 'FILLER', linkClicks: 10 }),
      ...makeTargets(4, { archetype: 'STEADY', linkClicks: 20 }),
    ];

    expect(byName(scoreArchetypes({ targets, candidates: CANDIDATES }), 'STEADY').claimable).toBe(
      false,
    );
  });

  it('allows one at the threshold', () => {
    // POSITIVE CONTROL: one more post, same shape. A gate that is always closed passes
    // every "it stayed closed" assertion.
    const targets = [
      ...makeTargets(12, { archetype: 'FILLER', linkClicks: 10 }),
      ...makeTargets(5, { archetype: 'STEADY', linkClicks: 20 }),
    ];

    expect(byName(scoreArchetypes({ targets, candidates: CANDIDATES }), 'STEADY').claimable).toBe(
      true,
    );
  });

  it('counts scored posts, not published ones', () => {
    // Five posts of which four were never measured is not five observations. Counting
    // publications would open the claim gate on a single measurable post.
    const targets = [
      ...makeTargets(12, { archetype: 'FILLER', linkClicks: 10 }),
      makeTarget({ archetype: 'STEADY', linkClicks: 20 }),
      ...makeTargets(4, { archetype: 'STEADY', linkClicks: null, impressions: null }),
    ];

    const steady = byName(scoreArchetypes({ targets, candidates: CANDIDATES }), 'STEADY');
    expect(steady.posts).toBe(5);
    expect(steady.scored).toBe(1);
    expect(steady.claimable).toBe(false);

    // And the four unmeasured posts must buy no weight against the prior either. This is
    // the assertion that distinguishes "we published five times" from "we learned five
    // times" — n is 1, so brandWeight is 1/(1+5), not 5/(5+5). Without it the difference
    // is invisible: the score stays a perfectly ordinary number, just a more confident
    // one than the evidence supports.
    expect(steady.score.basis.observations).toBe(1);
    expect(steady.score.basis.brandWeight).toBeCloseTo(1 / 6, 10);
  });

  it('does give full weight when every post was measured', () => {
    // POSITIVE CONTROL: same five posts, all measurable. If observations were hard-wired
    // low, the assertion above would pass for the wrong reason.
    const targets = [
      ...makeTargets(12, { archetype: 'FILLER', linkClicks: 10 }),
      ...makeTargets(5, { archetype: 'STEADY', linkClicks: 20 }),
    ];

    const steady = byName(scoreArchetypes({ targets, candidates: CANDIDATES }), 'STEADY');
    expect(steady.score.basis.observations).toBe(5);
    expect(steady.score.basis.brandWeight).toBeCloseTo(0.5, 10);
  });
});

describe('normalisation is done once across the brand', () => {
  it('does not define “typical” separately inside each archetype', () => {
    // Per-archetype medians would make every archetype score about 1.0 by construction,
    // because each group would be measured against itself. The ranking would be noise
    // wearing a ranking's clothes, and every number in it would look reasonable.
    const targets = [
      ...makeTargets(12, { archetype: 'FILLER', linkClicks: 10 }),
      ...makeTargets(6, { archetype: 'STEADY', linkClicks: 40 }),
    ];

    const steady = byName(scoreArchetypes({ targets, candidates: CANDIDATES }), 'STEADY');
    const filler = byName(scoreArchetypes({ targets, candidates: CANDIDATES }), 'FILLER');

    // 40/1000 against a brand median of 10/1000 is 4× typical, not 1×.
    expect(steady.score.basis.observed).toBeCloseTo(0.45 * 4 + 0.55, 10);
    expect(filler.score.basis.observed).toBeCloseTo(1, 10);
    expect(shrunkValue(steady.score)).toBeGreaterThan(shrunkValue(filler.score));
  });
});
