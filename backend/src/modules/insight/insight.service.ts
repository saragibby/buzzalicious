import type { Platform } from '@prisma/client';
import type { ScopedDb } from '../../platform/tenancy';
import {
  clicksAreMeasurable,
  clicksByShortLink,
  rollUpByPlatform,
  rollUpByTemplate,
  type ClickGroup,
  type ClickWindow,
} from '../link/rollup.service';
import { comparable, outcomeScore, type OutcomeComponent, type OutcomeScore } from './outcome';

/**
 * The read model behind the insights screens.
 *
 * ## Why this is a separate layer and not a query in the router
 *
 * Three rules have to hold on every number this returns, and each of them is the kind of
 * thing that is correct once and then quietly stops being correct when someone adds a
 * field:
 *
 * 1. **An unmeasured metric is `null`, never `0`.** A zero is a claim that we looked and
 *    found nothing. Instagram never carries a tracked caption link, so reporting `0
 *    clicks` for it would be false — and it would be false in the direction that makes
 *    Instagram look like it never drives traffic.
 * 2. **Every list carries its own sample size.** "Best template" over two posts is noise
 *    wearing a ranking's clothes. The counts travel with the rows so the UI can say so,
 *    and so W8 can shrink them. Shrinkage itself is W8's, not ours.
 * 3. **Scores built from different components are not ranked against each other.**
 *    `comparable()` decides that, and the summary refuses to name a winner when the
 *    candidates were measured differently.
 *
 * ## Aggregation on read
 *
 * `insight/README.md` says aggregation happens on write. That is the right rule for the
 * daily rollups a dashboard hits constantly, and it is not yet true here: these functions
 * aggregate per request. The volume that makes it wrong does not exist at v1 — a brand
 * has tens of posts, not millions — and materialising a rollup before the shape of the
 * screens has settled would bake in the wrong grain. Flagged rather than silently
 * deviated from; the seam to move is this file, which is why the routers never touch
 * Prisma directly.
 */

/** Latest snapshot per target, with the measurement gaps preserved as gaps. */
export interface TargetOutcome {
  postTargetId: string;
  postId: string;
  postTitle: string | null;
  platform: Platform;
  publishedAt: Date | null;
  templateId: string | null;
  /** Carried so the UI can name a template without a second round trip. */
  templateName: string | null;
  trendId: string | null;
  /** `null` where the platform cannot carry a tracked link — not "no clicks". */
  linkClicks: number | null;
  impressions: number | null;
  reach: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  videoViews: number | null;
  /** When the numbers above were captured. `null` means no poll has landed yet. */
  capturedAt: Date | null;
  outcome: OutcomeScore;
}

const METRIC_FIELDS = [
  'impressions',
  'reach',
  'likes',
  'comments',
  'shares',
  'saves',
  'videoViews',
] as const;

/**
 * One row per published target, carrying its most recent snapshot.
 *
 * Deliberately the *latest* snapshot rather than an aggregate over the series: totals are
 * cumulative, so summing snapshots would multiply a post's performance by how many times
 * we happened to poll it.
 */
export async function targetOutcomes(db: ScopedDb, window: ClickWindow): Promise<TargetOutcome[]> {
  const targets = await db.postTarget.findMany({
    where: { publishedAt: { gte: window.from, lte: window.to } },
    select: {
      id: true,
      platform: true,
      publishedAt: true,
      post: {
        select: {
          id: true,
          title: true,
          templateId: true,
          trendId: true,
          template: { select: { name: true } },
        },
      },
      metrics: {
        orderBy: { capturedAt: 'desc' },
        take: 1,
        select: {
          capturedAt: true,
          linkClicks: true,
          impressions: true,
          reach: true,
          likes: true,
          comments: true,
          shares: true,
          saves: true,
          videoViews: true,
        },
      },
    },
    orderBy: { publishedAt: 'desc' },
  });

  return targets.map((target) => {
    const latest = target.metrics[0] ?? null;

    // Absent snapshot and absent metric collapse to the same thing on purpose: both mean
    // "we do not know", and the UI must render them identically. What must never happen
    // is either becoming a 0.
    const metrics = Object.fromEntries(
      METRIC_FIELDS.map((field) => [field, latest?.[field] ?? null]),
    ) as Record<(typeof METRIC_FIELDS)[number], number | null>;

    const linkClicks = clicksAreMeasurable(target.platform) ? (latest?.linkClicks ?? null) : null;

    return {
      postTargetId: target.id,
      postId: target.post.id,
      postTitle: target.post.title,
      platform: target.platform,
      publishedAt: target.publishedAt,
      templateId: target.post.templateId,
      templateName: target.post.template?.name ?? null,
      trendId: target.post.trendId,
      linkClicks,
      ...metrics,
      capturedAt: latest?.capturedAt ?? null,
      outcome: outcomeScore({ linkClicks, ...metrics }),
    };
  });
}

/** A metric timeline point. Every field stays nullable all the way to the chart. */
export interface TimelinePoint {
  capturedAt: Date;
  hoursSincePublish: number | null;
  linkClicks: number | null;
  impressions: number | null;
  reach: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  videoViews: number | null;
}

/**
 * Every snapshot for one target, oldest first.
 *
 * This is the screen that justifies never mutating a total: the shape of the curve — how
 * fast a post peaked and whether it kept earning — is the product, and an in-place update
 * would have destroyed it.
 */
export async function metricTimeline(db: ScopedDb, postTargetId: string): Promise<TimelinePoint[]> {
  const target = await db.postTarget.findFirst({
    where: { id: postTargetId },
    select: {
      publishedAt: true,
      platform: true,
      metrics: {
        orderBy: { capturedAt: 'asc' },
        select: {
          capturedAt: true,
          linkClicks: true,
          impressions: true,
          reach: true,
          likes: true,
          comments: true,
          shares: true,
          saves: true,
          videoViews: true,
        },
      },
    },
  });

  if (!target) return [];
  const measurable = clicksAreMeasurable(target.platform);

  return target.metrics.map((snapshot) => ({
    capturedAt: snapshot.capturedAt,
    hoursSincePublish: target.publishedAt
      ? (snapshot.capturedAt.getTime() - target.publishedAt.getTime()) / 3_600_000
      : null,
    linkClicks: measurable ? snapshot.linkClicks : null,
    impressions: snapshot.impressions,
    reach: snapshot.reach,
    likes: snapshot.likes,
    comments: snapshot.comments,
    shares: snapshot.shares,
    saves: snapshot.saves,
    videoViews: snapshot.videoViews,
  }));
}

/** A grouping's performance, always carrying the sample it was computed from. */
export interface OutcomeGroup<K> {
  key: K;
  /** How many targets contributed a score. The number that decides whether to believe it. */
  scored: number;
  /** Targets in this group with nothing measurable at all. */
  unscored: number;
  /** Mean outcome score across the scored targets, or `null` if none were scored. */
  meanScore: number | null;
  /** Components every scored member shared. Empty when they were measured differently. */
  sharedComponents: OutcomeComponent[];
  clicks: ClickGroup<K> | null;
}

function meanOf(scores: OutcomeScore[]): { mean: number | null; shared: OutcomeComponent[] } {
  const scored = scores.filter((entry) => entry.score !== null);
  if (scored.length === 0) return { mean: null, shared: [] };

  const mean = scored.reduce((sum, entry) => sum + entry.score!, 0) / scored.length;

  // A mean over scores built from different components averages incomparable numbers. The
  // mean is still the best summary available, so it is returned — but `sharedComponents`
  // goes out empty, which is how the caller learns not to rank on it.
  const shared = scored.every((entry) => comparable(entry, scored[0]!)) ? scored[0]!.components : [];

  return { mean, shared };
}

function groupOutcomes<K>(
  rows: TargetOutcome[],
  keyOf: (row: TargetOutcome) => K | undefined,
  clicks: ClickGroup<K>[],
): OutcomeGroup<K>[] {
  const buckets = new Map<string, { key: K; scores: OutcomeScore[]; unscored: number }>();

  for (const row of rows) {
    const key = keyOf(row);
    if (key === undefined) continue;

    const id = JSON.stringify(key);
    const bucket = buckets.get(id) ?? { key, scores: [], unscored: 0 };
    if (row.outcome.score === null) bucket.unscored += 1;
    else bucket.scores.push(row.outcome);
    buckets.set(id, bucket);
  }

  const clicksByKey = new Map(clicks.map((group) => [JSON.stringify(group.key), group]));

  return [...buckets.entries()].map(([id, bucket]) => {
    const { mean, shared } = meanOf(bucket.scores);
    return {
      key: bucket.key,
      scored: bucket.scores.length,
      unscored: bucket.unscored,
      meanScore: mean,
      sharedComponents: shared,
      clicks: clicksByKey.get(id) ?? null,
    };
  });
}

/** Everything the insights dashboard needs, computed once over one window. */
export interface InsightSummary {
  window: ClickWindow;
  targets: TargetOutcome[];
  byPlatform: OutcomeGroup<Platform>[];
  byTemplate: OutcomeGroup<string>[];
  /**
   * The one-line "what's working" claim, or `null` when the data cannot support one.
   *
   * Null is the common case early on and that is correct. A summary that always finds a
   * winner is a summary that names noise, and the user has no way to tell the two apart.
   */
  headline: Headline | null;
}

export interface Headline {
  kind: 'template' | 'platform';
  key: string;
  meanScore: number;
  scored: number;
  runnerUpScore: number;
}

/**
 * The minimum posts behind a group before it is allowed to be called a winner.
 *
 * Three is not a statistical claim; it is the smallest number at which the ranking is not
 * literally a single post. Real shrinkage is W8's, and this deliberately does not
 * anticipate it — an ad-hoc prior here would be a second, conflicting model of the same
 * thing.
 *
 * **Known limitation:** a template used on both a click-measurable platform and Instagram
 * holds targets scored on different components, so it is never named — even when its
 * sample is large. That errs toward silence, which is the right direction for a claim the
 * user cannot audit, but it means the headline stays null more often than the post count
 * suggests. Comparing templates within a platform would fix it at the cost of splitting
 * already-small samples; deferred until there is real data to say which is worse.
 */
const MIN_SAMPLE_FOR_HEADLINE = 3;

function pickHeadline(
  byTemplate: OutcomeGroup<string>[],
  byPlatform: OutcomeGroup<Platform>[],
): Headline | null {
  const candidates: { kind: Headline['kind']; group: OutcomeGroup<string | Platform> }[] = [
    ...byTemplate.map((group) => ({ kind: 'template' as const, group })),
    ...byPlatform.map((group) => ({ kind: 'platform' as const, group })),
  ];

  for (const kind of ['template', 'platform'] as const) {
    const eligible = candidates
      .filter((entry) => entry.kind === kind)
      .filter(
        (entry) =>
          entry.group.meanScore !== null &&
          entry.group.scored >= MIN_SAMPLE_FOR_HEADLINE &&
          // Measured differently means not rankable. Saying so is the whole point.
          entry.group.sharedComponents.length > 0,
      )
      .sort((a, b) => b.group.meanScore! - a.group.meanScore!);

    // One group is not a comparison: with nothing to beat, "best" is just "only".
    if (eligible.length < 2) continue;

    const [winner, runnerUp] = eligible;
    if (winner!.group.sharedComponents.join(',') !== runnerUp!.group.sharedComponents.join(','))
      continue;

    return {
      kind,
      key: String(winner!.group.key),
      meanScore: winner!.group.meanScore!,
      scored: winner!.group.scored,
      runnerUpScore: runnerUp!.group.meanScore!,
    };
  }

  return null;
}

export async function insightSummary(db: ScopedDb, window: ClickWindow): Promise<InsightSummary> {
  const [targets, linkRows] = await Promise.all([
    targetOutcomes(db, window),
    clicksByShortLink(db, window),
  ]);

  const byPlatform = groupOutcomes(
    targets,
    (row) => row.platform,
    rollUpByPlatform(linkRows),
  );
  const byTemplate = groupOutcomes(
    targets,
    (row) => row.templateId ?? undefined,
    await rollUpByTemplate(db, linkRows),
  );

  return {
    window,
    targets,
    byPlatform,
    byTemplate,
    headline: pickHeadline(byTemplate, byPlatform),
  };
}
