import { describe, expect, it } from 'vitest';
import { withExploration, withSendTimeExploration } from './exploration';
import { shrink, type ShrunkScore } from './shrinkage';

interface Candidate {
  name: string;
  score: ShrunkScore;
}

function candidate(name: string, observations: number, observed: number | null): Candidate {
  return {
    name,
    score: shrink({
      observed,
      observations,
      prior: 1,
      priorSource: 'neutral',
      k: 5,
    }),
  };
}

const scoreOf = (item: Candidate) => item.score;
const names = (selection: { item: Candidate }[]) => selection.map((s) => s.item.name);
const kinds = (selection: { kind: string }[]) => selection.map((s) => s.kind);

describe('exploration slots appear in every result set', () => {
  it('reserves a slot for a brand with a rich history', () => {
    // The acceptance criterion, and the case most likely to lose it. A brand with deep
    // history has well-observed candidates at the top, and a fraction rounded down — or an
    // early return for "this brand has enough data" — removes exploration from exactly the
    // brand whose local maximum most needs breaking.
    const ranked = [
      candidate('deep-a', 400, 3),
      candidate('deep-b', 380, 2.8),
      candidate('deep-c', 360, 2.6),
      candidate('untried', 0, null),
    ];

    const selection = withExploration({ ranked, scoreOf, count: 3, fraction: 0.2 });

    expect(kinds(selection)).toContain('explore');
    expect(names(selection)).toContain('untried');
  });

  it('reserves a slot even when the fraction rounds to zero', () => {
    // 2 * 0.2 = 0.4, which rounds to 0. A bare `Math.round` would silently return a
    // pure-exploitation list for every small result set.
    const ranked = [candidate('best', 100, 3), candidate('untried', 0, null)];

    const selection = withExploration({ ranked, scoreOf, count: 2, fraction: 0.2 });

    expect(kinds(selection)).toEqual(['exploit', 'explore']);
    expect(names(selection)).toEqual(['best', 'untried']);
  });

  it('still returns an exploit pick, which is what makes the above mean anything', () => {
    // POSITIVE CONTROL. Every assertion in this file is about exploration being present;
    // an implementation that returned nothing but exploration would satisfy all of them.
    const ranked = [
      candidate('best', 100, 3),
      candidate('second', 90, 2.5),
      candidate('untried', 0, null),
    ];

    const selection = withExploration({ ranked, scoreOf, count: 3, fraction: 0.2 });

    expect(kinds(selection).filter((k) => k === 'exploit')).toHaveLength(2);
    expect(names(selection).slice(0, 2)).toEqual(['best', 'second']);
  });

  it('does not invent an exploration slot when there is nothing to explore', () => {
    // One candidate cannot be both the recommendation and the experiment. Reserving a slot
    // here would return an empty exploit list to satisfy a quota.
    const ranked = [candidate('only', 100, 3)];

    const selection = withExploration({ ranked, scoreOf, count: 3, fraction: 0.2 });

    expect(kinds(selection)).toEqual(['exploit']);
  });

  it('returns nothing for zero slots rather than one exploration pick', () => {
    const ranked = [candidate('a', 100, 3), candidate('b', 0, null)];

    expect(withExploration({ ranked, scoreOf, count: 0, fraction: 0.2 })).toEqual([]);
  });
});

describe('exploration prefers what we know least about', () => {
  it('picks the least-observed candidate, not the next-best one', () => {
    // docs/06: prefer high-uncertainty slots rather than uniformly random ones. `second`
    // is the better score and `untried` is the bigger question.
    const ranked = [
      candidate('best', 200, 3),
      candidate('second', 200, 2.9),
      candidate('thin', 2, 1.2),
      candidate('untried', 0, null),
    ];

    const selection = withExploration({ ranked, scoreOf, count: 2, fraction: 0.5 });

    expect(names(selection)).toEqual(['best', 'untried']);
  });

  it('reports uncertainty as the prior share of the score', () => {
    // k / (n + k), which is where the ordering comes from. Asserted directly so that a
    // change to the ordering rule cannot be mistaken for a change to the definition.
    const ranked = [candidate('observed', 15, 2), candidate('untried', 0, null)];

    const selection = withExploration({ ranked, scoreOf, count: 2, fraction: 0.5 });
    const byName = new Map(selection.map((s) => [s.item.name, s.uncertainty]));

    expect(byName.get('observed')).toBeCloseTo(5 / 20, 6);
    expect(byName.get('untried')).toBe(1);
  });

  it('breaks ties toward the candidate the prior likes', () => {
    // Two things we know nothing about. Without a tiebreak the order falls out of input
    // order — which is the ranking — and exploration quietly becomes exploitation's tail.
    const optimistic = {
      name: 'promising',
      score: shrink({ observed: null, observations: 0, prior: 2, priorSource: 'category-seed' }),
    };
    const pessimistic = {
      name: 'unpromising',
      score: shrink({ observed: null, observations: 0, prior: 0.5, priorSource: 'category-seed' }),
    };

    // Input order puts the unpromising one first, so passing this cannot be input order.
    const selection = withExploration({
      ranked: [candidate('best', 200, 3), pessimistic, optimistic],
      scoreOf,
      count: 2,
      fraction: 0.5,
    });

    expect(names(selection)).toEqual(['best', 'promising']);
  });

  it('never picks the same candidate twice', () => {
    const ranked = [candidate('a', 0, null), candidate('b', 0, null), candidate('c', 0, null)];

    const selection = withExploration({ ranked, scoreOf, count: 3, fraction: 0.34 });

    expect(new Set(names(selection)).size).toBe(selection.length);
    expect(selection).toHaveLength(3);
  });
});

describe('send-time explores harder than templates', () => {
  it('reserves a larger share than the template default', () => {
    // A template a brand never tries is a missed opportunity. A time slot it never tries
    // is a permanent blind spot in a schedule that repeats every week.
    const ranked = Array.from({ length: 8 }, (_, i) =>
      candidate(`slot-${i}`, 100 - i * 10, 2 - i * 0.1),
    );

    const templates = withExploration({ ranked, scoreOf, count: 8, fraction: 0.2 });
    const sendTime = withSendTimeExploration({ ranked, scoreOf, count: 8, fraction: 0.25 });

    const explored = (s: { kind: string }[]) => s.filter((x) => x.kind === 'explore').length;

    expect(explored(templates)).toBe(2);
    expect(explored(sendTime)).toBe(2);

    // POSITIVE CONTROL that the fraction is actually read: a larger one reserves more.
    const aggressive = withSendTimeExploration({ ranked, scoreOf, count: 8, fraction: 0.5 });
    expect(explored(aggressive)).toBe(4);
  });
});
