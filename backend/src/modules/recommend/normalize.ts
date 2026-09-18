import type { Platform } from '@prisma/client';
import { getConfig } from '../../platform/config';
import { COMPONENTS, componentValues, type OutcomeComponent } from '../insight/outcome';
import type { TargetOutcome } from '../insight/insight.service';

/**
 * Making outcome scores comparable, which they are not as W7 leaves them.
 *
 * ## Why this layer exists at all
 *
 * docs/06 specifies `w_click · normalize(linkClicks / reach) + …` — every component put
 * on a common scale *before* the weights are applied. W7 implemented the weighted blend
 * over **raw counts** and deferred normalisation here explicitly, which was the right
 * call: with a sample of one it would have produced confident nonsense.
 *
 * The deferral left two defects that look like one:
 *
 * 1. **Units.** A raw click count and a raw like count are not on the same scale, so
 *    weighting them expresses nothing.
 * 2. **Priors, which is the one that decides it.** `prior(category(b), a)` is a
 *    cross-brand aggregate. On raw counts a brand with 20,000 followers and one with 200
 *    are summed, and the category prior becomes a description of whichever brand is
 *    biggest. Every cold-start recommendation then inherits it — and shrinkage
 *    *propagates* that rather than damping it, because trusting the prior when data is
 *    thin is precisely shrinkage's job.
 *
 * Normalising per `(brand, platform)` against the brand's own median fixes both: a value
 * of `1.0` means "typical for this brand here", and a category prior becomes an average
 * of relative performances rather than of audience sizes.
 *
 * ## The denominator is `impressions`, not `reach` — a deviation from docs/06
 *
 * docs/06 says `reach`. Checked against the adapters, `reach` is **null on half the v1
 * platforms**: Threads reports views and X reports impressions; only Meta reports unique
 * reach. Dividing by `reach` would make every component null for every X and Threads
 * post, so those posts would drop out of ranking entirely — looking exactly like "X
 * doesn't perform", which is W7's null-versus-zero hazard one level up: not a zero
 * standing in for unknown, but an *absence* standing in for a judgement.
 *
 * `impressions` is populated on all four. The usual objection — impressions count repeat
 * views while reach counts unique people, so they are not comparable across platforms —
 * does not apply here, because normalising per `(brand, platform)` means the denominator
 * never needs cross-platform comparability. It only has to be consistent *within* one
 * platform, which it is. That is a structural advantage of this design over the doc's
 * formula, which implies a cross-platform comparison it cannot actually support.
 *
 * ## The denominator is chosen once per group, and declared
 *
 * A failed metrics poll can leave `impressions` null on a row whose other metrics landed.
 * Choosing the denominator per *post* would then compute a median over a mixture of rates
 * and raw counts — a silent unit error producing a plausible number. So the choice is
 * made once per `(platform, component)` and recorded on the basis, the same discipline as
 * `priorSource`: a value that cannot say how it was derived is one nobody can safely
 * overwrite.
 *
 * ## Unmeasured components are imputed at 1.0, and say so
 *
 * See `normalizedOutcome` below. This is the part to read before changing anything here.
 */

/** What a component's values were divided by before the median was taken. */
export type NormalizationDenominator =
  /** `count / impressions` — a rate. The default, available on all four v1 platforms. */
  | 'impressions'
  /**
   * The raw count, undivided.
   *
   * docs/06's stated fallback for when the denominator is unavailable. Rare now that the
   * denominator is `impressions` rather than `reach`, but a failed poll can still leave a
   * row with counts and no impressions.
   */
  | 'raw-count';

/** Which population a component's median was taken over. Provenance, not a detail. */
export type NormalizationSource =
  /** This brand, on this platform. What we want. */
  | 'brand-platform'
  /**
   * This brand, pooled across every platform it posts to.
   *
   * Used when one platform is too thin on its own. Weaker, because platforms differ in
   * absolute rates — but it is the brand's own data, which a category median is not.
   */
  | 'brand-all-platforms'
  /**
   * No usable median. The component is treated as **unmeasured**, not as its raw value.
   *
   * Passing a raw count through as though it were a ratio would report 50 clicks as
   * "50× typical". Deliberately *not* a silent substitution of a category median: the
   * brief requires the thin-brand fallback be visible rather than quietly filled in.
   */
  | 'unnormalized';

/** How one component of one `(brand, platform)` group was put on a relative scale. */
export interface ComponentNormalization {
  readonly component: OutcomeComponent;
  readonly denominator: NormalizationDenominator;
  readonly source: NormalizationSource;
  /** The divisor. `null` exactly when `source` is `unnormalized`. */
  readonly median: number | null;
  /** Observations behind the median. Below the configured minimum it is not used. */
  readonly sampleSize: number;
}

/**
 * A relative outcome score: `1.0` is typical for this brand on this platform.
 *
 * ## Why there is no coverage division
 *
 * The obvious blend is a coverage-normalised weighted mean, `Σ(w·x) / Σ(w)` over the
 * components actually available. It has two defects, and they are not obvious until the
 * algebra is written out:
 *
 * ```
 *   clicks-only, 2× typical                   → 0.45·2.0 / 0.45 = 2.00
 *   likes-only,  2× typical                   → 0.10·2.0 / 0.10 = 2.00
 *   4-component, 2× clicks + 1× everything    → 1.45
 * ```
 *
 * The weight **cancels** for any single component — it is division by the same weight —
 * so a post that doubled its likes scores identically to one that doubled its clicks, and
 * the product thesis that clicks are intent while likes are scrolling evaporates exactly
 * where measurement is thinnest. Worse, the third line shows a post penalised for
 * reporting *more* metrics: two posts that did equally well on clicks, and the one we know
 * more about scores lower. That bias is systematic per platform, so it would never look
 * like noise.
 *
 * Normalisation creates something that did not exist before it: a meaningful **neutral
 * value**. After dividing by the brand's own median, `1.0` means "unremarkable for this
 * brand". So an unmeasured component has an honest stand-in, and the blend becomes a sum
 * over all four components with unmeasured ones imputed at `1.0`:
 *
 * ```
 *   clicks-only, 2× typical                   → 1.45
 *   likes-only,  2× typical                   → 1.10   ← the weights do their job
 *   4-component, 2× clicks + 1× everything    → 1.45   ← identical to clicks-only 2×
 *   everything typical                        → 1.00
 * ```
 *
 * Both defects go. The third line is the one that earns it: two posts indistinguishable
 * on the evidence now score the same, so coverage bias goes to zero rather than being
 * traded from one sign to the other.
 *
 * ## Imputing 1.0 is a claim, so it is declared
 *
 * This is **not** W7's "a zero is a lie" in a new costume. `0` claims the post failed on
 * that component. `1.0` claims it was unremarkable — the only value that moves the score
 * in neither direction, and the maximum-entropy choice given the brand's own
 * distribution. It is still a claim, which is why `measured` and `imputed` travel with
 * the score instead of being folded away.
 *
 * And the endpoint stays guarded: **when nothing at all was measured the score is `null`,
 * never `1.0`.** Imputing every component would hand a confident "perfectly typical" to a
 * post we know nothing about, which is the same interior hazard arriving through the
 * coverage door instead of the shrinkage one.
 *
 * ## Two residuals, neither solved, both real
 *
 * **Imputation assumes unmeasured ≈ typical.** If a platform systematically
 * under-delivers on a component it never reports, we will never find out. That is
 * unfalsifiable by construction, not merely untested.
 *
 * **Coverage now biases variance rather than the mean.** Imputation pins the expectation
 * at 1.0, which is the win, but it compresses the *range* in proportion to measured
 * coverage — only 0.45 of the weight can vary on a clicks-only platform, while all 1.00
 * can vary where four components are reported:
 *
 * ```
 *                    clicks-only     all four
 *   0.5× typical        0.78           0.50
 *   1.0× typical        1.00           1.00
 *   2.0× typical        1.45           2.00
 *   3.0× typical        1.90           3.00
 * ```
 *
 * Identical relative performance, different scores. Since ranking takes the top, ranked
 * lists over-represent high-coverage platforms — and symmetrically over-represent them at
 * the bottom, which nobody looks at, so the asymmetry of attention makes a variance
 * artefact read as a finding. It only bites when archetype usage correlates with
 * platform, which it plausibly does: a visual archetype skews Meta, a text archetype
 * skews X.
 *
 * Left unsolved deliberately — variance-correcting a four-component blend at small `n` is
 * its own research problem and would be worse than the disease at v1 volumes. It is
 * pinned by a test in `normalize.test.ts` so that changing it is a decision rather than
 * an accident. The exploration reservation in `exploration.ts` damps the compounding
 * half of it; see the note there.
 */
export interface NormalizedOutcome {
  /** `null` when no component was measurable. Never `0`, and never `1.0`. */
  readonly score: number | null;
  /** Components with a real, normalised observation behind them. */
  readonly measured: OutcomeComponent[];
  /** Components assumed typical. Empty when everything was measured. */
  readonly imputed: OutcomeComponent[];
  /** The normalised value per measured component, for explanations. `2.4` = 2.4× typical. */
  readonly values: Partial<Record<OutcomeComponent, number>>;
}

/** The medians a brand's targets are scored against, keyed by `(platform, component)`. */
export interface Normalizer {
  readonly bases: ComponentNormalization[];
  basisFor(platform: Platform, component: OutcomeComponent): ComponentNormalization;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/** One target's raw value for a component, plus whether impressions were available. */
interface Observation {
  platform: Platform;
  value: number;
  impressions: number | null;
}

function observationsFor(targets: TargetOutcome[], component: OutcomeComponent): Observation[] {
  const out: Observation[] = [];

  for (const target of targets) {
    const values = componentValues(target);
    const value = values[component];
    if (value === null) continue;

    // Zero impressions is not a usable denominator — it would divide a real count by
    // nothing. Treated as absent rather than as a rate of infinity.
    const impressions =
      target.impressions !== null && target.impressions > 0 ? target.impressions : null;

    out.push({ platform: target.platform, value, impressions });
  }

  return out;
}

/** Rates where impressions allow it, raw counts otherwise. Never a mixture. */
function valuesUnder(observations: Observation[], denominator: NormalizationDenominator): number[] {
  if (denominator === 'raw-count') return observations.map((o) => o.value);
  return observations
    .filter((o) => o.impressions !== null)
    .map((o) => o.value / (o.impressions as number));
}

/**
 * Build the medians for one brand's targets.
 *
 * Every `(platform, component)` pair gets its own basis, resolved down a declared stack:
 * this platform's rates, then the brand pooled across platforms, then nothing. A pair
 * that resolves to `unnormalized` is reported as such rather than silently falling back
 * to a category median, which would substitute other brands' data into a number labelled
 * as this brand's.
 */
export function buildNormalizer(targets: TargetOutcome[]): Normalizer {
  const minSample = getConfig().recommend.minSampleForMedian;
  const platforms = [...new Set(targets.map((target) => target.platform))];
  const bases: ComponentNormalization[] = [];
  const index = new Map<string, ComponentNormalization>();

  for (const platform of platforms) {
    for (const component of COMPONENTS) {
      const all = observationsFor(targets, component);
      const onPlatform = all.filter((o) => o.platform === platform);

      const basis = resolve(component, onPlatform, all, minSample);
      bases.push(basis);
      index.set(`${platform}:${component}`, basis);
    }
  }

  const missing: ComponentNormalization = {
    component: 'click',
    denominator: 'raw-count',
    source: 'unnormalized',
    median: null,
    sampleSize: 0,
  };

  return {
    bases,
    basisFor: (platform, component) =>
      index.get(`${platform}:${component}`) ?? { ...missing, component },
  };
}

function resolve(
  component: OutcomeComponent,
  onPlatform: Observation[],
  all: Observation[],
  minSample: number,
): ComponentNormalization {
  // `impressions` first, because a rate is the quantity docs/06 asks for. Falling back to
  // raw counts is the doc's own stated fallback when the denominator is unavailable.
  const attempts: { source: NormalizationSource; observations: Observation[] }[] = [
    { source: 'brand-platform', observations: onPlatform },
    { source: 'brand-all-platforms', observations: all },
  ];

  for (const attempt of attempts) {
    for (const denominator of ['impressions', 'raw-count'] as const) {
      const values = valuesUnder(attempt.observations, denominator);
      if (values.length < minSample) continue;

      const mid = median(values);
      // A median of zero cannot divide. It means most posts earned nothing on this
      // component, which is information — but it is not a scale, and dividing by it
      // would produce Infinity and sort to the top of every ranking.
      if (mid === null || mid <= 0) continue;

      return {
        component,
        denominator,
        source: attempt.source,
        median: mid,
        sampleSize: values.length,
      };
    }
  }

  return {
    component,
    denominator: 'impressions',
    source: 'unnormalized',
    median: null,
    sampleSize: onPlatform.length,
  };
}

/**
 * Score one target relative to its brand's own typical performance.
 *
 * Unmeasured and un-normalisable components are imputed at `1.0` and listed in `imputed`.
 * If nothing was measured the score is `null` — see the type docs above for why that
 * endpoint is guarded separately from the interior.
 */
export function normalizedOutcome(
  target: TargetOutcome,
  normalizer: Normalizer,
): NormalizedOutcome {
  const weights = getConfig().outcome.weights;
  const raw = componentValues(target);

  const measured: OutcomeComponent[] = [];
  const imputed: OutcomeComponent[] = [];
  const values: Partial<Record<OutcomeComponent, number>> = {};

  for (const component of COMPONENTS) {
    const basis = normalizer.basisFor(target.platform, component);
    const value = raw[component];

    if (value === null || basis.median === null) {
      imputed.push(component);
      continue;
    }

    // The value must be expressed under the same denominator the median was taken
    // under, or the division compares a rate against a count and returns a plausible
    // number that means nothing.
    let scaled: number;
    if (basis.denominator === 'impressions') {
      if (target.impressions === null || target.impressions <= 0) {
        imputed.push(component);
        continue;
      }
      scaled = value / target.impressions;
    } else {
      scaled = value;
    }

    measured.push(component);
    values[component] = scaled / basis.median;
  }

  if (measured.length === 0) {
    return { score: null, measured: [], imputed: [], values: {} };
  }

  let score = 0;
  for (const component of COMPONENTS) {
    // `1.0` for anything unmeasured: unremarkable, and the only value that moves the
    // score in neither direction.
    score += weights[component] * (values[component] ?? 1);
  }

  return { score, measured, imputed, values };
}
