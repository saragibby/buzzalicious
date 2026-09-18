import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Db } from '../../../platform/db';
import { getConfig } from '../../../platform/config';
import { getLogger } from '../../../platform/logger';
import { generateStructuredMetered } from '../../ai/metered';
import { isBudgetExceededError } from '../../usage/usage.errors';
import { getPlatformWorkspaceId } from '../../usage/platform-workspace';
import {
  readCategoryMapping,
  writeCategoryMapping,
  type TrendCategoryMapping,
} from '../trend.schemas';
import { mergeRaw, replaceCategoryScores, type TrendWithRelations } from '../trend.repository';
import { RULES_VERSION, applyRules, explainMatch } from './rules';

/**
 * Category mapping: turning a global trend into per-category relevance.
 *
 * docs/07 calls this "the step that makes the whole thing worth building", and it is the
 * half of the product that generic trend tools do not have. Layers run cheapest first:
 *
 *  1. **Rules** — deterministic, explainable, free. Handles a large share of
 *     small-business vocabulary and produces the evidence the feed cites.
 *  2. **LLM** — only for what the rules miss, and only when the result would otherwise be
 *     too weak to trust.
 *
 * Layers 3 (embeddings) and 4 (outcome feedback) are out of scope for v0; layer 4 depends
 * on W7's outcome data, which does not exist yet.
 *
 * **Cached per trend, never per brand.** This is the consequence of ADR-0010: trends are
 * global, so a classification is a property of the trend and holds for every tenant. Doing
 * it per brand would be one model call per customer for an identical answer.
 */

/**
 * Below this, a mapping is withheld from the feed and queued for human review.
 *
 * Withholding is the deliberate choice. docs/07 lists "category mapping produces
 * irrelevant trends" as a headline risk, and a confidently wrong mapping surfaces
 * irrelevant trends and erodes trust faster than a thin feed does. A gap is recoverable;
 * a user concluding the feed does not understand their business is not.
 */
export const NEEDS_REVIEW_BELOW = 0.45;

/** Categories scoring under this are noise and are not stored at all. */
export const MIN_STORED_SCORE = 0.25;

/** How many categories one trend may map to. Beyond this it is not a category signal. */
export const MAX_CATEGORIES = 12;

/**
 * Cache key over everything a mapping depends on.
 *
 * Note what is *not* in it: any brand, workspace or tenant. Adding a customer must not
 * invalidate a single mapping. Editing a trend's title, or shipping new rules, must
 * invalidate all of them.
 */
export function mappingInputHash(input: {
  title: string;
  description?: string | null;
  taxonomyVersion: string;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        title: input.title.trim().toLowerCase(),
        description: (input.description ?? '').trim().toLowerCase(),
        rules: RULES_VERSION,
        taxonomy: input.taxonomyVersion,
      }),
    )
    .digest('hex')
    .slice(0, 32);
}

export interface TaxonomyEntry {
  id: string;
  slug: string;
  name: string;
  parentSlug: string | null;
}

/**
 * The taxonomy, plus a version string derived from it.
 *
 * The version is a hash of the slug set rather than a hand-maintained number, so pruning
 * or adding a category invalidates cached mappings automatically. A mapping computed
 * against a taxonomy that no longer exists is worse than no mapping.
 */
export async function loadTaxonomy(db: Db): Promise<{ entries: TaxonomyEntry[]; version: string }> {
  const rows = await db.businessCategory.findMany({
    select: { id: true, slug: true, name: true, parent: { select: { slug: true } } },
    orderBy: { slug: 'asc' },
  });

  const entries = rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    parentSlug: row.parent?.slug ?? null,
  }));

  const version = createHash('sha256')
    .update(entries.map((e) => e.slug).join(','))
    .digest('hex')
    .slice(0, 16);

  return { entries, version };
}

const LlmClassificationSchema = z.object({
  categories: z
    .array(
      z.object({
        slug: z.string(),
        score: z.number().min(0).max(1),
        reason: z.string().min(1).max(300),
      }),
    )
    .max(MAX_CATEGORIES),
});

export interface MapTrendOptions {
  /** Re-map even when the cached `inputHash` still matches. */
  force?: boolean;
  /** Skip layer 2 entirely. Set in tests and on machines with no AI key. */
  skipLlm?: boolean;
}

export interface MapTrendResult {
  mapping: TrendCategoryMapping;
  scores: { categoryId: string; categorySlug: string; score: number }[];
  /** True when the cache was reused and nothing was recomputed. */
  cached: boolean;
}

/**
 * Maps one trend onto the taxonomy and persists the result.
 *
 * Rules run first and unconditionally. The model is consulted only when the rules produced
 * nothing confident enough to act on — which keeps the spend proportional to the trends
 * that actually need it, and keeps the explainable path as the default rather than the
 * fallback.
 */
export async function mapTrend(
  db: Db,
  trend: TrendWithRelations,
  taxonomy: { entries: TaxonomyEntry[]; version: string },
  now: Date,
  options: MapTrendOptions = {},
): Promise<MapTrendResult> {
  const logger = getLogger().child({ component: 'trend.mapping' });
  const inputHash = mappingInputHash({
    title: trend.title,
    description: trend.description,
    taxonomyVersion: taxonomy.version,
  });

  const cached = readCategoryMapping(
    // Read `raw` from the row rather than the passed object. The cache check is the whole
    // "classify once per trend, not once per brand" guarantee, and a caller holding a
    // `Trend` loaded before an earlier mapping would silently reclassify it every time.
    (await db.trend.findUniqueOrThrow({ where: { id: trend.id }, select: { raw: true } })).raw,
  );

  // A human decision outranks a recomputation. Re-mapping a trend a curator has already
  // confirmed or rejected would silently discard the most reliable signal we have.
  const humanReviewed = cached?.reviewStatus === 'CONFIRMED' || cached?.reviewStatus === 'REJECTED';

  if (cached && (humanReviewed || (!options.force && cached.inputHash === inputHash))) {
    return {
      mapping: cached,
      scores: resolveScores(cached, taxonomy),
      cached: true,
    };
  }

  const bySlug = new Map(taxonomy.entries.map((e) => [e.slug, e]));
  const ruleMatches = applyRules({ title: trend.title, description: trend.description });

  let method: TrendCategoryMapping['method'] = 'rules';
  let evidence: TrendCategoryMapping['evidence'] = ruleMatches
    // A rule naming a slug the taxonomy no longer has is dropped, not an error — the
    // taxonomy is allowed to change without a code deploy.
    .filter((match) => bySlug.has(match.categorySlug))
    .map((match) => ({
      categorySlug: match.categorySlug,
      score: match.score,
      reason: explainMatch(match),
    }));

  const bestRuleScore = evidence[0]?.score ?? 0;

  if (bestRuleScore < NEEDS_REVIEW_BELOW && !options.skipLlm && hasAiProvider()) {
    const llm = await classifyWithLlm(db, trend, taxonomy, bySlug, logger);

    if (llm.length > 0) {
      method = 'llm';
      evidence = mergeEvidence(evidence, llm);
    }
  }

  evidence = evidence
    .filter((e) => e.score >= MIN_STORED_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CATEGORIES);

  const confidence = evidence[0]?.score ?? 0;

  const mapping: TrendCategoryMapping = {
    method,
    confidence,
    reviewStatus: confidence < NEEDS_REVIEW_BELOW ? 'NEEDS_REVIEW' : 'OK',
    mappedAt: now.toISOString(),
    inputHash,
    evidence,
  };

  const scores = resolveScores(mapping, taxonomy);

  /**
   * An empty classification records the flag but **does not touch the stored scores.**
   *
   * Found against the seed: the rules table has nothing to say about "Quiet coastal
   * styling", and replacing scores unconditionally deleted the hand-authored ones that
   * were already there — a mapping layer that knows nothing silently destroying the work
   * of one that did. "I have no opinion" and "the correct answer is no categories" are
   * different statements, and only the second justifies a delete.
   */
  if (scores.length > 0) {
    await replaceCategoryScores(
      db,
      trend.id,
      scores.map((s) => ({ categoryId: s.categoryId, score: s.score })),
      now,
    );
  }

  await mergeRaw(db, trend.id, (raw) => writeCategoryMapping(raw, mapping));

  logger.info(
    {
      trendId: trend.id,
      method,
      confidence,
      categories: scores.length,
      review: mapping.reviewStatus,
      keptExistingScores: scores.length === 0,
    },
    'mapped trend to categories',
  );

  return { mapping, scores, cached: false };
}

function resolveScores(
  mapping: TrendCategoryMapping,
  taxonomy: { entries: TaxonomyEntry[] },
): { categoryId: string; categorySlug: string; score: number }[] {
  const bySlug = new Map(taxonomy.entries.map((e) => [e.slug, e]));

  return mapping.evidence.flatMap((item) => {
    const entry = bySlug.get(item.categorySlug);
    return entry ? [{ categoryId: entry.id, categorySlug: entry.slug, score: item.score }] : [];
  });
}

/** Rule evidence wins a tie: it is explainable and free, and the model is the fallback. */
function mergeEvidence(
  rules: TrendCategoryMapping['evidence'],
  llm: TrendCategoryMapping['evidence'],
): TrendCategoryMapping['evidence'] {
  const merged = new Map(rules.map((item) => [item.categorySlug, item]));

  for (const item of llm) {
    const existing = merged.get(item.categorySlug);
    if (!existing || item.score > existing.score) merged.set(item.categorySlug, item);
  }

  return [...merged.values()];
}

function hasAiProvider(): boolean {
  const { ai } = getConfig();
  return Boolean(ai.openaiApiKey ?? ai.geminiApiKey ?? (ai.azure.apiKey && ai.azure.endpoint));
}

/**
 * Layer 2. One structured call per trend.
 *
 * Failure is swallowed to a log line on purpose: docs/07 requires a failing source to
 * degrade the feed rather than break it, and an unreachable model must not take down a
 * curation run that had perfectly good rule matches in hand.
 *
 * **`BudgetExceededError` is the one exception, and it is rethrown.** ADR-0011 names this
 * as the thing not to get wrong: swallowing it would turn an engaged spend fuse into a
 * curation run that quietly produces worse mappings, every cycle, until someone notices
 * the quality drop and goes looking for a model regression that is not there. Exhaustion
 * has to be loud.
 *
 * Classification is platform-global work — trends are not owned by a tenant (ADR-0010) —
 * so it is metered against the reserved `platform` workspace rather than any client.
 */
async function classifyWithLlm(
  db: Db,
  trend: TrendWithRelations,
  taxonomy: { entries: TaxonomyEntry[] },
  bySlug: Map<string, TaxonomyEntry>,
  logger: ReturnType<typeof getLogger>,
): Promise<TrendCategoryMapping['evidence']> {
  try {
    const workspaceId = await getPlatformWorkspaceId(db);

    const result = await generateStructuredMetered(
      { db, workspaceId },
      {
        purpose: 'trend_summarize',
        schema: LlmClassificationSchema,
        schemaName: 'TrendCategoryClassification',
        temperature: 0,
        input: {
          trends: [
            `Trend: ${trend.title}`,
            trend.description ? `Description: ${trend.description}` : '',
            '',
            'Score this trend against the small-business categories below. Return only',
            'categories a business of that kind could plausibly post about this week.',
            'Use the exact slug. Score 0..1. Give a short concrete reason for each.',
            'Return nothing rather than guessing if none fit.',
            '',
            taxonomy.entries.map((e) => `${e.slug} — ${e.name}`).join('\n'),
          ]
            .filter(Boolean)
            .join('\n'),
        },
      },
    );

    return (
      result.data.categories
        // A model will happily invent a slug. Anything not in the taxonomy is dropped rather
        // than stored, because a score against a category that does not exist is unmappable
        // noise that would still count toward confidence.
        .filter((item) => bySlug.has(item.slug))
        .map((item) => ({
          categorySlug: item.slug,
          score: item.score,
          reason: item.reason,
        }))
    );
  } catch (error) {
    if (isBudgetExceededError(error)) throw error;

    logger.warn(
      { trendId: trend.id, error: error instanceof Error ? error.message : 'unknown' },
      'LLM category classification failed; falling back to rule matches only',
    );
    return [];
  }
}

/** Trends whose mapping a human still needs to look at. Drives the admin review queue. */
export function needsReview(raw: unknown): boolean {
  return readCategoryMapping(raw)?.reviewStatus === 'NEEDS_REVIEW';
}
