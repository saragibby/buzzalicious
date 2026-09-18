import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectPrisma, getPrisma, type Db } from '../../src/platform/db';
import { withTenantScope } from '../../src/platform/tenancy';
import {
  insightSummary,
  metricTimeline,
  targetOutcomes,
} from '../../src/modules/insight/insight.service';
import { hasTestDatabase } from '../env';

/**
 * The insights read model against a real database.
 *
 * Tenancy is asserted on **identity** with the other tenant's rows genuinely present, and
 * every such test carries a positive control. A count assertion would pass under the bug
 * it exists to catch: a broken `ScopeRule` collapses to `{}`, which is *no filter* rather
 * than a deny, so a leak returns MORE rows.
 *
 * `PostMetric` reaches its tenant through `postTarget -> post -> brand`, a three-hop
 * relation, so the other tenant here has its own targets and its own snapshots rather
 * than an empty shell that would let a broken rule look correct.
 */

const WINDOW = { from: new Date('2020-01-01'), to: new Date('2100-01-01') };
const PUBLISHED = new Date('2026-03-01T12:00:00.000Z');

interface Snapshot {
  hours: number;
  linkClicks?: number | null;
  likes?: number | null;
  reach?: number | null;
  saves?: number | null;
}

interface TargetSpec {
  platform: 'X' | 'INSTAGRAM' | 'FACEBOOK';
  templateKey: string;
  snapshots: Snapshot[];
}

describe.skipIf(!hasTestDatabase)('insight read model', () => {
  let db: Db;
  const workspaceIds: string[] = [];
  // Platform-global, so the workspace cascade does not reach them. Left behind they
  // pollute other files' unfiltered reads.
  const templateIds: string[] = [];

  interface Fixture {
    workspaceId: string;
    brandId: string;
    templates: Record<string, string>;
    targets: Record<string, string>;
    postTitles: string[];
  }

  async function makeTenant(name: string, specs: Record<string, TargetSpec>): Promise<Fixture> {
    const workspaceId = randomUUID();
    const brandId = randomUUID();

    await db.workspace.create({
      data: { id: workspaceId, slug: `ins-${workspaceId.slice(0, 8)}`, name },
    });
    workspaceIds.push(workspaceId);
    await db.brand.create({
      data: {
        id: brandId,
        workspaceId,
        name,
        slug: `ib-${brandId.slice(0, 8)}`,
        palette: {},
        typography: {},
        voiceGuide: {},
      },
    });

    const templates: Record<string, string> = {};
    const targets: Record<string, string> = {};
    const postTitles: string[] = [];

    for (const [key, spec] of Object.entries(specs)) {
      if (!templates[spec.templateKey]) {
        const template = await db.template.create({
          data: {
            name: `${name} ${spec.templateKey}`,
            slug: `it-${randomUUID().slice(0, 8)}`,
            archetype: 'promo',
            status: 'PUBLISHED',
            slotSchema: {},
            layout: {},
            supportedRatios: [],
          },
        });
        templates[spec.templateKey] = template.id;
        templateIds.push(template.id);
      }

      const title = `${name} ${key}`;
      postTitles.push(title);
      const post = await db.post.create({
        data: {
          brandId,
          title,
          status: 'PUBLISHED',
          templateId: templates[spec.templateKey]!,
        },
      });

      const target = await db.postTarget.create({
        data: {
          postId: post.id,
          platform: spec.platform,
          status: 'PUBLISHED',
          publishedAt: PUBLISHED,
        },
      });
      targets[key] = target.id;

      for (const snapshot of spec.snapshots) {
        await db.postMetric.create({
          data: {
            postTargetId: target.id,
            source: 'test',
            capturedAt: new Date(PUBLISHED.getTime() + snapshot.hours * 3_600_000),
            linkClicks: snapshot.linkClicks ?? null,
            likes: snapshot.likes ?? null,
            reach: snapshot.reach ?? null,
            saves: snapshot.saves ?? null,
          },
        });
      }
    }

    return { workspaceId, brandId, templates, targets, postTitles };
  }

  let mine: Fixture;
  let theirs: Fixture;
  // Three brands that each isolate exactly one headline guard. Without them the guards
  // mask each other: a fixture that trips two of them stays null however many are
  // removed, so every one of these was written because a mutation survived.
  let solo: Fixture;
  let floor: Fixture;
  let mixed: Fixture;

  beforeAll(async () => {
    db = getPrisma();

    mine = await makeTenant('Mine', {
      // Three posts on one template, all measured the same way, so the headline has an
      // eligible winner with a real sample behind it.
      a1: {
        platform: 'X',
        templateKey: 'alpha',
        snapshots: [{ hours: 1, linkClicks: 10, likes: 4 }],
      },
      a2: {
        platform: 'X',
        templateKey: 'alpha',
        snapshots: [{ hours: 1, linkClicks: 12, likes: 5 }],
      },
      a3: {
        platform: 'X',
        templateKey: 'alpha',
        snapshots: [{ hours: 1, linkClicks: 14, likes: 6 }],
      },
      b1: {
        platform: 'X',
        templateKey: 'beta',
        snapshots: [{ hours: 1, linkClicks: 1, likes: 1 }],
      },
      b2: {
        platform: 'X',
        templateKey: 'beta',
        snapshots: [{ hours: 1, linkClicks: 2, likes: 1 }],
      },
      b3: {
        platform: 'X',
        templateKey: 'beta',
        snapshots: [{ hours: 1, linkClicks: 3, likes: 1 }],
      },
      // Cumulative totals across three polls: the latest must win, never the sum.
      series: {
        platform: 'FACEBOOK',
        templateKey: 'alpha',
        snapshots: [
          { hours: 1, linkClicks: 1, likes: 1 },
          { hours: 24, linkClicks: 5, likes: 3 },
          { hours: 168, linkClicks: 9, likes: 7 },
        ],
      },
      // Instagram cannot carry a tracked caption link. Its stored linkClicks is a real
      // number here on purpose — if the read model trusted the column instead of asking
      // whether clicks are measurable, this would surface as a click count.
      insta: {
        platform: 'INSTAGRAM',
        templateKey: 'gamma',
        snapshots: [{ hours: 1, linkClicks: 77, likes: 2, saves: 3 }],
      },
      // Published but never polled.
      unpolled: { platform: 'X', templateKey: 'beta', snapshots: [] },
      // A second gamma post measured the same way as the X posts. Gamma therefore holds
      // two targets scored on *different* component sets, which is what makes it
      // unrankable — see the mixed-measurement test.
      g2: {
        platform: 'X',
        templateKey: 'gamma',
        snapshots: [{ hours: 1, linkClicks: 8, likes: 2 }],
      },
      g3: {
        platform: 'X',
        templateKey: 'gamma',
        snapshots: [{ hours: 1, linkClicks: 8, likes: 2 }],
      },
      g4: {
        platform: 'X',
        templateKey: 'gamma',
        snapshots: [{ hours: 1, linkClicks: 8, likes: 2 }],
      },
    });

    theirs = await makeTenant('Theirs', {
      t1: {
        platform: 'X',
        templateKey: 'alpha',
        snapshots: [{ hours: 1, linkClicks: 9999, likes: 9999 }],
      },
      t2: {
        platform: 'X',
        templateKey: 'alpha',
        snapshots: [{ hours: 1, linkClicks: 9999, likes: 9999 }],
      },
    });

    // One template, one platform, a sample well over the floor. Only the
    // "two groups or it is not a comparison" guard stands between this and a headline.
    solo = await makeTenant('Solo', {
      s1: {
        platform: 'X',
        templateKey: 'solo',
        snapshots: [{ hours: 1, linkClicks: 5, likes: 1 }],
      },
      s2: {
        platform: 'X',
        templateKey: 'solo',
        snapshots: [{ hours: 1, linkClicks: 6, likes: 1 }],
      },
      s3: {
        platform: 'X',
        templateKey: 'solo',
        snapshots: [{ hours: 1, linkClicks: 7, likes: 1 }],
      },
      s4: {
        platform: 'X',
        templateKey: 'solo',
        snapshots: [{ hours: 1, linkClicks: 8, likes: 1 }],
      },
    });

    // Two comparable templates, but the higher-scoring one rests on a single post. Only
    // the sample floor stops it being named, and it scores an order of magnitude above
    // the other so a floor-less ranking would certainly pick it.
    floor = await makeTenant('Floor', {
      z1: {
        platform: 'X',
        templateKey: 'zeta',
        snapshots: [{ hours: 1, linkClicks: 1, likes: 1 }],
      },
      z2: {
        platform: 'X',
        templateKey: 'zeta',
        snapshots: [{ hours: 1, linkClicks: 1, likes: 1 }],
      },
      z3: {
        platform: 'X',
        templateKey: 'zeta',
        snapshots: [{ hours: 1, linkClicks: 1, likes: 1 }],
      },
      e1: {
        platform: 'X',
        templateKey: 'eta',
        snapshots: [{ hours: 1, linkClicks: 500, likes: 500 }],
      },
    });

    // Two templates, each internally consistent and each over the floor, but measured on
    // different components — clicks here, saves there. Both pass every other guard, so
    // only the winner-versus-runner-up comparability check refuses this one.
    mixed = await makeTenant('Mixed', {
      d1: {
        platform: 'X',
        templateKey: 'delta',
        snapshots: [{ hours: 1, linkClicks: 9, likes: 1 }],
      },
      d2: {
        platform: 'X',
        templateKey: 'delta',
        snapshots: [{ hours: 1, linkClicks: 9, likes: 1 }],
      },
      d3: {
        platform: 'X',
        templateKey: 'delta',
        snapshots: [{ hours: 1, linkClicks: 9, likes: 1 }],
      },
      p1: {
        platform: 'INSTAGRAM',
        templateKey: 'epsilon',
        snapshots: [{ hours: 1, saves: 4, likes: 1 }],
      },
      p2: {
        platform: 'INSTAGRAM',
        templateKey: 'epsilon',
        snapshots: [{ hours: 1, saves: 4, likes: 1 }],
      },
      p3: {
        platform: 'INSTAGRAM',
        templateKey: 'epsilon',
        snapshots: [{ hours: 1, saves: 4, likes: 1 }],
      },
    });
  });

  afterAll(async () => {
    for (const id of workspaceIds) {
      await db.workspace.deleteMany({ where: { id } });
    }
    await db.template.deleteMany({ where: { id: { in: templateIds } } });
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
    it('returns only this brand\u2019s targets, with the other tenant present', async () => {
      const rows = await targetOutcomes(scoped(mine), WINDOW);
      const ids = rows.map((row) => row.postTargetId);

      // Positive control: without this, an empty result would pass every line below.
      expect(ids).toContain(mine.targets.a1);

      for (const id of Object.values(theirs.targets)) {
        expect(ids).not.toContain(id);
      }
      // The other tenant genuinely has rows to leak, proving the assertion had something
      // to catch rather than passing over an empty table.
      expect(await targetOutcomes(scoped(theirs), WINDOW)).not.toHaveLength(0);
    });

    it('will not read another tenant\u2019s timeline', async () => {
      const foreign = await metricTimeline(scoped(mine), theirs.targets.t1!);
      expect(foreign).toEqual([]);

      // Positive control, same id through the owning scope: the target really does have
      // snapshots, so the empty result above is a refusal and not an absence.
      expect(await metricTimeline(scoped(theirs), theirs.targets.t1!)).not.toHaveLength(0);
    });

    it('keeps another tenant\u2019s numbers out of the summary', async () => {
      const summary = await insightSummary(scoped(mine), WINDOW);
      const titles = summary.targets.map((target) => target.postTitle);

      expect(titles).toContain(mine.postTitles[0]);
      for (const title of theirs.postTitles) {
        expect(titles).not.toContain(title);
      }

      // A leak would drag a 9999-click post in and take the template means with it.
      for (const group of summary.byTemplate) {
        expect(Object.values(theirs.templates)).not.toContain(group.key);
      }
    });
  });

  describe('a zero is a lie', () => {
    it('reports Instagram clicks as null even though a number is stored', async () => {
      const rows = await targetOutcomes(scoped(mine), WINDOW);
      const insta = rows.find((row) => row.postTargetId === mine.targets.insta);

      expect(insta!.linkClicks).toBeNull();
      expect(insta!.linkClicks).not.toBe(0);
      // Proves the null is a deliberate suppression rather than a missing snapshot: the
      // same row's other metrics came through.
      expect(insta!.saves).toBe(3);
      expect(insta!.likes).toBe(2);
    });

    it('leaves an unpolled target null across the board rather than zero', async () => {
      const rows = await targetOutcomes(scoped(mine), WINDOW);
      const unpolled = rows.find((row) => row.postTargetId === mine.targets.unpolled);

      for (const field of ['linkClicks', 'likes', 'reach', 'saves', 'impressions'] as const) {
        expect(unpolled![field], `${field} should be null`).toBeNull();
        expect(unpolled![field]).not.toBe(0);
      }
      expect(unpolled!.capturedAt).toBeNull();
      expect(unpolled!.outcome.score).toBeNull();
    });

    it('does not report an unmeasured metric that a sibling target does report', async () => {
      const rows = await targetOutcomes(scoped(mine), WINDOW);
      const a1 = rows.find((row) => row.postTargetId === mine.targets.a1);

      // `saves` was never written for this target but was for `insta`, so a read model
      // that filled gaps from the wrong row — or with 0 — would show something here.
      expect(a1!.saves).toBeNull();
      expect(a1!.linkClicks).toBe(10);
    });
  });

  describe('history is the product', () => {
    it('takes the latest snapshot, never the sum of the series', async () => {
      const rows = await targetOutcomes(scoped(mine), WINDOW);
      const series = rows.find((row) => row.postTargetId === mine.targets.series);

      // 1 + 5 + 9 = 15 would be the sum; 9 is the truth. Both are plausible numbers,
      // which is why this asserts the exact value rather than a bound.
      expect(series!.linkClicks).toBe(9);
      expect(series!.likes).toBe(7);
      expect(series!.capturedAt?.toISOString()).toBe(
        new Date(PUBLISHED.getTime() + 168 * 3_600_000).toISOString(),
      );
    });

    it('returns the whole timeline oldest first with hours since publish', async () => {
      const points = await metricTimeline(scoped(mine), mine.targets.series!);

      expect(points.map((point) => point.linkClicks)).toEqual([1, 5, 9]);
      expect(points.map((point) => point.hoursSincePublish)).toEqual([1, 24, 168]);
    });

    it('suppresses clicks in the timeline of a platform that cannot carry them', async () => {
      const points = await metricTimeline(scoped(mine), mine.targets.insta!);

      expect(points).toHaveLength(1);
      expect(points[0]!.linkClicks).toBeNull();
      expect(points[0]!.likes).toBe(2);
    });
  });

  describe('the headline refuses to name noise', () => {
    it('names the better template when both have a real sample', async () => {
      const summary = await insightSummary(scoped(mine), WINDOW);

      expect(summary.headline).not.toBeNull();
      expect(summary.headline!.kind).toBe('template');
      expect(summary.headline!.key).toBe(mine.templates.alpha);
      expect(summary.headline!.scored).toBeGreaterThanOrEqual(3);
      expect(summary.headline!.meanScore).toBeGreaterThan(summary.headline!.runnerUpScore);
    });

    it('will not name a template whose posts were measured differently', async () => {
      const summary = await insightSummary(scoped(mine), WINDOW);
      const gamma = summary.byTemplate.find((group) => group.key === mine.templates.gamma);

      // Gamma has four scored posts — more than the sample floor, and a higher raw mean
      // than beta — so sample size is not what disqualifies it.
      expect(gamma!.scored).toBeGreaterThanOrEqual(4);
      expect(gamma!.meanScore).not.toBeNull();
      // But one of them is an Instagram post scored on saves where the others were scored
      // on clicks. Empty shared components is how that reaches the caller.
      expect(gamma!.sharedComponents).toEqual([]);
      expect(summary.headline!.key).not.toBe(mine.templates.gamma);
    });

    it('carries the sample size on every group so the UI can qualify it', async () => {
      const summary = await insightSummary(scoped(mine), WINDOW);
      const beta = summary.byTemplate.find((group) => group.key === mine.templates.beta);

      // The beta group holds three scored posts plus the never-polled one, which must be
      // counted as unscored rather than folded in as a zero and dragging the mean down.
      expect(beta!.unscored).toBeGreaterThanOrEqual(1);
      expect(beta!.scored).toBeGreaterThanOrEqual(3);
    });

    it('stays silent when there is only one group, however large its sample', async () => {
      const summary = await insightSummary(scoped(solo), WINDOW);
      const group = summary.byTemplate[0];

      // The group clears the sample floor and is internally comparable, so nothing but
      // the absence of anything to beat disqualifies it.
      expect(group!.scored).toBe(4);
      expect(group!.sharedComponents.length).toBeGreaterThan(0);
      expect(summary.byTemplate).toHaveLength(1);
      expect(summary.byPlatform).toHaveLength(1);
      expect(summary.headline).toBeNull();
    });

    it('stays silent when the best group rests on a single post', async () => {
      const summary = await insightSummary(scoped(floor), WINDOW);
      const eta = summary.byTemplate.find((group) => group.key === floor.templates.eta);
      const zeta = summary.byTemplate.find((group) => group.key === floor.templates.zeta);

      // Two comparable groups, so the comparison guard is satisfied; eta scores far
      // higher, so ranking would pick it; it has one post, so the floor must refuse.
      expect(summary.byTemplate).toHaveLength(2);
      expect(eta!.scored).toBe(1);
      expect(eta!.meanScore!).toBeGreaterThan(zeta!.meanScore!);
      expect(eta!.sharedComponents).toEqual(zeta!.sharedComponents);
      expect(summary.headline).toBeNull();
    });

    it('stays silent when the two best groups were measured differently', async () => {
      const summary = await insightSummary(scoped(mixed), WINDOW);
      const delta = summary.byTemplate.find((group) => group.key === mixed.templates.delta);
      const epsilon = summary.byTemplate.find((group) => group.key === mixed.templates.epsilon);

      // Each group is internally comparable and over the floor — every guard except the
      // cross-group comparability check passes.
      expect(delta!.scored).toBe(3);
      expect(epsilon!.scored).toBe(3);
      expect(delta!.sharedComponents.length).toBeGreaterThan(0);
      expect(epsilon!.sharedComponents.length).toBeGreaterThan(0);
      expect(delta!.sharedComponents).not.toEqual(epsilon!.sharedComponents);
      expect(summary.headline).toBeNull();
    });

    it('stays silent for a brand with only one template to compare', async () => {
      const summary = await insightSummary(scoped(theirs), WINDOW);

      // Two posts, one template. "Best" with nothing to beat is just "only".
      expect(summary.headline).toBeNull();
      // Positive control: the brand's data really did load, so the null headline is a
      // refusal rather than an empty read.
      expect(summary.targets).toHaveLength(2);
      expect(summary.byTemplate).toHaveLength(1);
    });
  });
});
