import type { Platform } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { COMPONENTS, outcomeScore, type OutcomeComponent } from '../insight/outcome';
import type { TargetOutcome } from '../insight/insight.service';
import { buildNormalizer, normalizedOutcome } from './normalize';

/**
 * Fixtures are built at round numbers so the expected scores can be derived by hand and
 * checked against the arithmetic in `normalize.ts`'s header. Every `impressions` is 1000,
 * so a count of 10 is a rate of 0.01 and a median is easy to read off.
 */
interface Metrics {
  linkClicks?: number | null;
  saves?: number | null;
  shares?: number | null;
  likes?: number | null;
  comments?: number | null;
  impressions?: number | null;
}

let seq = 0;

function target(platform: Platform, metrics: Metrics): TargetOutcome {
  seq += 1;
  const filled = {
    linkClicks: metrics.linkClicks ?? null,
    saves: metrics.saves ?? null,
    shares: metrics.shares ?? null,
    likes: metrics.likes ?? null,
    comments: metrics.comments ?? null,
  };

  return {
    postTargetId: `target-${seq}`,
    postId: `post-${seq}`,
    postTitle: null,
    platform,
    publishedAt: new Date('2026-01-01T12:00:00Z'),
    templateId: 'template-1',
    templateName: 'Template',
    trendId: null,
    ...filled,
    impressions: metrics.impressions === undefined ? 1000 : metrics.impressions,
    reach: null,
    videoViews: null,
    capturedAt: new Date('2026-01-02T12:00:00Z'),
    outcome: outcomeScore(filled),
  };
}

/** Three baseline posts so the median has the configured minimum sample behind it. */
function baseline(platform: Platform, metrics: Metrics, count = 3): TargetOutcome[] {
  return Array.from({ length: count }, () => target(platform, metrics));
}

const CLICKS_ONLY: Metrics = { linkClicks: 10, saves: null, shares: null, comments: null };
const ALL_FOUR: Metrics = { linkClicks: 10, saves: 5, shares: 4, likes: 2, comments: 1 };

function scoreOf(subject: TargetOutcome, population: TargetOutcome[]): number | null {
  return normalizedOutcome(subject, buildNormalizer(population)).score;
}

/**
 * The endpoint guard, and the first thing to check before believing anything else here.
 *
 * Imputing every component would hand a confident "perfectly typical" to a post we know
 * nothing about — W7's `a zero is a lie` arriving through the coverage door rather than
 * the shrinkage one.
 */
describe('nothing measured is null, never 1.0', () => {
  it('scores a target with no metrics at all as null', () => {
    const rest = baseline('X', CLICKS_ONLY);
    const blank = target('X', {
      linkClicks: null,
      saves: null,
      shares: null,
      likes: null,
      comments: null,
      impressions: 1000,
    });

    const result = normalizedOutcome(blank, buildNormalizer([...rest, blank]));

    expect(result.score).toBeNull();
    expect(result.score).not.toBe(1);
    expect(result.measured).toEqual([]);
  });

  it('still scores a target on the same platform that did measure something', () => {
    // POSITIVE CONTROL. Without it the assertion above passes on a fixture where the
    // normaliser produced nothing for anyone, which proves nothing about the blank row.
    const rest = baseline('X', CLICKS_ONLY);
    const measured = target('X', CLICKS_ONLY);

    const result = normalizedOutcome(measured, buildNormalizer([...rest, measured]));

    expect(result.score).not.toBeNull();
    expect(result.measured).toEqual(['click']);
  });
});

/**
 * The defect that made coverage normalisation the wrong blend, and the reason this file
 * sums over all four components instead of dividing by achieved coverage.
 *
 * Under `Σ(w·x)/Σ(w)` both of these come out at exactly 2.00, because the weight cancels
 * whenever a single component is present. Under imputation they separate, in the order
 * the product thesis demands.
 */
describe('the weights survive a single-component post', () => {
  it('scores a doubled click above a doubled like', () => {
    const clickPop = [
      ...baseline('X', CLICKS_ONLY),
      target('X', { ...CLICKS_ONLY, linkClicks: 20 }),
    ];
    const doubledClicks = clickPop[clickPop.length - 1]!;

    // Threads here carries no tracked link, so `engage` is the only measurable component.
    const likesOnly: Metrics = { linkClicks: null, saves: null, shares: null, likes: 10 };
    const likePop = [
      ...baseline('THREADS', likesOnly),
      target('THREADS', { ...likesOnly, likes: 20 }),
    ];
    const doubledLikes = likePop[likePop.length - 1]!;

    // 0.45·2.0 + 0.25·1 + 0.20·1 + 0.10·1 = 1.45
    expect(scoreOf(doubledClicks, clickPop)).toBeCloseTo(1.45, 10);
    // 0.45·1 + 0.25·1 + 0.20·1 + 0.10·2.0 = 1.10
    expect(scoreOf(doubledLikes, likePop)).toBeCloseTo(1.1, 10);

    expect(scoreOf(doubledClicks, clickPop)!).toBeGreaterThan(scoreOf(doubledLikes, likePop)!);
  });

  it('scores an exactly typical post at 1.0 on both platforms', () => {
    // POSITIVE CONTROL for the pair above: the two platforms agree at the neutral point,
    // so the difference at 2× is the weights doing their job and not a fixture artefact.
    const clickPop = baseline('X', CLICKS_ONLY, 4);
    const likePop = baseline(
      'THREADS',
      { linkClicks: null, saves: null, shares: null, likes: 10 },
      4,
    );

    expect(scoreOf(clickPop[0]!, clickPop)).toBeCloseTo(1.0, 10);
    expect(scoreOf(likePop[0]!, likePop)).toBeCloseTo(1.0, 10);
  });
});

/**
 * The second defect: under coverage normalisation a four-component post scored 1.45 where
 * an otherwise identical clicks-only post scored 2.00 — penalised for telling us more.
 */
describe('reporting more metrics is not a penalty', () => {
  it('scores equal click performance equally regardless of coverage', () => {
    const thin = [...baseline('X', CLICKS_ONLY), target('X', { ...CLICKS_ONLY, linkClicks: 20 })];
    const thinSubject = thin[thin.length - 1]!;

    const rich = [
      ...baseline('FACEBOOK', ALL_FOUR),
      target('FACEBOOK', { ...ALL_FOUR, linkClicks: 20 }),
    ];
    const richSubject = rich[rich.length - 1]!;

    const thinScore = scoreOf(thinSubject, thin)!;
    const richScore = scoreOf(richSubject, rich)!;

    expect(thinScore).toBeCloseTo(1.45, 10);
    expect(richScore).toBeCloseTo(1.45, 10);
    expect(richScore).toBeCloseTo(thinScore, 10);

    // POSITIVE CONTROL: they genuinely differ in coverage, so the equality above is a
    // property of the blend rather than of two identically-shaped fixtures.
    expect(normalizedOutcome(thinSubject, buildNormalizer(thin)).imputed).toHaveLength(3);
    expect(normalizedOutcome(richSubject, buildNormalizer(rich)).imputed).toHaveLength(0);
  });
});

/**
 * A known, deliberately unsolved artefact — pinned so that changing it is a decision.
 *
 * Imputation pins the *expectation* at 1.0, which is what removes the coverage bias
 * above. It does not equalise the *range*: only 0.45 of the weight can vary on a
 * clicks-only platform, while all 1.00 can vary where four components are reported. So
 * identical relative performance produces scores that travel different distances from
 * 1.0, and because ranking takes the top, ranked lists over-represent high-coverage
 * platforms.
 *
 * If a future change equalises these, this test is what tells that author what they
 * changed and that it was known.
 */
describe('coverage biases variance, not the mean — known and unfixed', () => {
  function atMultiple(multiple: number): { thin: number; rich: number } {
    const thin = [
      ...baseline('X', CLICKS_ONLY),
      target('X', { ...CLICKS_ONLY, linkClicks: 10 * multiple }),
    ];
    const rich = [
      ...baseline('FACEBOOK', ALL_FOUR),
      target('FACEBOOK', {
        linkClicks: 10 * multiple,
        saves: 5 * multiple,
        shares: 4 * multiple,
        likes: 2 * multiple,
        comments: 1 * multiple,
      }),
    ];

    return {
      thin: scoreOf(thin[thin.length - 1]!, thin)!,
      rich: scoreOf(rich[rich.length - 1]!, rich)!,
    };
  }

  it('agrees exactly at the neutral point', () => {
    // POSITIVE CONTROL: the divergence below is about range, not about the two platforms
    // being on different scales to begin with.
    const neutral = atMultiple(1);
    expect(neutral.thin).toBeCloseTo(1.0, 10);
    expect(neutral.rich).toBeCloseTo(1.0, 10);
  });

  it('lets the high-coverage platform travel further in both directions', () => {
    const doubled = atMultiple(2);
    expect(doubled.thin).toBeCloseTo(1.45, 10);
    expect(doubled.rich).toBeCloseTo(2.0, 10);
    expect(doubled.rich).toBeGreaterThan(doubled.thin);

    const tripled = atMultiple(3);
    expect(tripled.thin).toBeCloseTo(1.9, 10);
    expect(tripled.rich).toBeCloseTo(3.0, 10);

    // And symmetrically below, which is the half nobody looks at and the reason the
    // artefact reads as a finding rather than as noise.
    const halved = atMultiple(0.5);
    expect(halved.thin).toBeCloseTo(0.775, 10);
    expect(halved.rich).toBeCloseTo(0.5, 10);
    expect(halved.rich).toBeLessThan(halved.thin);
  });
});

/**
 * The denominator is chosen once per `(platform, component)` and declared, because a
 * per-post choice computes a median over a mixture of rates and raw counts — a silent
 * unit error that produces an entirely plausible number.
 */
describe('denominator selection', () => {
  it('divides by impressions and says so', () => {
    const population = baseline('X', CLICKS_ONLY, 4);
    const basis = buildNormalizer(population).basisFor('X', 'click');

    expect(basis.denominator).toBe('impressions');
    expect(basis.source).toBe('brand-platform');
    expect(basis.median).toBeCloseTo(0.01, 10);
    expect(basis.sampleSize).toBe(4);
  });

  it('normalises by rate rather than by raw count when impressions differ', () => {
    // POSITIVE CONTROL for the basis above: if the denominator were ignored, these two
    // posts would score differently, since one has five times the clicks.
    const population = [
      target('X', { ...CLICKS_ONLY, linkClicks: 10, impressions: 1000 }),
      target('X', { ...CLICKS_ONLY, linkClicks: 20, impressions: 2000 }),
      target('X', { ...CLICKS_ONLY, linkClicks: 30, impressions: 3000 }),
      target('X', { ...CLICKS_ONLY, linkClicks: 50, impressions: 5000 }),
    ];

    const scores = population.map((subject) => scoreOf(subject, population));
    for (const score of scores) expect(score).toBeCloseTo(1.0, 10);
  });

  it('falls back to raw counts when impressions are absent, without mixing the two', () => {
    // A failed metrics poll leaves impressions null on rows whose counts landed. Only one
    // row here has impressions, which is below the minimum sample, so the whole group must
    // fall to raw counts rather than computing a median over one rate and three counts.
    const population = [
      target('X', { ...CLICKS_ONLY, linkClicks: 10, impressions: null }),
      target('X', { ...CLICKS_ONLY, linkClicks: 10, impressions: null }),
      target('X', { ...CLICKS_ONLY, linkClicks: 10, impressions: null }),
      target('X', { ...CLICKS_ONLY, linkClicks: 20, impressions: 1000 }),
    ];

    const basis = buildNormalizer(population).basisFor('X', 'click');
    expect(basis.denominator).toBe('raw-count');
    expect(basis.median).toBe(10);
    expect(basis.sampleSize).toBe(4);

    // The 20-click row is 2× the median count — scored under the same denominator the
    // median was taken under, not as a rate against a count median.
    expect(scoreOf(population[3]!, population)).toBeCloseTo(1.45, 10);
  });
});

/**
 * The thin-brand fallback the brief requires be *visible* rather than quietly filled in.
 */
describe('a brand too thin to have a median', () => {
  it('declares itself unnormalized instead of substituting someone else’s data', () => {
    const population = baseline('X', CLICKS_ONLY, 2);
    const basis = buildNormalizer(population).basisFor('X', 'click');

    expect(basis.source).toBe('unnormalized');
    expect(basis.median).toBeNull();
    expect(basis.sampleSize).toBe(2);

    // Un-normalisable is treated as unmeasured, not as its raw value: passing 10 clicks
    // through undivided would report the post as "10× typical".
    expect(scoreOf(population[0]!, population)).toBeNull();
  });

  it('uses the brand’s other platforms before giving up', () => {
    // POSITIVE CONTROL: the stack has a middle rung, and it is reached. One X post alone
    // cannot have a median, but the brand has four posts overall.
    const population = [...baseline('FACEBOOK', CLICKS_ONLY, 3), target('X', CLICKS_ONLY)];
    const basis = buildNormalizer(population).basisFor('X', 'click');

    expect(basis.source).toBe('brand-all-platforms');
    expect(basis.median).toBeCloseTo(0.01, 10);
  });

  it('refuses a median of zero rather than dividing by it', () => {
    // Most posts earning nothing on a component is information, but it is not a scale.
    // Dividing by it yields Infinity, which does not throw — it sorts to the top of every
    // ranking, silently and permanently.
    const population = [
      ...baseline('X', { ...CLICKS_ONLY, linkClicks: 0 }),
      target('X', { ...CLICKS_ONLY, linkClicks: 40 }),
    ];

    const basis = buildNormalizer(population).basisFor('X', 'click');
    expect(basis.source).toBe('unnormalized');

    const score = scoreOf(population[population.length - 1]!, population);
    expect(score).toBeNull();
    expect(Number.isFinite(score ?? 0)).toBe(true);
  });
});

describe('measured and imputed travel with the score', () => {
  it('names which components were assumed typical', () => {
    const population = baseline('X', CLICKS_ONLY, 4);
    const result = normalizedOutcome(population[0]!, buildNormalizer(population));

    expect(result.measured).toEqual(['click']);
    expect(result.imputed).toEqual(['save', 'share', 'engage']);
    expect(result.values.click).toBeCloseTo(1.0, 10);
    // The imputed ones carry no value, so an explanation cannot accidentally quote one.
    expect(result.values.save).toBeUndefined();
  });
});

/**
 * `COMPONENTS` is weight order, and exporting it put that invariant outside the file that
 * depends on it. `const` stops reassignment, not mutation — `readonly` is what stops a
 * consumer reordering weight semantics process-wide.
 */
describe('COMPONENTS cannot be reordered by a consumer', () => {
  it('will not widen back to a mutable array', () => {
    // @ts-expect-error - readonly is not assignable to mutable, which is what makes
    // COMPONENTS.sort() and COMPONENTS.push() compile errors at every call site.
    const mutable: OutcomeComponent[] = COMPONENTS;
    expect(mutable).toHaveLength(4);
  });

  it('is still readable and still in weight order', () => {
    // POSITIVE CONTROL: a copy is assignable and the contents are intact, so the error
    // above is about the readonly marker rather than a broken import or element type.
    const copy: OutcomeComponent[] = [...COMPONENTS];
    expect(copy).toEqual(['click', 'save', 'share', 'engage']);
  });
});
