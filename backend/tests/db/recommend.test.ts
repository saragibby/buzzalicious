import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectPrisma, getPrisma, type Db } from '../../src/platform/db';
import { withTenantScope } from '../../src/platform/tenancy';
import {
  categoryAggregates,
  recommendationsFor,
} from '../../src/modules/recommend/recommend.service';
import { hasTestDatabase } from '../env';

/**
 * The demo that proves phase 1.
 *
 * docs/tasks/W8-feedback-loop.md asks for exactly one thing to be demonstrable: Rise &
 * Shore and Tax Dedux must receive **genuinely different** recommendations, and both must
 * differ from a cold-start brand. Everything else in the module is machinery in service of
 * that sentence, so it is asserted end to end against a real database rather than inferred
 * from the parts passing individually.
 *
 * The three brands are constructed to separate the two things that could produce a
 * difference. Rise & Shore and Tax Dedux share a category and differ **only** in their own
 * outcome history, so a difference between them can only come from the brand's own data.
 * The cold-start brand has no history at all and a different category, so its ordering can
 * only come from the seeded prior. If the loop were reading its own suggestions, or
 * ignoring brand history in favour of the prior, one of those two would collapse.
 */

const WINDOW = { from: new Date('2020-01-01'), to: new Date('2100-01-01') };
const NOW = new Date('2026-03-16T15:00:00Z');
const PUBLISHED_BASE = new Date('2026-01-05T15:00:00Z');

const ARCHETYPES = ['BEFORE_AFTER', 'TIP', 'BTS', 'LISTICLE'] as const;
type Archetype = (typeof ARCHETYPES)[number];

describe.skipIf(!hasTestDatabase)('phase 1 demo: three brands, three answers', () => {
  let db: Db;
  const workspaceIds: string[] = [];
  const templateIds: string[] = [];
  const categoryIds: string[] = [];
  const templates: Record<string, string> = {};

  interface Brand {
    workspaceId: string;
    brandId: string;
  }

  /**
   * A brand with a history: `weeks` weeks of posting, `perWeek` posts a week, cycling
   * through the archetypes, with `clicks` deciding how each archetype performs.
   *
   * Every post is `USER`-sourced. Contamination has its own dedicated test below; mixing
   * it in here would mean a failure could not distinguish "history is ignored" from
   * "exploration posts leaked into preference".
   */
  async function makeBrand(
    name: string,
    categoryId: string,
    clicks: Record<Archetype, number> | null,
    options: { weeks?: number; perWeek?: number } = {},
  ): Promise<Brand> {
    const workspaceId = randomUUID();
    const brandId = randomUUID();

    await db.workspace.create({
      data: { id: workspaceId, slug: `w8-${workspaceId.slice(0, 8)}`, name },
    });
    workspaceIds.push(workspaceId);

    await db.brand.create({
      data: {
        id: brandId,
        workspaceId,
        categoryId,
        name,
        slug: `w8b-${brandId.slice(0, 8)}`,
        timezone: 'America/New_York',
        palette: {},
        typography: {},
        voiceGuide: {},
      },
    });

    if (clicks) {
      const weeks = options.weeks ?? 8;
      const perWeek = options.perWeek ?? 3;
      let n = 0;
      for (let week = 0; week < weeks; week += 1) {
        for (let slot = 0; slot < perWeek; slot += 1) {
          const archetype = ARCHETYPES[n % ARCHETYPES.length]!;
          n += 1;
          const publishedAt = new Date(
            PUBLISHED_BASE.getTime() + week * 7 * 86_400_000 + slot * 86_400_000,
          );

          const post = await db.post.create({
            data: {
              brandId,
              title: `${name} ${archetype} ${n}`,
              status: 'PUBLISHED',
              templateId: templates[archetype]!,
              scheduleSource: 'USER',
            },
          });
          const target = await db.postTarget.create({
            data: { postId: post.id, platform: 'INSTAGRAM', status: 'PUBLISHED', publishedAt },
          });
          const value = clicks[archetype];
          await db.postMetric.create({
            data: {
              postTargetId: target.id,
              source: 'test',
              capturedAt: new Date(publishedAt.getTime() + 86_400_000),
              impressions: 1000,
              linkClicks: value,
              likes: value,
              saves: value,
              shares: value,
              comments: value,
            },
          });
        }
      }
    }

    return { workspaceId, brandId };
  }

  let riseAndShore: Brand;
  let taxDedux: Brand;
  let coldStart: Brand;
  let rentalsCategoryId: string;

  beforeAll(async () => {
    db = getPrisma();

    for (const archetype of ARCHETYPES) {
      const template = await db.template.create({
        data: {
          name: `${archetype} template`,
          slug: `w8t-${randomUUID().slice(0, 8)}`,
          archetype,
          status: 'PUBLISHED',
          slotSchema: {},
          layout: {},
          supportedRatios: [],
        },
      });
      templates[archetype] = template.id;
      templateIds.push(template.id);
    }

    const rentals = await db.businessCategory.create({
      data: {
        slug: `w8-rentals-${randomUUID().slice(0, 8)}`,
        name: 'vacation rentals',
        priors: { archetypes: { BEFORE_AFTER: 0.6, TIP: 0.5, BTS: 0.5, LISTICLE: 0.5 } },
      },
    });
    // A deliberately different seed. The cold-start brand's ordering has nowhere else to
    // come from, so if this were the same seed the test could not tell a working prior
    // from a stable sort over identical scores.
    const taxes = await db.businessCategory.create({
      data: {
        slug: `w8-taxes-${randomUUID().slice(0, 8)}`,
        name: 'tax services',
        priors: { archetypes: { LISTICLE: 0.9, TIP: 0.7, BTS: 0.4, BEFORE_AFTER: 0.3 } },
      },
    });
    categoryIds.push(rentals.id, taxes.id);
    rentalsCategoryId = rentals.id;

    // Same category, so nothing but their own history can separate them.
    riseAndShore = await makeBrand('Rise and Shore', rentals.id, {
      BEFORE_AFTER: 40,
      TIP: 10,
      BTS: 10,
      LISTICLE: 10,
    });
    taxDedux = await makeBrand('Tax Dedux', rentals.id, {
      BEFORE_AFTER: 10,
      TIP: 10,
      BTS: 10,
      LISTICLE: 40,
    });
    // No posts at all, and a category whose seed disagrees with both of the above.
    coldStart = await makeBrand('Cold Start', taxes.id, null);
  }, 120_000);

  afterAll(async () => {
    for (const id of workspaceIds) {
      await db.workspace.delete({ where: { id } }).catch(() => undefined);
    }
    // Templates and categories are platform-global, so the workspace cascade does not
    // reach them. Left behind they pollute every other file's unfiltered reads.
    for (const id of templateIds) {
      await db.template.delete({ where: { id } }).catch(() => undefined);
    }
    for (const id of categoryIds) {
      await db.businessCategory.delete({ where: { id } }).catch(() => undefined);
    }
    await disconnectPrisma();
  });

  const recommend = (brand: Brand) =>
    recommendationsFor(
      withTenantScope(db, {
        kind: 'brand',
        workspaceId: brand.workspaceId,
        brandId: brand.brandId,
      }),
      {
        brandId: brand.brandId,
        window: WINDOW,
        now: NOW,
        count: 4,
      },
    );

  const exploitOrder = (result: Awaited<ReturnType<typeof recommend>>) =>
    result.archetypes.filter((a) => a.selection === 'exploit').map((a) => a.archetype);

  it('gives Rise and Shore and Tax Dedux genuinely different recommendations', async () => {
    const rise = await recommend(riseAndShore);
    const tax = await recommend(taxDedux);

    expect(exploitOrder(rise)[0]).toBe('BEFORE_AFTER');
    expect(exploitOrder(tax)[0]).toBe('LISTICLE');
    expect(exploitOrder(rise)).not.toEqual(exploitOrder(tax));
  });

  it('gives the cold-start brand a different answer again, from its category seed', async () => {
    const cold = await recommend(coldStart);
    const rise = await recommend(riseAndShore);

    expect(exploitOrder(cold)[0]).toBe('LISTICLE');
    expect(exploitOrder(cold)).not.toEqual(exploitOrder(rise));
    // Ranked on the seed, but with nothing of its own behind it. This is the distinction
    // the whole module is built around: a real number, and not a measurement.
    for (const recommendation of cold.archetypes) {
      expect(recommendation.score.basis.observations).toBe(0);
      expect(recommendation.score.basis.observed).toBeNull();
    }
  });

  it('never makes a brand-specific claim for a brand with no history', async () => {
    const cold = await recommend(coldStart);

    expect(cold.archetypes.map((a) => a.explanation.kind)).not.toContain('brand-claim');
    // The positive control: it says *something*, and it is about the category. A cold start
    // that fell through to no-claim everywhere would pass the assertion above and would be
    // the "empty, not defensible" failure the brief names.
    expect(cold.archetypes.map((a) => a.explanation.kind)).toContain('category-claim');
    expect(cold.archetypes.every((a) => a.explanation.untried)).toBe(true);
  });

  it('does make a brand-specific claim once the brand has earned one', async () => {
    const rise = await recommend(riseAndShore);
    const claims = rise.archetypes.filter((a) => a.explanation.kind === 'brand-claim');

    expect(claims.length).toBeGreaterThan(0);
    expect(claims[0]?.archetype).toBe('BEFORE_AFTER');
    expect(claims[0]?.explanation.multiplier ?? 0).toBeGreaterThan(1.2);
  });

  it('reserves an exploration slot for every brand, history or not', async () => {
    for (const brand of [riseAndShore, taxDedux, coldStart]) {
      const result = await recommend(brand);
      expect(result.archetypes.filter((a) => a.selection === 'explore').length).toBeGreaterThan(0);
    }
  });

  it('suggests a send time and a cadence for a brand with history', async () => {
    const rise = await recommend(riseAndShore);

    expect(rise.sendTime.suggested).not.toBeNull();
    expect(rise.sendTime.suggested?.local).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    // Suggested times are in the future, which is the only property a scheduler needs and
    // the one a UTC/local mixup breaks.
    expect(rise.sendTime.suggested!.instant.getTime()).toBeGreaterThanOrEqual(NOW.getTime());
    expect(rise.cadence.currentPerWeek).toBe(3);
  });

  it('still suggests a defensible send time for a brand with no history', async () => {
    const cold = await recommend(coldStart);

    expect(cold.sendTime.suggested).not.toBeNull();
    expect(cold.sendTime.suggestedSlot).not.toBeNull();
    // Advisory only, and honest about having nothing: cadence must not invent a range.
    expect(cold.cadence.suggested).toBeNull();
  });

  it('builds a category prior from other brands, excluding the brand itself', async () => {
    // Rise & Shore and Tax Dedux share the rentals category and disagree completely, so
    // each one's prior is the *other's* history. Including the brand's own posts would make
    // the prior agree with the brand by construction and `k` a no-op.
    const forRise = await categoryAggregates(db, rentalsCategoryId, WINDOW, riseAndShore.brandId);
    const forTax = await categoryAggregates(db, rentalsCategoryId, WINDOW, taxDedux.brandId);

    expect(forRise['LISTICLE']?.mean ?? 0).toBeGreaterThan(forRise['BEFORE_AFTER']?.mean ?? 0);
    expect(forTax['BEFORE_AFTER']?.mean ?? 0).toBeGreaterThan(forTax['LISTICLE']?.mean ?? 0);
    // One brand each side, counted as brands rather than as posts.
    expect(forRise['LISTICLE']?.observations).toBe(1);
  });
});
