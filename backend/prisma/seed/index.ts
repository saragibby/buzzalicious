import type { Db } from '../../src/platform/db';
import { seedCategories } from './taxonomy';
import { seedTemplates } from './templates';
import { seedTrends } from './trends';
import { seedWorkspaces, WORKSPACES } from './workspaces';
import { seedHistory } from './history';
import { seedUsage } from './usage';

/**
 * The development seed.
 *
 * Treated as infrastructure rather than sample data: W3–W9 all build against it instead of
 * hand-rolling fixtures, so it has to be re-runnable, deterministic, and rich enough that
 * a feature which looks fine here is actually fine. Everything is written by `upsert` on a
 * derived primary key (see `deterministic.ts`), so running it twice converges rather than
 * duplicating.
 *
 * Order matters: globals first, then tenants, then the history that references both.
 */

export interface SeedSummary {
  categories: number;
  templates: number;
  trends: number;
  workspaces: number;
  posts: number;
  targets: number;
  metrics: number;
  clicks: number;
  generations: number;
  usageEvents: number;
}

export async function seedAll(db: Db, now: Date = new Date()): Promise<SeedSummary> {
  const summary: SeedSummary = {
    categories: await seedCategories(db),
    templates: await seedTemplates(db),
    trends: await seedTrends(db, now),
    workspaces: await seedWorkspaces(db, now),
    posts: 0,
    targets: 0,
    metrics: 0,
    clicks: 0,
    generations: 0,
    usageEvents: 0,
  };

  for (const workspace of WORKSPACES) {
    const history = await seedHistory(db, workspace, now);
    summary.posts += history.posts;
    summary.targets += history.targets;
    summary.metrics += history.metrics;
    summary.clicks += history.clicks;
    summary.generations += history.generations;
  }

  // Last: usage references the workspaces and brands above, and its self-check rebuild
  // needs every event already written.
  summary.usageEvents = (await seedUsage(db, now)).events;

  return summary;
}

export { WORKSPACES } from './workspaces';
export { TEMPLATES, assertTemplatesAreRenderable } from './templates';
export { CATEGORY_TREE } from './taxonomy';
export { TRENDS } from './trends';
