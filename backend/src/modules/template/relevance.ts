/**
 * Which templates to offer a brand, ranked.
 *
 * The product differentiator is industry-specific relevance (docs/00), so the registry
 * cannot be an alphabetical list of everything. Ranking has three inputs:
 *
 * 1. **Direct category tags.** `TemplateCategoryTag.weight` is a hand-assigned 0..1 for
 *    v1, replaced by aggregate outcome data once the feedback loop has volume.
 * 2. **Parent-category inheritance.** A brand in "vacation-rental" should see templates
 *    tagged for "hospitality-and-travel" — just below the ones tagged for it specifically.
 *    Without this, a leaf category with three tagged templates shows three templates.
 * 3. **Archetype priors.** `BusinessCategory.priors` records which archetypes historically
 *    work for the category, which is the cold-start signal before any outcome data exists.
 *
 * Ranking happens in the database rather than in memory because the tag table is indexed
 * on `(categoryId, weight)` and the alternative is loading every template on every request.
 */

import type { AspectRatio, TemplateKind, TemplateStatus } from '@prisma/client';
import type { Db } from '../../platform/db';

/**
 * How much of its weight a tag keeps when inherited from a parent category.
 *
 * A directly-tagged template should always outrank an inherited one of equal weight, and
 * 0.6 is enough separation to guarantee that while still letting a strong parent tag
 * (1.0 → 0.6) beat a weak direct one (0.5). Tuned by eye; re-tune when there is outcome
 * data to tune against rather than guessing harder now.
 */
export const PARENT_WEIGHT_FACTOR = 0.6;

/**
 * How much a category's archetype prior can add to a template's score.
 *
 * `BusinessCategory.priors.archetypes` is a 0..1 weight per archetype, so the bonus is
 * that weight times this ceiling. Capped well below a direct tag: a prior is a belief
 * about a *kind* of template, and a tag is a statement about a specific one.
 */
export const PRIOR_BONUS = 0.25;

export interface RankedTemplate {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  archetype: string;
  kind: TemplateKind;
  supportedRatios: AspectRatio[];
  version: number;
  /** Combined relevance. Not normalised — only the ordering is meaningful. */
  score: number;
  /** Why it ranked where it did, so the UI can say "popular in your industry". */
  matchedCategoryId: string | null;
  inherited: boolean;
}

export interface RelevanceQuery {
  /** The brand's leaf category. Templates are ranked against it and its ancestors. */
  categoryId?: string;
  /** Restrict to templates supporting every listed ratio. */
  aspectRatios?: AspectRatio[];
  /**
   * Restrict to templates supporting *at least one* listed ratio.
   *
   * Distinct from `aspectRatios` on purpose. "Templates I could post to Threads" means
   * templates offering some ratio Threads accepts, not every one — requiring all of them
   * would drop any template that omits a single ratio, which is most of them.
   */
  anyAspectRatios?: AspectRatio[];
  archetype?: string;
  kind?: TemplateKind;
  status?: TemplateStatus;
  limit?: number;
}

interface ScoredRow {
  id: string;
  score: number;
  matchedCategoryId: string | null;
  inherited: boolean;
}

/** The category itself, then its ancestors, nearest first. */
async function ancestryOf(db: Db, categoryId: string): Promise<string[]> {
  const chain: string[] = [];
  let current: string | null = categoryId;

  // The taxonomy is two levels deep in v1 (~8 parents, ~56 leaves), but walking rather
  // than assuming depth means a third level does not silently stop being ranked.
  while (current && !chain.includes(current)) {
    chain.push(current);
    const parent: { parentId: string | null } | null = await db.businessCategory.findUnique({
      where: { id: current },
      select: { parentId: true },
    });
    current = parent?.parentId ?? null;
  }

  return chain;
}

/**
 * Rank templates for a brand's category.
 *
 * With no category the result is every matching template in a stable order, which is the
 * correct answer for a workspace that has not told us what it does yet — not an error.
 */
export async function rankTemplates(db: Db, query: RelevanceQuery): Promise<RankedTemplate[]> {
  const limit = query.limit ?? 50;

  const templates = await db.template.findMany({
    where: {
      status: query.status ?? 'PUBLISHED',
      ...(query.archetype ? { archetype: query.archetype } : {}),
      ...(query.kind ? { kind: query.kind } : {}),
      // Both filters live on one column, so they are merged rather than spread — two
      // spreads would silently drop whichever came first.
      ...(query.aspectRatios?.length || query.anyAspectRatios?.length
        ? {
            supportedRatios: {
              ...(query.aspectRatios?.length ? { hasEvery: query.aspectRatios } : {}),
              ...(query.anyAspectRatios?.length ? { hasSome: query.anyAspectRatios } : {}),
            },
          }
        : {}),
    },
    select: {
      id: true,
      slug: true,
      name: true,
      description: true,
      archetype: true,
      kind: true,
      supportedRatios: true,
      version: true,
    },
    orderBy: { slug: 'asc' },
  });

  if (templates.length === 0) return [];

  const scores = new Map<string, ScoredRow>();

  if (query.categoryId) {
    const ancestry = await ancestryOf(db, query.categoryId);

    const [tags, categories] = await Promise.all([
      db.templateCategoryTag.findMany({
        where: { categoryId: { in: ancestry }, templateId: { in: templates.map((t) => t.id) } },
        select: { templateId: true, categoryId: true, weight: true },
      }),
      db.businessCategory.findMany({
        where: { id: { in: ancestry } },
        select: { id: true, priors: true },
      }),
    ]);

    for (const tag of tags) {
      const depth = ancestry.indexOf(tag.categoryId);
      const inherited = depth > 0;
      // Each level of remove costs a constant factor, so a grandparent tag ranks below a
      // parent tag of the same weight.
      const score = tag.weight * PARENT_WEIGHT_FACTOR ** depth;
      const current = scores.get(tag.templateId);

      // A template tagged at several levels keeps its best match, not the sum. Summing
      // would reward broad tagging over accurate tagging.
      if (!current || score > current.score) {
        scores.set(tag.templateId, {
          id: tag.templateId,
          score,
          matchedCategoryId: tag.categoryId,
          inherited,
        });
      }
    }

    // The nearest ancestor with an opinion wins, so a leaf category's own priors are not
    // diluted by its parent's.
    const archetypeWeights = new Map<string, number>();
    for (const id of ancestry) {
      const priors = categories.find((category) => category.id === id)?.priors as {
        archetypes?: Record<string, number>;
      } | null;

      for (const [archetype, weight] of Object.entries(priors?.archetypes ?? {})) {
        if (!archetypeWeights.has(archetype)) archetypeWeights.set(archetype, weight);
      }
    }

    for (const template of templates) {
      const weight = archetypeWeights.get(template.archetype);
      if (weight === undefined) continue;

      const current = scores.get(template.id);
      scores.set(template.id, {
        id: template.id,
        score: (current?.score ?? 0) + weight * PRIOR_BONUS,
        matchedCategoryId: current?.matchedCategoryId ?? null,
        // A prior-only score is not a category match, so it is not "inherited" either.
        // `inherited` pairs with `matchedCategoryId` to let the UI say "popular in your
        // industry" honestly; claiming inheritance with nothing to point at would put
        // that label on a template the category never mentioned.
        inherited: current?.inherited ?? false,
      });
    }
  }

  return (
    templates
      .map((template) => {
        const scored = scores.get(template.id);
        return {
          ...template,
          score: scored?.score ?? 0,
          matchedCategoryId: scored?.matchedCategoryId ?? null,
          inherited: scored?.inherited ?? false,
        };
      })
      // Ties break on slug so the list is stable between requests. An unstable registry
      // makes "the template I used yesterday" unfindable.
      .sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug))
      .slice(0, limit)
  );
}
