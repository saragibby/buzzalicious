import type { TargetOutcome } from '../insight/insight.service';
import { getConfig } from '../../platform/config';
import { buildNormalizer, normalizedOutcome, type Normalizer } from './normalize';
import { resolvePrior, type CategoryAggregate } from './priors';
import { compareShrunk, shrink, type ShrunkScore } from './shrinkage';

/**
 * Scoring template archetypes for one brand.
 *
 * Pure: takes rows and returns rankings. The Prisma query lives in `recommend.service.ts`,
 * so every rule below is testable without a database — which matters, because these are
 * the rules that decide what a user is told about their own business.
 *
 * ## The contamination rule, which is dimension-specific and easy to get backwards
 *
 * The brief requires exploration posts be tagged so "the loop does not train on its own
 * suggestions". That is right, and it does **not** mean excluding exploration posts from
 * outcome scoring. The opposite: an exploration post's measured outcome is the entire
 * return on having explored. Excluding it would make exploration a pure cost — we would
 * pay for the slot, take the risk, and then throw away the only thing we bought.
 *
 * What must be excluded is the *choice*. Two different signals live in the same rows:
 *
 * | signal | question | exploration counts? |
 * |---|---|---|
 * | outcome | did this do well? | **yes** — that is the point of measuring it |
 * | preference | did this brand want this? | **no** — we picked it, not them |
 *
 * Reading "posted with this archetype eight times" as preference when we scheduled six of
 * them is the self-confirming loop the tagging exists to prevent: we suggest, the
 * suggestion gets published, we count the publication as evidence the user likes it, and
 * we suggest harder. The brand's actual taste never enters. `SUGGESTED` is excluded for
 * the same reason and is the subtler case — the user accepted it, but accepting a default
 * is not choosing, and a default accepted eight times is still our opinion.
 *
 * ## `observed` stays raw
 *
 * Mirroring W7's discipline: `observed` is the brand's own unshrunk mean and means exactly
 * that. The shrunk estimate is a separate field of a type that cannot be mistaken for a
 * measurement. See `shrinkage.ts`.
 */

/** Schedule sources that represent a decision by the user rather than by us. */
const USER_CHOSEN = new Set(['USER']);

export interface ArchetypeScoreInputs {
  /** The brand's published targets. Exploration posts included — see above. */
  readonly targets: TargetOutcome[];
  /**
   * Archetypes that could be recommended, including ones the brand has never used.
   *
   * Passed in rather than derived from `targets`, because deriving them would make an
   * untried archetype unrecommendable — the brand would only ever be offered what it had
   * already done, which is the local maximum the exploration requirement exists to break.
   */
  readonly candidates: readonly string[];
  /** Category aggregates by archetype, with the brand's own posts already excluded. */
  readonly aggregates?: Readonly<Record<string, CategoryAggregate>> | null;
  /** Hand-seeded `BusinessCategory.priors.archetypes`. */
  readonly seed?: Readonly<Record<string, number>> | null;
  /** Overrides `SHRINKAGE_K`. */
  readonly k?: number;
}

export interface ArchetypeScore {
  readonly archetype: string;
  /** The ranked value. Not a number, and not assignable to one. */
  readonly score: ShrunkScore;
  /** Targets with a normalisable outcome. The `n` in the shrinkage formula. */
  readonly scored: number;
  /** Published targets with this archetype, measurable or not. Always `>= scored`. */
  readonly posts: number;
  /**
   * Times the **user** chose this archetype, excluding our own suggestions.
   *
   * Never feeds the score. Carried for tie-breaks and for honest copy — "you use this a
   * lot" is a different statement from "this performs well", and conflating them is how a
   * recommender starts describing its own behaviour back to the user.
   */
  readonly userChoices: number;
  /**
   * Whether a brand-specific numeric claim ("2.4× your average") is permitted, or whether
   * the UI must fall back to category framing ("popular with coffee shops").
   */
  readonly claimable: boolean;
}

function meanOrNull(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Score every candidate archetype, best first.
 *
 * An archetype the brand has never used still appears, scored at its prior with
 * `scored: 0` and `brandWeight: 0` — which is the honest answer, and is exactly the state
 * a caller needs to see in order to offer it as exploration rather than as a claim.
 */
export function scoreArchetypes(inputs: ArchetypeScoreInputs): ArchetypeScore[] {
  const minSample = getConfig().recommend.minSampleForClaim;
  const { targets, candidates, aggregates, seed, k } = inputs;

  // One normaliser over all the brand's targets, not one per archetype. Per-archetype
  // medians would define "typical for this brand" separately inside each group, so every
  // archetype would score about 1.0 by construction and the ranking would be noise.
  const normalizer = buildNormalizer(targets);

  const scores = candidates.map((archetype) => {
    const mine = targets.filter((target) => target.archetype === archetype);
    const values = mine
      .map((target) => normalizedOutcome(target, normalizer).score)
      .filter((score): score is number => score !== null);

    const observed = meanOrNull(values);
    const prior = resolvePrior({ key: archetype, aggregate: aggregates?.[archetype], seed });

    return {
      archetype,
      score: shrink({
        observed,
        observations: values.length,
        prior: prior.prior,
        priorSource: prior.source,
        k,
      }),
      scored: values.length,
      posts: mine.length,
      userChoices: countUserChoices(mine),
      claimable: values.length >= minSample,
    };
  });

  return scores.sort((a, b) => compareShrunk(a.score, b.score));
}

/**
 * How many of these targets represent the user choosing this archetype.
 *
 * Counted per *post*, not per target: publishing one post to four platforms is one
 * decision. Counting targets would make a brand's cross-posting habit look like four times
 * the enthusiasm, and would rank multi-platform archetypes above single-platform ones on
 * distribution rather than on preference.
 */
export function countUserChoices(targets: TargetOutcome[]): number {
  const posts = new Set<string>();
  for (const target of targets) {
    if (!USER_CHOSEN.has(target.scheduleSource)) continue;
    posts.add(target.postId);
  }
  return posts.size;
}

/** Exposed so `sendtime.service.ts` normalises against the same medians. */
export function normalizerFor(targets: TargetOutcome[]): Normalizer {
  return buildNormalizer(targets);
}
