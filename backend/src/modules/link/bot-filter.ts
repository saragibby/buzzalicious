import { getConfig } from '../../platform/config';

/**
 * Bot filtering for click ingest.
 *
 * ## Why this is mandatory rather than a refinement
 *
 * Every platform fetches a link preview the instant a post goes live — Facebook,
 * Slack, Twitter and iMessage all do, often several times, and always before a human
 * could have seen the post. Unfiltered, those arrive as the *first* clicks on every link
 * we mint. The entire feedback loop is built on click data, so the recommender would
 * learn that posts nobody read were the successful ones, and it would learn it from a
 * signal that looks perfectly clean.
 *
 * ## Flag, never drop
 *
 * ADR-0006 is explicit, and the reason is retunability: a dropped click cannot be
 * reconsidered. These heuristics *will* be wrong — a UA list goes stale, a proximity
 * window is a guess — and the only way to find out is to hold the rejected traffic and
 * look at it. So every click becomes a row, and `isBot` plus `botReason` say what we
 * thought of it at the time.
 *
 * `botReason` is what makes "retune" mean anything. With a bare boolean you know a click
 * was filtered but not by which of four rules, so you cannot loosen one of them without
 * re-deriving all four from scratch.
 */

/** Stable tokens. Stored, so they are part of the data contract — don't rename lightly. */
export const BOT_REASON = {
  crawlerUserAgent: 'ua-crawler',
  missingUserAgent: 'ua-missing',
  headRequest: 'head-request',
  nonHtmlAccept: 'non-html-accept',
  publishProximity: 'publish-proximity',
  duplicate: 'duplicate',
} as const;

export type BotReason = (typeof BOT_REASON)[keyof typeof BOT_REASON];

/**
 * Substrings identifying a non-human fetcher, lowercased.
 *
 * Substring matching rather than exact: every one of these appears inside a longer UA
 * string that also carries a version and a URL, and pinning the full string would make
 * the list stale the next time a vendor bumped a minor version.
 *
 * `bot`, `crawler` and `spider` as bare substrings are deliberately *not* here. They
 * would catch most of this list for free, and they would also catch
 * `Mozilla/5.0 … Abbott` and any product name containing them. A false positive here
 * deletes a real person's click from the signal permanently.
 */
const CRAWLER_SIGNATURES = [
  // Meta. Fires on every Facebook, Instagram and Threads publish.
  'facebookexternalhit',
  'facebookcatalog',
  'meta-externalagent',
  // X.
  'twitterbot',
  // Named in docs/06 and ADR-0006.
  'linkedinbot',
  'slackbot',
  'slack-imgproxy',
  // Chat apps that unfurl links, which is most of them.
  'whatsapp',
  'telegrambot',
  'discordbot',
  'skypeuripreview',
  'redditbot',
  'pinterest',
  'applebot',
  'embedly',
  'quora link preview',
  'vkshare',
  'tumblr',
  'bitlybot',
  'nuzzel',
  'outbrain',
  'flipboard',
  'google-structured-data-testing-tool',
  'googlebot',
  'bingbot',
  'yandexbot',
  'duckduckbot',
  'baiduspider',
  'ia_archiver',
  'ahrefsbot',
  'semrushbot',
  'mj12bot',
  'dotbot',
  'petalbot',
  // Headless and scripted clients. `headlesschrome` is what Puppeteer reports by default.
  'headlesschrome',
  'phantomjs',
  'electron/',
  'playwright',
  'puppeteer',
  'selenium',
  'python-requests',
  'python-urllib',
  'go-http-client',
  'okhttp',
  'axios/',
  'node-fetch',
  'got (https://github.com/sindresorhus/got)',
  'libwww-perl',
  'java/',
  'apache-httpclient',
  'curl/',
  'wget/',
  'http_request2',
  'guzzlehttp',
  'postmanruntime',
  'insomnia/',
] as const;

export function isCrawlerUserAgent(userAgent: string | undefined): boolean {
  if (!userAgent) return false;
  const lower = userAgent.toLowerCase();
  return CRAWLER_SIGNATURES.some((signature) => lower.includes(signature));
}

/**
 * Does this request want a page, as opposed to metadata?
 *
 * A browser following a link sends an `Accept` beginning with `text/html`. A preview
 * fetcher frequently sends `*\/*`, and `*\/*` is therefore *not* treated as a rejection —
 * plenty of real browsers send it on a redirect chain, and demanding `text/html` would
 * discard real people. Only an `Accept` that is present, non-wildcard, and excludes HTML
 * counts against the request.
 */
export function acceptsHtml(accept: string | undefined): boolean {
  if (!accept) return true;

  const lower = accept.toLowerCase();
  if (lower.includes('text/html')) return true;
  if (lower.includes('*/*')) return true;
  if (lower.includes('text/*')) return true;

  return false;
}

/** Everything the filter needs to judge one request. Identifiers and headers only. */
export interface ClickSignals {
  readonly method: string;
  readonly userAgent: string | undefined;
  readonly accept: string | undefined;
  /** When the post this link belongs to went live, if it has. */
  readonly publishedAt: Date | null | undefined;
  readonly occurredAt: Date;
  /** Whether a click with the same `(ipHash, shortLinkId)` is already inside the window. */
  readonly isDuplicate: boolean;
}

export interface BotVerdict {
  readonly isBot: boolean;
  readonly botReason: BotReason | null;
}

const HUMAN: BotVerdict = { isBot: false, botReason: null };

/**
 * Judge one click.
 *
 * Order matters only for which reason is recorded when several apply, and the order here
 * is most-specific-first so the stored reason is the most informative one. A crawler UA
 * is a stronger statement than "arrived quickly", so it wins.
 */
export function classifyClick(signals: ClickSignals): BotVerdict {
  if (isCrawlerUserAgent(signals.userAgent)) {
    return { isBot: true, botReason: BOT_REASON.crawlerUserAgent };
  }

  // Every real browser sends one. Its absence means a script that did not bother, and
  // link-preview fetchers that omit it are common enough to be worth catching.
  if (!signals.userAgent || signals.userAgent.trim() === '') {
    return { isBot: true, botReason: BOT_REASON.missingUserAgent };
  }

  // A HEAD asks for headers and cannot render anything. It is a liveness check or a
  // preview fetch, never a person reading a page.
  if (signals.method.toUpperCase() === 'HEAD') {
    return { isBot: true, botReason: BOT_REASON.headRequest };
  }

  if (!acceptsHtml(signals.accept)) {
    return { isBot: true, botReason: BOT_REASON.nonHtmlAccept };
  }

  if (withinPublishProximity(signals.publishedAt, signals.occurredAt)) {
    return { isBot: true, botReason: BOT_REASON.publishProximity };
  }

  if (signals.isDuplicate) {
    return { isBot: true, botReason: BOT_REASON.duplicate };
  }

  return HUMAN;
}

/**
 * Did this click arrive too soon after publication to be a human reading the post?
 *
 * The window is configured, not hard-coded, because it is a guess that wants tuning
 * against the real distribution — which is exactly what flagging rather than dropping
 * makes possible later.
 *
 * A negative interval (a click timestamped *before* publication) is not treated as
 * proximity. It means a clock disagreement or a link shared before its post went live,
 * and neither is evidence of a bot.
 */
export function withinPublishProximity(
  publishedAt: Date | null | undefined,
  occurredAt: Date,
  windowSeconds: number = getConfig().link.publishProximitySeconds,
): boolean {
  if (!publishedAt) return false;
  if (windowSeconds <= 0) return false;

  const elapsedMs = occurredAt.getTime() - publishedAt.getTime();
  if (elapsedMs < 0) return false;

  return elapsedMs < windowSeconds * 1000;
}
