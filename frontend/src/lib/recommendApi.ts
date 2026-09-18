import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { apiFetch } from './api';

/**
 * Typed client for the W8 recommendation endpoint.
 *
 * ## Why `value` and `observed` are separate fields, and stay separate
 *
 * The backend returns a *shrunk* score: the brand's own mean blended toward a category
 * prior in proportion to how much evidence there is. Shrinkage's entire job is replacing a
 * thin measurement with a better estimate, which makes it the one place where "we did not
 * measure this" and "we measured it, then pulled it hard toward the prior" produce the
 * same ordinary-looking number.
 *
 * In the backend that is prevented by a type: `ShrunkScore` is branded and cannot be
 * passed where a measured number is expected. JSON has no brands, so the wire format does
 * it structurally instead — `value` is the estimate, `basis.observed` is what this brand
 * actually did (and is `null` when nothing was measurable), and `basis.brandWeight` says
 * how much of `value` came from the brand at all.
 *
 * **So: never render `value` as if it were a measurement.** Use `basis.brandWeight` to
 * decide how confidently to phrase it, and `explanation` for the sentence itself — the
 * backend has already decided what claim the evidence supports.
 */

export type PriorSource = 'neutral' | 'category-aggregate' | 'category-seed';

export interface ShrinkageBasis {
  /** The brand's own raw mean. `null` when nothing was measurable — never `0`. */
  observed: number | null;
  observations: number;
  prior: number;
  priorSource: PriorSource;
  /** `n / (n + k)`. `0` is a pure prior, `1` is a pure measurement. */
  brandWeight: number;
  priorWeight: number;
}

export type ExplanationKind = 'brand-claim' | 'category-claim' | 'no-claim';

export interface Explanation {
  kind: ExplanationKind;
  /** Only ever non-null on a `brand-claim`. */
  multiplier: number | null;
  category: string | null;
  sampleSize: number;
  untried: boolean;
  selection: 'exploit' | 'explore';
  /** Which number the multiplier was taken from. See the backend's `CLAIM_SOURCES`. */
  claimBasis: 'raw-observed' | 'shrunk';
}

export interface ArchetypeRecommendation {
  archetype: string;
  templateIds: string[];
  /** The shrunk estimate. **Not** a measurement — see the note at the top of this file. */
  value: number;
  basis: ShrinkageBasis;
  scored: number;
  posts: number;
  userChoices: number;
  selection: 'exploit' | 'explore';
  explanation: Explanation;
}

export type SendTimeSlot = string;

export type SlotPriorBasis = 'brand-clicks' | 'category' | 'seed' | 'platform-default' | 'none';

export interface SlotScore {
  slot: SendTimeSlot;
  /** The shrunk estimate, same caveat as `ArchetypeRecommendation.value`. */
  value: number;
  basis: ShrinkageBasis;
  scored: number;
  posts: number;
  priorBasis: SlotPriorBasis;
  claimable: boolean;
}

export interface SuggestedTime {
  slot: SendTimeSlot;
  /** `YYYY-MM-DDTHH:mm` in `timeZone`. **The intent** — persist this, not the instant. */
  local: string;
  timeZone: string;
  instant: string;
}

export interface CadenceWeek {
  weekStart: string;
  posts: number;
  /** `null` when no post that week was measurable. Never `0` — that is a different fact. */
  totalOutcome: number | null;
}

export interface CadenceBand {
  postsPerWeek: number;
  weeks: number;
  measuredWeeks: number;
  value: number;
  basis: ShrinkageBasis;
}

export interface CadenceRecommendation {
  weeks: CadenceWeek[];
  bands: CadenceBand[];
  /** Median posts per week across observed weeks, or `null` with no history. */
  currentPerWeek: number | null;
  /**
   * The advisory range, or `null` when nothing measurable supports one.
   *
   * `null` must render as "not enough history yet", **not** as a default suggestion. A
   * cadence number invented from no evidence is the one output here a brand can act on to
   * its own detriment.
   */
  suggested: { minPerWeek: number; maxPerWeek: number } | null;
  /** Evidence a cliff was crossed, never a prediction that one exists. */
  fatigueAbove: number | null;
  basis: 'brand-weeks' | 'none';
}

export interface Recommendations {
  window: { from: string; to: string };
  brandId: string;
  timezone: string;
  category: string | null;
  archetypes: ArchetypeRecommendation[];
  sendTime: {
    slots: SlotScore[];
    suggested: SuggestedTime | null;
    suggestedSlot: SendTimeSlot | null;
    selection: 'exploit' | 'explore';
  };
  cadence: CadenceRecommendation;
}

export const recommendationsQueryKey = (brandId: string, days: number) =>
  ['recommendations', brandId, days] as const;

export function useRecommendations(
  brandId: string | null,
  days = 90,
): UseQueryResult<Recommendations, unknown> {
  return useQuery({
    queryKey: recommendationsQueryKey(brandId ?? 'none', days),
    enabled: Boolean(brandId),
    queryFn: () => apiFetch<Recommendations>(`/api/brands/${brandId}/recommendations?days=${days}`),
  });
}

/** Human label for an archetype key, which arrives as `BEFORE_AFTER`. */
export function archetypeLabel(archetype: string): string {
  return archetype
    .toLowerCase()
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * The sentence shown under a recommendation.
 *
 * Reads the `explanation` the backend already decided on rather than re-deriving a claim
 * from `value`, which would be the same mistake as rendering a shrunk number as a
 * measurement — the backend applied two separate gates (was the sample big enough, was the
 * effect big enough) and this layer is not in a position to re-apply either.
 *
 * The copy says "your average outcome" rather than naming a component. The multiplier is
 * blended across up to four components, so "2.4× more link clicks" would be false whenever
 * the components disagree — which is the normal case. See
 * `docs/06-outcome-and-feedback-loop.md`.
 */
export function explanationText(item: ArchetypeRecommendation): string {
  const { explanation } = item;
  const label = archetypeLabel(item.archetype);

  if (explanation.selection === 'explore') {
    return explanation.untried
      ? `You haven't tried ${label} yet — worth a test.`
      : `Still learning how ${label} performs for you.`;
  }

  if (explanation.kind === 'brand-claim' && explanation.multiplier !== null) {
    return `${label} posts drove ${explanation.multiplier}× your average outcome over your last ${explanation.sampleSize} measured posts.`;
  }

  if (explanation.kind === 'category-claim') {
    return explanation.category
      ? `Popular with ${explanation.category} — ${label} performs well for businesses like yours.`
      : `${label} performs well for businesses like yours.`;
  }

  return `Not enough measured posts yet to say how ${label} performs for you.`;
}
