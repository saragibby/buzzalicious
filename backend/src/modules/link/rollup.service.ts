import type { Platform } from '@prisma/client';
import type { ScopedDb } from '../../platform/tenancy';
import { acceptsInlineLink } from './link-injection';
import { isSupportedPlatform } from '../template/platform-spec';

/**
 * Click rollups — the raw material W8's recommender learns from.
 *
 * ## Every read excludes bots, and none of them silently
 *
 * `isBot` is a flag rather than a delete (ADR-0006) precisely so the filters can be
 * retuned later against real traffic. The cost of that choice is that **every** analytic
 * read has to remember to exclude them, and forgetting is invisible: the numbers stay
 * plausible, they are just uniformly inflated by whichever platforms crawl hardest. So
 * bot exclusion lives in one private helper here and the counts are returned alongside
 * `botClicks`, which makes the filtering observable instead of implied.
 *
 * ## A zero and an unknown are different numbers
 *
 * Instagram does not linkify caption URLs, so its short link is never published in the
 * caption. Reporting `0 clicks` for an Instagram target would be a lie the recommender
 * believes — it would learn that Instagram posts never drive traffic, when the truth is
 * that we never measured them. Those rows carry `clicks: null` and `available: false`,
 * and the distinction has to survive every layer above this one. `SUM` over a mix of
 * numbers and nulls quietly drops the nulls, so aggregates here count contributors
 * explicitly rather than leaning on the database to do the right thing.
 */

export interface ClickWindow {
  from: Date;
  to: Date;
}

/** One `(post, platform)` pairing and what it actually earned. */
export interface ShortLinkClicks {
  shortLinkId: string;
  slug: string;
  postId: string | null;
  platform: Platform | null;
  /** Human clicks, or `null` where this platform cannot carry a tracked caption link. */
  clicks: number | null;
  /** Filtered out as automated. Always a number: we saw them, we just did not count them. */
  botClicks: number;
  /** False means "not measurable here", never "measured and found nothing". */
  available: boolean;
}

/** An aggregate over some grouping, carrying enough context to judge its own weight. */
export interface ClickGroup<K> {
  key: K;
  clicks: number;
  /** How many short links contributed a real number. W8 needs this to shrink small samples. */
  measured: number;
  /** Short links in this group that could not be measured at all. */
  unmeasured: number;
  botClicks: number;
}

/**
 * Can a tracked link in this platform's caption be clicked at all?
 *
 * A `null` platform is a brand-level short link — shared by hand, in a bio, anywhere. It
 * is genuinely measurable, so it counts.
 */
export function clicksAreMeasurable(platform: Platform | null): boolean {
  if (platform === null) return true;
  if (!isSupportedPlatform(platform)) return true;
  return acceptsInlineLink(platform);
}

/**
 * Per-`(post, platform)` click counts for a brand in a window.
 *
 * The one query everything else in this file is derived from. Counting through a filtered
 * relation lets the database do the work while the tenant extension still scopes the
 * outer `ShortLink` read — a raw SQL aggregate would be faster and would bypass tenancy
 * entirely, which is not a trade worth making for a table this size.
 */
export async function clicksByShortLink(
  db: ScopedDb,
  window: ClickWindow,
): Promise<ShortLinkClicks[]> {
  const occurredAt = { gte: window.from, lte: window.to };

  const links = await db.shortLink.findMany({
    select: {
      id: true,
      slug: true,
      postId: true,
      platform: true,
      _count: {
        select: {
          clicks: { where: { isBot: false, occurredAt } },
        },
      },
    },
  });

  // A second pass for the bot half. Prisma cannot return two differently-filtered counts
  // of the same relation in one `_count`, and inferring bots as (total - human) would
  // report a wrong number rather than no number if either filter drifted.
  const botCounts = await db.linkClick.groupBy({
    by: ['shortLinkId'],
    where: { isBot: true, occurredAt },
    _count: { _all: true },
  });
  const bots = new Map(botCounts.map((row) => [row.shortLinkId, row._count._all]));

  return links.map((link) => {
    const available = clicksAreMeasurable(link.platform);
    return {
      shortLinkId: link.id,
      slug: link.slug,
      postId: link.postId,
      platform: link.platform,
      clicks: available ? link._count.clicks : null,
      botClicks: bots.get(link.id) ?? 0,
      available,
    };
  });
}

/**
 * Fold rows into groups, keeping measured and unmeasured apart.
 *
 * `keyOf` returning `undefined` drops the row — used where the grouping dimension is a
 * nullable foreign key and "no template" is not a template whose performance we can
 * report on.
 */
function groupBy<K>(
  rows: ShortLinkClicks[],
  keyOf: (row: ShortLinkClicks) => K | undefined,
): ClickGroup<K>[] {
  const out = new Map<string, ClickGroup<K>>();

  for (const row of rows) {
    const key = keyOf(row);
    if (key === undefined) continue;

    const id = JSON.stringify(key);
    const group = out.get(id) ?? { key, clicks: 0, measured: 0, unmeasured: 0, botClicks: 0 };

    if (row.clicks === null) {
      group.unmeasured += 1;
    } else {
      group.clicks += row.clicks;
      group.measured += 1;
    }
    group.botClicks += row.botClicks;

    out.set(id, group);
  }

  return [...out.values()];
}

/** Clicks per post. Brand-level links (no post) are excluded rather than bucketed. */
export function rollUpByPost(rows: ShortLinkClicks[]): ClickGroup<string>[] {
  return groupBy(rows, (row) => row.postId ?? undefined);
}

/** Clicks per platform. This is the comparison the whole per-platform link design exists for. */
export function rollUpByPlatform(rows: ShortLinkClicks[]): ClickGroup<Platform>[] {
  return groupBy(rows, (row) => row.platform ?? undefined);
}

/**
 * Clicks per template and per trend.
 *
 * Both foreign keys are `SetNull` on delete, so a post can outlive the template it was
 * built from. Those posts are dropped from the grouping — attributing their clicks to
 * `null` would create a phantom "template" that outperforms every real one by virtue of
 * being an aggregate of all of them.
 */
export async function rollUpByTemplate(
  db: ScopedDb,
  rows: ShortLinkClicks[],
): Promise<ClickGroup<string>[]> {
  const byPost = await postDimensions(db, rows);
  return groupBy(rows, (row) => (row.postId ? byPost.get(row.postId)?.templateId : undefined));
}

export async function rollUpByTrend(
  db: ScopedDb,
  rows: ShortLinkClicks[],
): Promise<ClickGroup<string>[]> {
  const byPost = await postDimensions(db, rows);
  return groupBy(rows, (row) => (row.postId ? byPost.get(row.postId)?.trendId : undefined));
}

async function postDimensions(
  db: ScopedDb,
  rows: ShortLinkClicks[],
): Promise<Map<string, { templateId: string | undefined; trendId: string | undefined }>> {
  const postIds = [...new Set(rows.map((row) => row.postId).filter((id): id is string => !!id))];
  if (postIds.length === 0) return new Map();

  const posts = await db.post.findMany({
    where: { id: { in: postIds } },
    select: { id: true, templateId: true, trendId: true },
  });

  return new Map(
    posts.map((post) => [
      post.id,
      { templateId: post.templateId ?? undefined, trendId: post.trendId ?? undefined },
    ]),
  );
}

/** A day bucket in the brand's own terms. */
export interface ClickDay {
  /** `YYYY-MM-DD` in the requested time zone. */
  day: string;
  clicks: number;
  botClicks: number;
}

/**
 * Human clicks per day.
 *
 * Bucketed in the brand's time zone rather than UTC, because "Tuesday" to a small
 * business owner in Denver is not the UTC day — and a report that quietly shifts
 * everything by several hours makes the best-time-to-post signal wrong in exactly the
 * hours that matter most.
 */
export async function clicksByDay(
  db: ScopedDb,
  window: ClickWindow,
  timeZone: string,
): Promise<ClickDay[]> {
  const clicks = await db.linkClick.findMany({
    where: { occurredAt: { gte: window.from, lte: window.to } },
    select: { occurredAt: true, isBot: true },
  });

  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  const days = new Map<string, ClickDay>();
  for (const click of clicks) {
    const day = formatter.format(click.occurredAt);
    const bucket = days.get(day) ?? { day, clicks: 0, botClicks: 0 };
    if (click.isBot) bucket.botClicks += 1;
    else bucket.clicks += 1;
    days.set(day, bucket);
  }

  return [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
}

/** An hour-of-week bucket in the brand's own terms. */
export interface ClickHour {
  /** 0 = Sunday, in the requested time zone. */
  dayOfWeek: number;
  /** 0–23, in the requested time zone. */
  hour: number;
  clicks: number;
  botClicks: number;
}

/**
 * Human clicks per local hour of the week.
 *
 * Added for W8's send-time cold start: a brand with a website and few posts still has an
 * audience whose clicking has a shape, and that shape is a defensible first suggestion
 * where post outcomes do not yet exist.
 *
 * Deliberately returns a raw day/hour histogram rather than W8's eight send-time slots.
 * The daypart boundaries are a product decision that lives in `modules/brand`, and baking
 * them in here would put the same rule in two modules — where it would be correct on the
 * day it was written and then drift silently, since both copies would keep returning
 * plausible histograms.
 *
 * Bot clicks are counted separately and never folded in, for the same reason `clicksByDay`
 * separates them: link-preview crawlers hit every short link at publish time, so
 * unfiltered they would pile up in whatever hour the brand publishes and the send-time
 * recommender would confidently learn to post exactly when it already posts.
 */
export async function clicksByLocalHour(
  db: ScopedDb,
  window: ClickWindow,
  timeZone: string,
): Promise<ClickHour[]> {
  const clicks = await db.linkClick.findMany({
    where: { occurredAt: { gte: window.from, lte: window.to } },
    select: { occurredAt: true, isBot: true },
  });

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    weekday: 'short',
    hour: '2-digit',
  });

  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const buckets = new Map<string, ClickHour>();

  for (const click of clicks) {
    const parts: Record<string, string> = {};
    for (const part of formatter.formatToParts(click.occurredAt)) {
      if (part.type !== 'literal') parts[part.type] = part.value;
    }

    const dayOfWeek = days.indexOf(parts.weekday ?? '');
    // `hour12: false` renders midnight as 24 in some ICU versions — the same quirk
    // `platform/time.ts` guards against.
    const hour = Number(parts.hour) % 24;
    if (dayOfWeek < 0 || !Number.isFinite(hour)) continue;

    const key = `${dayOfWeek}:${hour}`;
    const bucket = buckets.get(key) ?? { dayOfWeek, hour, clicks: 0, botClicks: 0 };
    if (click.isBot) bucket.botClicks += 1;
    else bucket.clicks += 1;
    buckets.set(key, bucket);
  }

  return [...buckets.values()].sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.hour - b.hour);
}
