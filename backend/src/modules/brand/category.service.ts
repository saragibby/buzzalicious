import type { BusinessCategory } from '@prisma/client';
import type { ScopedDb } from '../../platform/tenancy';

/**
 * The business category taxonomy.
 *
 * Global by ADR-0010 — the pooled signal across every workspace is what makes category
 * priors worth having — so nothing here is tenant-filtered. It still takes a `ScopedDb`,
 * because handing a route two different clients and asking it to pick the right one per
 * call is how an unscoped query eventually gets written.
 *
 * Two levels: a parent group ("Hospitality") and the leaves beneath it ("Vacation
 * rental"). A brand is assigned a leaf; the seed ships roughly 56 of them.
 */

export interface CategoryNode {
  id: string;
  slug: string;
  name: string;
  children: CategoryNode[];
}

export interface CategoryMatch {
  id: string;
  slug: string;
  name: string;
  /** The parent group, for disambiguating leaves whose names read alike out of context. */
  parentName: string | null;
}

function toNode(category: BusinessCategory, children: BusinessCategory[]): CategoryNode {
  return {
    id: category.id,
    slug: category.slug,
    name: category.name,
    children: children.map((child) => ({
      id: child.id,
      slug: child.slug,
      name: child.name,
      children: [],
    })),
  };
}

/**
 * The whole tree, in one query.
 *
 * ~56 leaves is small enough that paginating it would cost more in round trips than it
 * saves, and a picker that cannot show its options until it has fetched them twice feels
 * broken.
 */
export async function listCategoryTree(db: ScopedDb): Promise<CategoryNode[]> {
  const all = await db.businessCategory.findMany({ orderBy: { name: 'asc' } });

  const byParent = new Map<string, BusinessCategory[]>();
  for (const category of all) {
    if (!category.parentId) continue;
    const siblings = byParent.get(category.parentId) ?? [];
    siblings.push(category);
    byParent.set(category.parentId, siblings);
  }

  return all
    .filter((category) => category.parentId === null)
    .map((root) => toNode(root, byParent.get(root.id) ?? []));
}

/**
 * Search leaves by name.
 *
 * Leaves only: assigning a brand to "Hospitality" rather than "Vacation rental" throws
 * away exactly the specificity the category exists to provide, so a parent is not an
 * offerable answer.
 *
 * Case-insensitive `contains` rather than full-text search, because at this size the
 * index would be slower than the scan and would need maintaining.
 */
export async function searchCategories(
  db: ScopedDb,
  query: string,
  limit = 20,
): Promise<CategoryMatch[]> {
  const trimmed = query.trim();

  const matches = await db.businessCategory.findMany({
    where: {
      parentId: { not: null },
      ...(trimmed ? { name: { contains: trimmed, mode: 'insensitive' as const } } : {}),
    },
    include: { parent: true },
    orderBy: { name: 'asc' },
    take: Math.min(Math.max(limit, 1), 100),
  });

  return matches.map((category) => ({
    id: category.id,
    slug: category.slug,
    name: category.name,
    parentName: category.parent?.name ?? null,
  }));
}
