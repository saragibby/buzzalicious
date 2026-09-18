import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectPrisma, getPrisma, type Db } from '../../src/platform/db';
import { withTenantScope } from '../../src/platform/tenancy';
import {
  clicksByDay,
  clicksByShortLink,
  rollUpByPlatform,
  rollUpByPost,
  rollUpByTemplate,
  rollUpByTrend,
} from '../../src/modules/link/rollup.service';
import { hasTestDatabase } from '../env';

/**
 * Click rollups against a real database.
 *
 * Tenancy here is asserted on **identity**, with the other tenant's rows genuinely
 * present and a positive control proving the query returns anything at all. A count
 * assertion would pass under the bug it is meant to catch: a broken `ScopeRule` yields
 * `{}`, which is *no filter* rather than a deny, so a leak returns MORE rows — and
 * "expected 2" fails only by luck of how many rows the other tenant happens to have.
 *
 * `LinkClick` reaches its tenant through `shortLink`, and `ShortLink.postId` and
 * `.platform` are both nullable, so every fixture shape that relation can take is built:
 * a link with a post and platform, a brand-level link with neither, and a post whose
 * template and trend have been deleted out from under it.
 */

const WINDOW = { from: new Date('2020-01-01'), to: new Date('2100-01-01') };

describe.skipIf(!hasTestDatabase)('click rollups', () => {
  let db: Db;
  const workspaceIds: string[] = [];
  // Templates and trends are platform-global (no workspaceId), so the workspace cascade
  // does NOT reach them. Left behind they pollute every other file's unfiltered reads —
  // which is exactly how this file first broke tests/db/trend.test.ts.
  const templateIds: string[] = [];
  const trendIds: string[] = [];

  interface Fixture {
    workspaceId: string;
    brandId: string;
    postId: string;
    templateId: string;
    trendId: string;
    slugs: Record<string, string>;
  }

  async function makeTenant(name: string, clicks: Record<string, number>): Promise<Fixture> {
    const workspaceId = randomUUID();
    const brandId = randomUUID();

    await db.workspace.create({
      data: { id: workspaceId, slug: `roll-${workspaceId.slice(0, 8)}`, name },
    });
    workspaceIds.push(workspaceId);

    await db.brand.create({
      data: {
        id: brandId,
        workspaceId,
        name,
        slug: `rb-${brandId.slice(0, 8)}`,
        palette: {},
        typography: {},
        voiceGuide: {},
      },
    });

    const template = await db.template.create({
      data: {
        name: `${name} template`,
        slug: `rt-${randomUUID().slice(0, 8)}`,
        archetype: 'promo',
        status: 'PUBLISHED',
        slotSchema: {},
        layout: {},
        supportedRatios: [],
      },
    });

    const trend = await db.trend.create({
      data: {
        title: `${name} trend`,
        kind: 'TOPIC',
        status: 'EMERGING',
      },
    });

    templateIds.push(template.id);
    trendIds.push(trend.id);

    const post = await db.post.create({
      data: {
        brandId,
        title: `${name} post`,
        status: 'PUBLISHED',
        templateId: template.id,
        trendId: trend.id,
      },
    });

    const slugs: Record<string, string> = {};

    // Shape 1: a post + platform link on a platform that carries caption links.
    // Shape 2: the same post on Instagram, which cannot — must read as unmeasurable.
    // Shape 3: a brand-level link with a null post AND null platform.
    const shapes: Array<{ key: string; postId: string | null; platform: 'X' | 'INSTAGRAM' | null }> =
      [
        { key: 'x', postId: post.id, platform: 'X' },
        { key: 'instagram', postId: post.id, platform: 'INSTAGRAM' },
        { key: 'bare', postId: null, platform: null },
      ];

    for (const shape of shapes) {
      const slug = `${name.slice(0, 2)}${randomUUID().replace(/-/g, '').slice(0, 5)}`;
      const link = await db.shortLink.create({
        data: {
          slug,
          brandId,
          postId: shape.postId,
          platform: shape.platform,
          destinationUrl: 'https://example.test/',
        },
      });
      slugs[shape.key] = slug;

      const human = clicks[shape.key] ?? 0;
      for (let i = 0; i < human; i += 1) {
        await db.linkClick.create({ data: { shortLinkId: link.id, isBot: false } });
      }
      // One bot click on every link, always. A rollup that forgot to exclude bots would
      // report inflated-but-plausible numbers, which is the failure mode that survives
      // review; a constant makes the inflation exact and therefore assertable.
      await db.linkClick.create({
        data: { shortLinkId: link.id, isBot: true, botReason: 'ua-crawler' },
      });
    }

    return { workspaceId, brandId, postId: post.id, templateId: template.id, trendId: trend.id, slugs };
  }

  let mine: Fixture;
  let theirs: Fixture;

  beforeAll(async () => {
    db = getPrisma();
    mine = await makeTenant('Mine', { x: 5, instagram: 3, bare: 2 });
    theirs = await makeTenant('Theirs', { x: 99, instagram: 99, bare: 99 });
  });

  afterAll(async () => {
    // Workspaces first: posts cascade with them, releasing the SetNull references.
    for (const id of workspaceIds) {
      await db.workspace.deleteMany({ where: { id } });
    }
    await db.template.deleteMany({ where: { id: { in: templateIds } } });
    await db.trend.deleteMany({ where: { id: { in: trendIds } } });
    await disconnectPrisma();
  });

  function scoped(fixture: Fixture) {
    return withTenantScope(db, {
      kind: 'brand',
      workspaceId: fixture.workspaceId,
      brandId: fixture.brandId,
    });
  }

  describe('tenancy', () => {
    it('returns only this brand\u2019s links, with the other tenant present', async () => {
      const rows = await clicksByShortLink(scoped(mine), WINDOW);
      const slugs = rows.map((row) => row.slug);

      // Positive control: the query returns something, so the negative assertions below
      // are about filtering rather than about an empty result.
      expect(slugs).toContain(mine.slugs.x);
      expect(slugs).toContain(mine.slugs.bare);

      // The other tenant genuinely exists and is genuinely excluded.
      expect(slugs).not.toContain(theirs.slugs.x);
      expect(slugs).not.toContain(theirs.slugs.bare);
    });

    it('does not leak the other tenant\u2019s clicks into a group total', async () => {
      const rows = await clicksByShortLink(scoped(mine), WINDOW);
      const byPost = rollUpByPost(rows);

      const post = byPost.find((group) => group.key === mine.postId);
      expect(post).toBeDefined();
      // 5 from X. Instagram's 3 are unmeasurable and must not be added in.
      expect(post!.clicks).toBe(5);

      expect(byPost.map((g) => g.key)).not.toContain(theirs.postId);
    });
  });

  describe('bot exclusion', () => {
    it('counts bots separately instead of into the total', async () => {
      const rows = await clicksByShortLink(scoped(mine), WINDOW);
      const x = rows.find((row) => row.slug === mine.slugs.x)!;

      expect(x.clicks).toBe(5);
      expect(x.botClicks).toBe(1);
    });

    it('would report a different number if bots were counted as clicks', async () => {
      const rows = await clicksByShortLink(scoped(mine), WINDOW);
      const total = rows.reduce((sum, row) => sum + (row.clicks ?? 0), 0);
      const bots = rows.reduce((sum, row) => sum + row.botClicks, 0);

      // X 5 + bare 2. Instagram contributes nothing because it cannot be measured.
      expect(total).toBe(7);
      // Three bot clicks exist and are excluded — so the assertion above is load-bearing
      // rather than coincidentally equal to the unfiltered number.
      expect(bots).toBe(3);
    });
  });

  describe('a zero is a lie', () => {
    it('reports Instagram clicks as unavailable, never as zero', async () => {
      const rows = await clicksByShortLink(scoped(mine), WINDOW);
      const ig = rows.find((row) => row.slug === mine.slugs.instagram)!;

      expect(ig.available).toBe(false);
      expect(ig.clicks).toBeNull();
      // Specifically not 0 — the recommender would read 0 as "published and ignored".
      expect(ig.clicks).not.toBe(0);
    });

    it('keeps unmeasurable links out of the average rather than dragging it down', async () => {
      const rows = await clicksByShortLink(scoped(mine), WINDOW);
      const byPost = rollUpByPost(rows);
      const post = byPost.find((group) => group.key === mine.postId)!;

      // One measurable link (X) and one that is not (Instagram). A caller dividing
      // clicks by `measured` gets 5; dividing by the number of links would get 2.5 and
      // report the post as half as effective as it was.
      expect(post.measured).toBe(1);
      expect(post.unmeasured).toBe(1);
    });

    it('survives the aggregate layer, where SUM would swallow the null', async () => {
      const rows = await clicksByShortLink(scoped(mine), WINDOW);
      const byPlatform = rollUpByPlatform(rows);

      const instagram = byPlatform.find((group) => group.key === 'INSTAGRAM');
      expect(instagram).toBeDefined();
      expect(instagram!.measured).toBe(0);
      expect(instagram!.unmeasured).toBe(1);

      const x = byPlatform.find((group) => group.key === 'X')!;
      expect(x.clicks).toBe(5);
      expect(x.measured).toBe(1);
    });
  });

  describe('nullable relation shapes', () => {
    it('excludes a brand-level link from per-post and per-platform rollups', async () => {
      const rows = await clicksByShortLink(scoped(mine), WINDOW);

      // The row itself exists and is measurable — it is a real link somebody can click.
      const bare = rows.find((row) => row.slug === mine.slugs.bare)!;
      expect(bare.clicks).toBe(2);
      expect(bare.available).toBe(true);

      // But it belongs to no post and no platform, so it must not invent a bucket.
      const byPost = rollUpByPost(rows);
      expect(byPost).toHaveLength(1);
      expect(byPost[0]!.key).toBe(mine.postId);

      const platforms = rollUpByPlatform(rows).map((group) => group.key);
      expect(platforms).toContain('X');
      expect(platforms).toContain('INSTAGRAM');
      expect(platforms).not.toContain(null);
    });

    it('drops a post whose template was deleted rather than bucketing it under null', async () => {
      const rows = await clicksByShortLink(scoped(mine), WINDOW);

      const before = await rollUpByTemplate(scoped(mine), rows);
      expect(before.map((group) => group.key)).toContain(mine.templateId);

      // SetNull on delete: the post outlives its template.
      await db.template.delete({ where: { id: mine.templateId } });

      const after = await rollUpByTemplate(scoped(mine), rows);
      expect(after.map((group) => group.key)).not.toContain(mine.templateId);
      // And no phantom group that silently aggregates every orphaned post together.
      expect(after.map((group) => group.key)).not.toContain(undefined);
      expect(after).toHaveLength(0);
    });

    it('rolls up by trend while the trend still exists', async () => {
      const rows = await clicksByShortLink(scoped(mine), WINDOW);
      const byTrend = await rollUpByTrend(scoped(mine), rows);

      const trend = byTrend.find((group) => group.key === mine.trendId);
      expect(trend).toBeDefined();
      expect(trend!.clicks).toBe(5);
      expect(byTrend.map((group) => group.key)).not.toContain(theirs.trendId);
    });
  });

  describe('time buckets', () => {
    it('buckets in the brand\u2019s zone, not UTC', async () => {
      const link = await db.shortLink.findFirst({ where: { slug: mine.slugs.x } });

      // 02:30 UTC on the 2nd is still the evening of the 1st in Denver. A UTC bucket
      // would file this under the wrong day, which is precisely the kind of quiet shift
      // that makes a best-time-to-post signal wrong.
      await db.linkClick.create({
        data: {
          shortLinkId: link!.id,
          isBot: false,
          occurredAt: new Date('2024-03-02T02:30:00Z'),
        },
      });

      const denver = await clicksByDay(
        scoped(mine),
        { from: new Date('2024-03-01'), to: new Date('2024-03-03') },
        'America/Denver',
      );
      expect(denver.map((d) => d.day)).toContain('2024-03-01');
      expect(denver.map((d) => d.day)).not.toContain('2024-03-02');

      const utc = await clicksByDay(
        scoped(mine),
        { from: new Date('2024-03-01'), to: new Date('2024-03-03') },
        'UTC',
      );
      // Positive control that the zone argument is what moved the bucket, rather than
      // the window happening to exclude one of the days.
      expect(utc.map((d) => d.day)).toContain('2024-03-02');
    });

    /**
     * `clicksByDay` reads `LinkClick` directly rather than through `ShortLink`, so it
     * leans on a different tenancy rule than every other query in this file — and a
     * mutation emptying that rule survived the original version of these tests, because
     * nothing here asserted on a day that belongs to somebody else.
     */
    it('excludes another tenant\u2019s clicks from the day buckets', async () => {
      const theirLink = await db.shortLink.findFirst({ where: { slug: theirs.slugs.x } });
      await db.linkClick.create({
        data: {
          shortLinkId: theirLink!.id,
          isBot: false,
          occurredAt: new Date('1999-05-05T12:00:00Z'),
        },
      });

      const mineLink = await db.shortLink.findFirst({ where: { slug: mine.slugs.x } });
      await db.linkClick.create({
        data: {
          shortLinkId: mineLink!.id,
          isBot: false,
          occurredAt: new Date('1999-05-07T12:00:00Z'),
        },
      });

      const window = { from: new Date('1999-05-01'), to: new Date('1999-05-31') };
      const ours = await clicksByDay(scoped(mine), window, 'UTC');
      const days = ours.map((d) => d.day);

      // Positive control: our own click in the same window IS returned, so the absence
      // below is filtering rather than an empty query.
      expect(days).toContain('1999-05-07');
      expect(days).not.toContain('1999-05-05');

      // And the other tenant really does have that day — asserted from their own scope,
      // so this is a leak test rather than a test that the row was never created.
      const theirDays = await clicksByDay(scoped(theirs), window, 'UTC');
      expect(theirDays.map((d) => d.day)).toContain('1999-05-05');
    });

    it('separates bot clicks from human ones within a day', async () => {
      const link = await db.shortLink.findFirst({ where: { slug: mine.slugs.x } });
      const day = '2021-07-04T15:00:00Z';

      for (let i = 0; i < 2; i += 1) {
        await db.linkClick.create({
          data: { shortLinkId: link!.id, isBot: false, occurredAt: new Date(day) },
        });
      }
      for (let i = 0; i < 3; i += 1) {
        await db.linkClick.create({
          data: {
            shortLinkId: link!.id,
            isBot: true,
            botReason: 'ua-crawler',
            occurredAt: new Date(day),
          },
        });
      }

      const days = await clicksByDay(
        scoped(mine),
        { from: new Date('2021-07-01'), to: new Date('2021-07-31') },
        'UTC',
      );
      const july4 = days.find((d) => d.day === '2021-07-04');
      expect(july4).toBeDefined();

      // The counts differ, so folding bots into the human total changes the answer.
      // Equal counts would make this assertion pass under exactly that bug.
      expect(july4!.clicks).toBe(2);
      expect(july4!.botClicks).toBe(3);
    });

    it('respects the window rather than returning everything', async () => {
      const days = await clicksByDay(
        scoped(mine),
        { from: new Date('1990-01-01'), to: new Date('1990-01-02') },
        'UTC',
      );
      expect(days).toEqual([]);

      // Positive control: the same call over a real window is not empty, so the result
      // above means "filtered out" and not "this function returns nothing".
      const wide = await clicksByDay(scoped(mine), WINDOW, 'UTC');
      expect(wide.length).toBeGreaterThan(0);
    });
  });
});
