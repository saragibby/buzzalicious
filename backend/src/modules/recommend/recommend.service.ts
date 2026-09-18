import type { Db } from '../../platform/db';
import { type ScopedDb, withTenantScope } from '../../platform/tenancy';
import { type TargetOutcome, targetOutcomes } from '../insight/insight.service';
import { type ClickWindow, clicksByLocalHour } from '../link/rollup.service';
import { scoreArchetypes } from './archetype.service';
import { type CadenceRecommendation, recommendCadence } from './cadence.service';
import { type Explanation, explain } from './explanation';
import { rotationBucket, withExploration, withSendTimeExploration } from './exploration';
import { buildNormalizer, normalizedOutcome } from './normalize';
import type { CategoryAggregate } from './priors';
import { RecommendInvariantError } from './recommend.errors';
import {
  type SlotScore,
  type SuggestedTime,
  scoreSlots,
  suggestedTimeFor,
} from './sendtime.service';
import type { SendTimeSlot } from '../brand/category.schemas';
import type { ShrunkScore } from './shrinkage';

/**
 * Assembling one brand's recommendations from the five scoring layers.
 *
 * This module is composition and data loading only. Every judgement — what shrinkage does,
 * what counts as a user choice, what may be claimed, which slots are reserved — lives in
 * the layer that owns it, so that the assembled answer cannot disagree with the parts.
 * docs/06 asks specifically that the "what's working" summary and the recommendations be
 * driven by the same scoring, and the only durable way to get that is to have one scorer.
 */

export interface RecommendInput {
  readonly brandId: string;
  /** The outcome window. Cadence reads the same window, so it bounds both. */
  readonly window: ClickWindow;
  /** Now, injected. Send-time and the exploration rotation both key off it. */
  readonly now: Date;
  /** Slots in the returned list, exploration included. */
  readonly count?: number;
  /**
   * Category aggregates by archetype, already computed and brand-excluded.
   *
   * Passed in rather than loaded here because building them is a deliberately
   * cross-brand read, and a function that takes a `ScopedDb` must not quietly reach
   * outside the scope it was handed. `categoryAggregates` below is the function that does
   * it, and it takes an unscoped `Db` so that the widening is visible at the call site.
   */
  readonly aggregates?: Readonly<Record<string, CategoryAggregate>> | null;
}

export interface ArchetypeRecommendation {
  readonly archetype: string;
  /** Templates carrying this archetype, so the UI has something to render. */
  readonly templateIds: readonly string[];
  /** The ranked value. A `ShrunkScore`, never a bare number. */
  readonly score: ShrunkScore;
  readonly scored: number;
  readonly posts: number;
  readonly userChoices: number;
  readonly selection: 'exploit' | 'explore';
  readonly explanation: Explanation;
}

export interface Recommendations {
  readonly brandId: string;
  readonly timezone: string;
  readonly category: string | null;
  readonly archetypes: readonly ArchetypeRecommendation[];
  readonly sendTime: {
    readonly slots: readonly SlotScore[];
    readonly suggested: SuggestedTime | null;
    readonly suggestedSlot: SendTimeSlot | null;
    readonly selection: 'exploit' | 'explore';
  };
  readonly cadence: CadenceRecommendation;
}

const DEFAULT_COUNT = 8;

/**
 * Everything the composer and the insights page need for one brand.
 *
 * `db` must already be brand-scoped. Nothing here re-filters by `brandId`: doing so would
 * make the tenant scope look optional, and a later reader deleting the redundant filter
 * would have no way to tell whether it was load-bearing.
 */
export async function recommendationsFor(
  db: ScopedDb,
  input: RecommendInput,
): Promise<Recommendations> {
  const { brandId, window, now } = input;
  const count = input.count ?? DEFAULT_COUNT;

  const brand = await db.brand.findFirst({
    where: { id: brandId, deletedAt: null },
    select: {
      id: true,
      timezone: true,
      category: { select: { name: true, priors: true } },
    },
  });

  if (!brand) {
    // Scope already guarantees the caller may see this brand, so a miss here is a missing
    // brand rather than a denied one, and must not be reported as an empty recommendation
    // set — an empty set is a valid answer for a real brand.
    throw new RecommendInvariantError(`brand ${brandId} not found`);
  }

  const targets = await targetOutcomes(db, window);
  const templates = await db.template.findMany({
    // Only published templates are recommendable. A draft has no business appearing in a
    // composer, and an archived one would keep being recommended on the strength of the
    // history that got it archived.
    where: { status: 'PUBLISHED' },
    select: { id: true, archetype: true },
  });

  const templatesByArchetype = new Map<string, string[]>();
  for (const template of templates) {
    const list = templatesByArchetype.get(template.archetype) ?? [];
    list.push(template.id);
    templatesByArchetype.set(template.archetype, list);
  }

  // Candidates come from the template catalogue, not from the brand's history. Deriving
  // them from history would make an untried archetype unrecommendable, which is the local
  // maximum exploration exists to break.
  const candidates = [...templatesByArchetype.keys()].sort();
  const seed = archetypeSeed(brand.category?.priors);

  const scores = scoreArchetypes({
    targets,
    candidates,
    aggregates: input.aggregates,
    seed,
  });

  const rotation = rotationBucket(now, brand.timezone);
  const selected = withExploration({
    ranked: scores,
    scoreOf: (score) => score.score,
    rotation,
    count,
  });

  const archetypes = selected.map(({ item, kind }) => ({
    archetype: item.archetype,
    templateIds: templatesByArchetype.get(item.archetype) ?? [],
    score: item.score,
    scored: item.scored,
    posts: item.posts,
    userChoices: item.userChoices,
    selection: kind,
    explanation: explain({
      score: item.score,
      scored: item.scored,
      posts: item.posts,
      claimable: item.claimable,
      selection: kind,
      category: brand.category?.name ?? null,
    }),
  }));

  const clickHours = await clicksByLocalHour(db, brandId, window, brand.timezone);
  const slots = scoreSlots({
    targets,
    timeZone: brand.timezone,
    clickHours,
    seed: slotSeed(brand.category?.priors),
  });

  // One slot, but chosen through the same reservation the templates use. A scheduler that
  // only ever exploits generates no observations outside its current slot, so the first
  // lucky time becomes permanent — the failure docs/06 calls out as worse for timing than
  // for templates.
  const [chosen] = withSendTimeExploration({
    ranked: slots,
    scoreOf: (slot) => slot.score,
    rotation,
    count: 1,
  });

  return {
    brandId: brand.id,
    timezone: brand.timezone,
    category: brand.category?.name ?? null,
    archetypes,
    sendTime: {
      slots,
      suggested: chosen ? suggestedTimeFor(chosen.item.slot, brand.timezone, now) : null,
      suggestedSlot: chosen?.item.slot ?? null,
      selection: chosen?.kind ?? 'exploit',
    },
    cadence: recommendCadence({ targets, timeZone: brand.timezone }),
  };
}

/**
 * Mean normalised outcome per archetype across every *other* brand in a category.
 *
 * Takes an unscoped `Db` on purpose, and is the only function in the module that does.
 * A category prior is a platform-wide statistic by definition — "how does this archetype
 * do for businesses like yours" cannot be answered from inside one brand's scope — so the
 * widening is real. Keeping it in its own function with its own parameter type means the
 * widening appears at the call site instead of hiding inside a request handler.
 *
 * The widening is narrower than it looks, though: `Db` is needed only to *discover* which
 * brands share the category. Every outcome read underneath is done through that brand's
 * own scope, so no query in this function returns rows from more than one tenant.
 *
 * `exceptBrandId` is not an optimisation. Leaving a brand in its own prior would shrink its
 * observations toward themselves, which damps nothing and makes `k` a no-op for exactly
 * the brands with enough data to notice.
 *
 * Each brand is normalised against **its own** median before averaging. Without that, a
 * high-traffic brand would set the category's opinion single-handedly and the prior would
 * describe the biggest account in the category rather than the category.
 */
export async function categoryAggregates(
  db: Db,
  categoryId: string,
  window: ClickWindow,
  exceptBrandId: string,
): Promise<Record<string, CategoryAggregate>> {
  const brands = await db.brand.findMany({
    where: { categoryId, deletedAt: null, id: { not: exceptBrandId } },
    select: { id: true, workspaceId: true },
  });

  if (brands.length === 0) return {};

  // Read each contributing brand through its *own* brand scope rather than reading the
  // category in one unscoped sweep.
  //
  // The sweep was the obvious shape and it is the wrong one. `targetOutcomes` takes a
  // `ScopedDb`, so an unscoped read has to arrive either as a cast or as
  // `withTenantScope(db, null)` — and the second throws by design, which is how this was
  // caught. Both amount to switching the guarantee off for a query whose results are then
  // immediately partitioned back into exactly the per-brand buckets the scope would have
  // produced. The filtering was doing tenancy's job in application code, where a dropped
  // `continue` is a silent cross-tenant leak rather than a thrown error.
  //
  // So the loop is not a concession to the type. Widening here would have been widening
  // for a grouping we then undo.
  const byBrand = new Map<string, TargetOutcome[]>();
  for (const brand of brands) {
    const scope = { kind: 'brand', workspaceId: brand.workspaceId, brandId: brand.id } as const;
    const brandTargets = await targetOutcomes(withTenantScope(db, scope), window);
    if (brandTargets.length > 0) byBrand.set(brand.id, brandTargets);
  }

  // archetype -> one mean per contributing brand. Brands, not posts, are the unit: the
  // `observations` count feeding `resolvePrior` is "how many businesses like yours does
  // this rest on", and counting posts there would let one prolific brand read as a crowd.
  const perBrand = new Map<string, number[]>();
  for (const brandTargets of byBrand.values()) {
    const normalizer = buildNormalizer(brandTargets);
    const sums = new Map<string, { total: number; n: number }>();
    for (const target of brandTargets) {
      if (!target.archetype) continue;
      const { score } = normalizedOutcome(target, normalizer);
      if (score === null) continue;
      const entry = sums.get(target.archetype) ?? { total: 0, n: 0 };
      entry.total += score;
      entry.n += 1;
      sums.set(target.archetype, entry);
    }
    for (const [archetype, { total, n }] of sums) {
      const list = perBrand.get(archetype) ?? [];
      list.push(total / n);
      perBrand.set(archetype, list);
    }
  }

  const aggregates: Record<string, CategoryAggregate> = {};
  for (const [archetype, means] of perBrand) {
    aggregates[archetype] = {
      mean: means.reduce((sum, mean) => sum + mean, 0) / means.length,
      observations: means.length,
    };
  }
  return aggregates;
}

/** `BusinessCategory.priors.archetypes`, defensively — the column is free-form JSON. */
export function archetypeSeed(priors: unknown): Record<string, number> | null {
  return numericRecord(priors, 'archetypes');
}

/** `BusinessCategory.priors.sendTimeSlots`, same treatment. */
export function slotSeed(priors: unknown): Record<string, number> | null {
  return numericRecord(priors, 'sendTimeSlots');
}

/**
 * Pull a `Record<string, number>` out of untyped JSON, dropping anything that is not one.
 *
 * Seeds are hand-maintained and unvalidated at rest, so a typo reaches this function
 * rather than a schema. Dropping a bad entry degrades a prior to neutral, which is a
 * recoverable wrong answer; letting `NaN` through would propagate into a score and make
 * every comparison involving it silently false.
 */
function numericRecord(priors: unknown, key: string): Record<string, number> | null {
  if (typeof priors !== 'object' || priors === null) return null;
  const section = (priors as Record<string, unknown>)[key];
  if (typeof section !== 'object' || section === null) return null;

  const out: Record<string, number> = {};
  for (const [name, value] of Object.entries(section as Record<string, unknown>)) {
    if (typeof value === 'number' && Number.isFinite(value)) out[name] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}
