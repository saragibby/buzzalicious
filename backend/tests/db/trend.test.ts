import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TrendKind, TrendStatus } from '@prisma/client';
import { disconnectPrisma, getPrisma, type Db } from '../../src/platform/db';
import { seedAll } from '../../prisma/seed/index';
import { hasTestDatabase } from '../env';
import { recordManualObservation } from '../../src/modules/trend/collectors/manual.collector';
import { rescoreAll } from '../../src/modules/trend/scoring.service';
import { loadTaxonomy, mapTrend } from '../../src/modules/trend/mapping/mapping.service';
import { buildFeed, loadBrandContext } from '../../src/modules/trend/feed.service';
import { getTrend, mergeRaw } from '../../src/modules/trend/trend.repository';
import {
  readCategoryMapping,
  writeCategoryMapping,
  writeCuration,
} from '../../src/modules/trend/trend.schemas';

/**
 * The W9 acceptance criteria that can only be proved against real data.
 *
 * These run against the seeded taxonomy and the two sample brands, which sit in genuinely
 * different categories — hospitality and professional services — because "feeds differ by
 * category" is not a claim a fixture of my own construction can honestly support.
 */
describe.skipIf(!hasTestDatabase)('trend engine', () => {
  const SYNTHETIC_REF = 'w9-append-test';
  let db: Db;

  beforeAll(async () => {
    db = getPrisma();
    await seedAll(db);
  }, 120_000);

  afterAll(async () => {
    await disconnectPrisma();
  });

  /**
   * Make every seeded trend feedable: classified, and carrying an angle.
   *
   * Called per test rather than once, because these run against a database other files
   * also seed, and a `seedAll` from another file resets `raw`. A test whose outcome
   * depends on file ordering is not testing what it claims to.
   */
  async function prepareFeed(now: Date) {
    const taxonomy = await loadTaxonomy(db);

    for (const trend of await db.trend.findMany()) {
      const full = await getTrend(db, trend.id);
      await mapTrend(db, full!, taxonomy, now, { force: true });
      await mergeRaw(db, trend.id, (raw) =>
        writeCuration(raw, {
          defaultAngle: `Show what ${trend.title.toLowerCase()} looks like at your business, with one specific number.`,
          angles: [],
        }),
      );
    }

    await rescoreAll(db, now);
  }

  async function brandBySlugish(name: string) {
    const brand = await db.brand.findFirst({ where: { name: { contains: name } } });
    expect(brand, `expected a seeded brand matching "${name}"`).toBeTruthy();
    return brand!;
  }

  it('appends signals, advances lastSeenAt, and goes stale after a long silence', async () => {
    // One test, one lifetime. `trends` is a global table the seed treats as its own, so a
    // synthetic row left behind is visible to every other test file — it broke the seed's
    // idempotency check exactly that way. Creating and removing it inside a single test
    // means no other file can ever observe it.
    const base = {
      platform: null,
      kind: TrendKind.TOPIC,
      externalRef: SYNTHETIC_REF,
      title: 'Append-only observation test',
      exampleUrls: [],
      curatedBy: 'test@buzzalicious.test',
    };

    try {
      const first = await recordManualObservation(db, {
        ...base,
        observedAt: new Date('2026-02-01T00:00:00Z'),
        metrics: { volume: 1000 },
      });

      const second = await recordManualObservation(db, {
        ...base,
        observedAt: new Date('2026-02-08T00:00:00Z'),
        metrics: { volume: 4000 },
      });

      // Curating the same trend next week must add a data point, not replace one. Append
      // -only is what lets scoring be re-run over history when the algorithm changes, and
      // it will change.
      expect(second.id).toBe(first.id);

      const signals = await db.trendSignal.findMany({ where: { trendId: first.id } });
      expect(signals).toHaveLength(2);

      const volumes = signals
        .sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime())
        .map((s) => (s.metrics as { volume: number }).volume);
      expect(volumes).toEqual([1000, 4000]);

      // A signal whose trend still claims an older `lastSeenAt` would be scored as stale
      // while carrying fresh data, and drop out of the feed for a reason invisible in the
      // data.
      expect(second.lastSeenAt.toISOString()).toBe('2026-02-08T00:00:00.000Z');

      // Months later, with no further observation, it must not outrank a live trend.
      const results = await rescoreAll(db, new Date('2026-06-01T00:00:00Z'), { dryRun: true });
      expect(results.find((r) => r.trendId === first.id)?.after.status).toBe(TrendStatus.STALE);
    } finally {
      await db.trend.deleteMany({ where: { externalRef: SYNTHETIC_REF } });
    }
  }, 60_000);

  it('re-running scoring over the same history produces the same result', async () => {
    // The explicit acceptance criterion. Scoring is pure over stored signals, so a second
    // pass at the same instant must be a no-op — otherwise re-running the algorithm after
    // a change would be indistinguishable from the change itself.
    const now = new Date('2026-03-01T00:00:00Z');

    await rescoreAll(db, now);
    const first = await rescoreAll(db, now, { dryRun: true });

    expect(first.every((result) => !result.changed)).toBe(true);
  }, 60_000);

  it('caches a category mapping per trend, so it is computed once and not once per brand', async () => {
    const trend = await getTrend(db, (await db.trend.findFirstOrThrow()).id);
    const taxonomy = await loadTaxonomy(db);
    const now = new Date();

    const initial = await mapTrend(db, trend!, taxonomy, now);
    const repeat = await mapTrend(db, trend!, taxonomy, now);

    expect(initial.cached).toBe(false);
    expect(repeat.cached).toBe(true);
    // Trends are global per ADR-0010: adding a customer must not invalidate a mapping.
    expect(repeat.mapping.inputHash).toBe(initial.mapping.inputHash);
  });

  it('gives brands in different categories substantially different feeds', async () => {
    const now = new Date();
    await prepareFeed(now);

    const hospitality = await loadBrandContext(db, (await brandBySlugish('Rise')).id);
    const professional = await loadBrandContext(db, (await brandBySlugish('Dedux')).id);

    expect(hospitality.categorySlug).not.toBe(professional.categorySlug);

    const a = await buildFeed(db, hospitality, { now, limit: 20 });
    const b = await buildFeed(db, professional, { now, limit: 20 });

    // Guard against a vacuous pass: two empty feeds are trivially "different", and an
    // empty feed is the exact failure this test is supposed to catch.
    expect(a.length + b.length).toBeGreaterThan(0);

    const idsA = new Set(a.map((item) => item.trendId));
    const idsB = new Set(b.map((item) => item.trendId));
    const overlap = [...idsA].filter((id) => idsB.has(id));

    // Not disjoint — some trends genuinely apply to every small business — but a feed that
    // is identical across two unrelated industries is the generic tool this replaces.
    const union = new Set([...idsA, ...idsB]).size;
    expect(overlap.length / union).toBeLessThan(0.75);

    // And the separation is by category, not by luck: each feed's trends actually score
    // against the brand's own category.
    for (const item of [...a, ...b]) {
      expect(item.categoryScore).toBeGreaterThanOrEqual(0.35);
    }
  }, 120_000);

  it('never surfaces a trend without a concrete suggested angle', async () => {
    // The acceptance criterion that matters most: a trend with no usable idea attached is
    // noise, and removing the blank page is the entire point of the feature.
    const now = new Date();
    await prepareFeed(now);

    const brand = await loadBrandContext(db, (await brandBySlugish('Rise')).id);
    const items = await buildFeed(db, brand, { now, limit: 20 });
    expect(items.length).toBeGreaterThan(0);

    for (const item of items) {
      expect(item.suggestedAngle.length).toBeGreaterThan(20);
      expect(item.whyThisFitsYou.length).toBeGreaterThan(0);
    }
  });

  it('withholds a mapping flagged for review from the feed', async () => {
    const now = new Date();
    await prepareFeed(now);

    const brand = await loadBrandContext(db, (await brandBySlugish('Rise')).id);
    const before = await buildFeed(db, brand, { now, limit: 20 });
    expect(before.length).toBeGreaterThan(0);

    const target = before[0]!;
    const full = await getTrend(db, target.trendId);
    const mapping = readCategoryMapping(full!.raw)!;

    await mergeRaw(db, target.trendId, (raw) =>
      writeCategoryMapping(raw, { ...mapping, reviewStatus: 'NEEDS_REVIEW' }),
    );

    const after = await buildFeed(db, brand, { now, limit: 20 });

    // A confidently wrong mapping surfaces irrelevant trends and erodes trust faster than
    // a thin feed does, so an unsure mapping waits for a human instead of shipping.
    expect(after.map((item) => item.trendId)).not.toContain(target.trendId);
  });

  it('gives an uncategorised brand an empty feed rather than a generic one', async () => {
    const brand = await brandBySlugish('Rise');
    const original = brand.categoryId;

    await db.brand.update({ where: { id: brand.id }, data: { categoryId: null } });
    try {
      const context = await loadBrandContext(db, brand.id);
      expect(context.categoryId).toBeNull();
      expect(await buildFeed(db, context, { now: new Date(), limit: 20 })).toEqual([]);
    } finally {
      await db.brand.update({ where: { id: brand.id }, data: { categoryId: original } });
    }
  });

  it('keeps trends global, with no workspace column to scope them by', async () => {
    // ADR-0010: the pooling advantage depends on trends being shared. The per-brand feed
    // is a computed view, not a per-tenant table, and this is the cheapest way to notice
    // if that ever stops being true.
    const columns = await db.$queryRawUnsafe<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name IN ('trends', 'trend_signals', 'trend_category_scores', 'business_categories')`,
    );

    expect(columns.map((c) => c.column_name)).not.toContain('workspace_id');
  });
});
