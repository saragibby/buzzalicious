import { Platform, TrendStatus, type Trend, type TrendKind } from '@prisma/client';
import type { Db } from '../../platform/db';
import { NotFoundError } from '../../platform/errors';
import { isFeedable } from './scoring';
import { pairTemplates, type PairedTemplate } from './pairing';
import { usedTrendIds } from './trend.repository';
import { readCategoryMapping, readCuration } from './trend.schemas';

/**
 * The per-brand trend feed.
 *
 * ADR-0010 makes `Trend`, `TrendSignal` and `TrendCategoryScore` global — no tenant
 * column, deliberately shared, because pooling observations across tenants is the
 * advantage. So this is a **scoped view** over global rows, computed from the brand's
 * category. There is no per-tenant trend table and there should not be one; what differs
 * between two customers is relevance, not the underlying observation.
 *
 * ```
 * feedScore = momentum × categoryScore × platformFit × freshness
 * ```
 *
 * Every factor is 0..1 and interpretable on its own, so a surprising ranking can be
 * explained by pointing at the term responsible rather than at "the algorithm".
 */

/** A trend must be at least this relevant to a brand's category to be worth their week. */
export const MIN_CATEGORY_SCORE = 0.35;

export interface FeedItem {
  trendId: string;
  title: string;
  description: string | null;
  kind: TrendKind;
  platform: Platform | null;
  status: TrendStatus;
  momentum: number;
  velocity: number;
  lastSeenAt: Date;
  exampleUrls: string[];

  feedScore: number;
  categoryScore: number;
  platformFit: number;
  freshness: number;

  /** Why this brand is being shown this trend, in plain language. */
  whyThisFitsYou: string;
  /** What they could actually post. The acceptance criterion the brief singles out. */
  suggestedAngle: string;
  /** Optional opening line. The angle is the idea; this is the execution. */
  hook?: string;
  pairedTemplates: PairedTemplate[];
}

export interface FeedOptions {
  limit?: number;
  now: Date;
}

export interface BrandFeedContext {
  brandId: string;
  brandName: string;
  categoryId: string | null;
  categorySlug: string | null;
  categoryName: string | null;
  targetPlatforms: Platform[];
}

/**
 * Loads the brand facts the feed needs.
 *
 * Soft-deleted brands are excluded — every read path filters `deletedAt: null` per the
 * schema's own note, and a deleted brand's feed is not a thing that should exist.
 */
export async function loadBrandContext(db: Db, brandId: string): Promise<BrandFeedContext> {
  const brand = await db.brand.findFirst({
    where: { id: brandId, deletedAt: null },
    select: {
      id: true,
      name: true,
      targetPlatforms: true,
      category: { select: { id: true, slug: true, name: true } },
    },
  });

  if (!brand) throw new NotFoundError('Brand');

  return {
    brandId: brand.id,
    brandName: brand.name,
    categoryId: brand.category?.id ?? null,
    categorySlug: brand.category?.slug ?? null,
    categoryName: brand.category?.name ?? null,
    targetPlatforms: brand.targetPlatforms,
  };
}

interface FeedCandidate extends Trend {
  categoryScores: { categoryId: string; score: number }[];
}

/**
 * Builds the feed for one brand.
 *
 * A brand with no category gets an empty feed rather than a generic one. That is the whole
 * thesis of docs/07: this is not a general trend feed, and showing an uncategorised brand
 * "what's popular" would be exactly the commoditised product we chose not to build. The
 * honest answer is to ask them to pick a category.
 */
export async function buildFeed(
  db: Db,
  brand: BrandFeedContext,
  options: FeedOptions,
): Promise<FeedItem[]> {
  if (!brand.categoryId) return [];

  const candidates: FeedCandidate[] = await db.trend.findMany({
    where: {
      status: { in: [TrendStatus.EMERGING, TrendStatus.PEAKING] },
      categoryScores: {
        some: { categoryId: brand.categoryId, score: { gte: MIN_CATEGORY_SCORE } },
      },
    },
    include: { categoryScores: { select: { categoryId: true, score: true } } },
    orderBy: { momentum: 'desc' },
    take: 200,
  });

  const alreadyUsed = await usedTrendIds(db, brand.brandId);
  const items: FeedItem[] = [];

  for (const trend of candidates) {
    // Belt and braces against a stale stored status: the status column is written by a
    // scoring run, and a feed that trusts it blindly shows declining trends whenever a
    // run is overdue.
    if (!isFeedable(trend.status)) continue;
    if (alreadyUsed.has(trend.id)) continue;

    const mapping = readCategoryMapping(trend.raw);

    // Withheld until a human confirms it. A confidently wrong mapping surfaces irrelevant
    // trends and erodes trust faster than a thin feed does (docs/07 risk table).
    if (mapping?.reviewStatus === 'NEEDS_REVIEW' || mapping?.reviewStatus === 'REJECTED') continue;

    const categoryScore =
      trend.categoryScores.find((s) => s.categoryId === brand.categoryId)?.score ?? 0;
    if (categoryScore < MIN_CATEGORY_SCORE) continue;

    const angle = resolveAngle(trend, brand.categorySlug);

    // No angle, no feed entry. "Every surfaced trend carries a concrete suggested angle"
    // is an acceptance criterion, and a trend without a usable idea attached is just
    // noise — which is precisely what the feature exists to remove.
    if (!angle) continue;

    const platformFit = platformFitFor(trend.platform, brand.targetPlatforms);
    if (platformFit === 0) continue;

    const freshness = freshnessOf(trend.lastSeenAt, options.now);
    const momentum = trend.momentum ?? 0;
    const feedScore = momentum * categoryScore * platformFit * freshness;

    items.push({
      trendId: trend.id,
      title: trend.title,
      description: trend.description,
      kind: trend.kind,
      platform: trend.platform,
      status: trend.status,
      momentum,
      velocity: trend.velocity ?? 0,
      lastSeenAt: trend.lastSeenAt,
      exampleUrls: trend.exampleUrls,
      feedScore,
      categoryScore,
      platformFit,
      freshness,
      whyThisFitsYou: explain({
        trend,
        brand,
        categoryScore,
        reason: mapping?.evidence.find((e) => e.categorySlug === brand.categorySlug)?.reason,
      }),
      suggestedAngle: angle.angle,
      ...(angle.hook ? { hook: angle.hook } : {}),
      pairedTemplates: await pairTemplates(db, {
        trendCategoryScores: trend.categoryScores,
        brandCategoryId: brand.categoryId,
      }),
    });
  }

  return items.sort((a, b) => b.feedScore - a.feedScore).slice(0, options.limit ?? 20);
}

/**
 * The angle for this brand's category, falling back to the trend's default.
 *
 * Curated per category rather than generated per request: a human-written angle for
 * "vacation rental" is both better and free, and generating one per brand would be an
 * LLM call on every feed load for an answer that is identical across every tenant in the
 * same category.
 */
function resolveAngle(
  trend: Trend,
  categorySlug: string | null,
): { angle: string; hook?: string } | null {
  const curation = readCuration(trend.raw);
  if (!curation) return null;

  const specific = categorySlug
    ? curation.angles.find((a) => a.categorySlug === categorySlug)
    : undefined;

  if (specific) return { angle: specific.angle, ...(specific.hook ? { hook: specific.hook } : {}) };
  if (curation.defaultAngle) return { angle: curation.defaultAngle };
  return null;
}

/**
 * Whether a trend is usable on the platforms this brand actually posts to.
 *
 * A trend with no platform is cross-platform and fits everyone. A platform-specific trend
 * the brand does not post on scores zero and is filtered out entirely — there is no point
 * telling a business about a format they have no account for.
 */
export function platformFitFor(
  trendPlatform: Platform | null,
  targetPlatforms: Platform[],
): number {
  if (trendPlatform === null) return 0.9;
  if (targetPlatforms.length === 0) return 0.5;
  return targetPlatforms.includes(trendPlatform) ? 1 : 0;
}

/** How current the observation is. Halves roughly weekly; floors rather than hitting zero. */
export function freshnessOf(lastSeenAt: Date, now: Date): number {
  const days = Math.max((now.getTime() - lastSeenAt.getTime()) / (24 * 60 * 60 * 1000), 0);
  return Math.max(0.1, Math.exp(-days / 7));
}

interface ExplainInput {
  trend: Trend;
  brand: BrandFeedContext;
  categoryScore: number;
  reason?: string;
}

/**
 * "Why this fits you", built deterministically from the mapping evidence.
 *
 * No model call at request time. The facts that justify the recommendation — the category,
 * the terms that matched, the direction of travel — are already computed and stored, so
 * assembling them is free, instant, identical on every load, and cannot hallucinate a
 * reason the data does not support.
 */
export function explain({ trend, brand, categoryScore, reason }: ExplainInput): string {
  const parts: string[] = [];
  const category = brand.categoryName ?? 'your category';

  parts.push(categoryScore >= 0.8 ? `Strongly relevant to ${category}` : `Relevant to ${category}`);

  if (reason) parts.push(reason);

  if (trend.status === TrendStatus.EMERGING) {
    // The differentiator, stated plainly: being early is the value, not being popular.
    parts.push('still emerging, so you would be early rather than late');
  } else {
    parts.push('peaking now, so this week is the window');
  }

  if (trend.platform && brand.targetPlatforms.includes(trend.platform)) {
    parts.push(`seen on ${platformLabel(trend.platform)}, which you post to`);
  }

  return `${parts.join(' · ')}.`;
}

function platformLabel(platform: Platform): string {
  const labels: Record<Platform, string> = {
    INSTAGRAM: 'Instagram',
    FACEBOOK: 'Facebook',
    THREADS: 'Threads',
    X: 'X',
    LINKEDIN: 'LinkedIn',
    TIKTOK: 'TikTok',
    YOUTUBE: 'YouTube',
  };
  return labels[platform];
}
