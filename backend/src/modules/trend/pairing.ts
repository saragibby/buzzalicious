import { TemplateStatus, type AspectRatio, type TemplateKind } from '@prisma/client';
import type { Db } from '../../platform/db';

/**
 * Trend → template pairing (build order step 6).
 *
 * The point of pairing is that "this is trending" and "here is your post" are one click
 * apart. A trend with no way to act on it is the blank-page problem wearing a hat.
 *
 * This is a backend service, consumed by the feed. The composer route belongs to W5 and is
 * not touched here — W5 calls this the same way the feed does, so the pairing logic does
 * not have to be written twice or diverge between the two surfaces.
 *
 * Pairing is by **category overlap**: a template is tagged against categories in
 * `TemplateCategoryTag`, a trend is scored against the same taxonomy, so the shared
 * vocabulary does the work and neither side needs to know about the other.
 */

export interface PairedTemplate {
  id: string;
  slug: string;
  name: string;
  archetype: string;
  kind: TemplateKind;
  supportedRatios: AspectRatio[];
  /** 0..1. Category tag weight, blended with how strongly the trend hits that category. */
  fit: number;
  /** Which category drove the pairing, for the UI to show. */
  viaCategorySlug: string;
}

export interface PairingInput {
  /** The trend's category scores, strongest first. */
  trendCategoryScores: { categoryId: string; score: number }[];
  /** The brand's own category, weighted highest — the user has to be able to use this. */
  brandCategoryId: string | null;
  limit?: number;
}

/**
 * Finds templates worth pairing with a trend.
 *
 * Only `PUBLISHED` templates are considered. A draft template is one nobody has approved
 * for a real brand's feed, and surfacing it as "here is your post" would put unreviewed
 * output one click from publishing.
 */
export async function pairTemplates(db: Db, input: PairingInput): Promise<PairedTemplate[]> {
  const categoryIds = input.trendCategoryScores.map((s) => s.categoryId);
  if (categoryIds.length === 0) return [];

  const scoreByCategory = new Map(input.trendCategoryScores.map((s) => [s.categoryId, s.score]));

  const tags = await db.templateCategoryTag.findMany({
    where: {
      categoryId: { in: categoryIds },
      template: { status: TemplateStatus.PUBLISHED },
    },
    select: {
      weight: true,
      category: { select: { slug: true, id: true } },
      template: {
        select: {
          id: true,
          slug: true,
          name: true,
          archetype: true,
          kind: true,
          supportedRatios: true,
        },
      },
    },
  });

  const best = new Map<string, PairedTemplate>();

  for (const tag of tags) {
    const trendScore = scoreByCategory.get(tag.category.id) ?? 0;

    // Templates tagged to the brand's own category get a lift, because a template that
    // fits the trend but not the business produces a post the user cannot actually send.
    const brandBoost = input.brandCategoryId === tag.category.id ? 1.15 : 1;
    const fit = Math.min(1, tag.weight * trendScore * brandBoost);

    const existing = best.get(tag.template.id);
    if (existing && existing.fit >= fit) continue;

    best.set(tag.template.id, {
      ...tag.template,
      fit,
      viaCategorySlug: tag.category.slug,
    });
  }

  return [...best.values()].sort((a, b) => b.fit - a.fit).slice(0, input.limit ?? 3);
}
