import { describe, expect, it } from 'vitest';
import {
  BOT_REASON,
  acceptsHtml,
  classifyClick,
  isCrawlerUserAgent,
  withinPublishProximity,
} from './bot-filter';

/**
 * Real user-agent strings, copied verbatim from the wild rather than paraphrased.
 *
 * A paraphrased UA tests the test author's memory of a format, not the format. These are
 * the strings that actually arrive within milliseconds of a publish.
 */
const CRAWLER_AGENTS: Array<[string, string]> = [
  [
    'Facebook link preview',
    'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
  ],
  ['Facebook catalog', 'facebookcatalog/1.0'],
  [
    'Meta external agent',
    'meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)',
  ],
  ['Twitterbot', 'Twitterbot/1.0'],
  [
    'LinkedInBot',
    'LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)',
  ],
  ['Slackbot unfurl', 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)'],
  ['Slack image proxy', 'Slack-ImgProxy 0.19 (+https://api.slack.com/robots)'],
  ['WhatsApp', 'WhatsApp/2.23.20.0 A'],
  ['Telegram', 'TelegramBot (like TwitterBot)'],
  ['Discord', 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)'],
  ['Skype', 'SkypeUriPreview Preview/0.5 skype-url-preview@microsoft.com'],
  ['Reddit', 'redditbot/1.0 (+http://www.reddit.com/feedback)'],
  ['Pinterest', 'Pinterest/0.2 (+http://www.pinterest.com/bot.html)'],
  [
    'Applebot',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15 Applebot/0.1',
  ],
  ['Embedly', 'Embedly/0.2 (+http://support.embed.ly/)'],
  ['Googlebot', 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'],
  ['Bingbot', 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)'],
  ['AhrefsBot', 'Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)'],
  [
    'HeadlessChrome (Puppeteer default)',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0.0.0 Safari/537.36',
  ],
  ['python-requests', 'python-requests/2.31.0'],
  ['Go http client', 'Go-http-client/2.0'],
  ['curl', 'curl/8.4.0'],
  ['wget', 'Wget/1.21.4'],
  ['Postman', 'PostmanRuntime/7.35.0'],
  ['node-fetch', 'node-fetch/1.0 (+https://github.com/bitinn/node-fetch)'],
  ['okhttp', 'okhttp/4.12.0'],
  ['Java', 'Java/17.0.9'],
];

/**
 * Genuine browsers that must survive the filter.
 *
 * **This is the load-bearing half of the suite.** Without it, `isCrawlerUserAgent = () =>
 * true` passes every crawler assertion above, and the product would silently discard its
 * entire click signal while every bot test stayed green.
 *
 * The last three exist specifically to prove the matching is *narrow*. `Cubot` and
 * `Abbott` are real device and manufacturer names containing `bot`, and `YaBrowser`
 * contains no crawler token but looks like one at a glance. Matching a bare `bot`
 * substring — the obvious shortcut — makes all three false positives, and a false
 * positive permanently deletes a real person's click with no way to recover it.
 */
const HUMAN_AGENTS: Array<[string, string]> = [
  [
    'Chrome on macOS',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  ],
  [
    'Safari on iPhone',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1',
  ],
  [
    'Firefox on Windows',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  ],
  [
    'Chrome on Android',
    'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  ],
  [
    'Instagram in-app browser',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 302.0.0.23.113',
  ],
  [
    'Edge on Windows',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
  ],
  [
    'Cubot phone — a real device whose name contains "bot"',
    'Mozilla/5.0 (Linux; Android 11; CUBOT NOTE 20 PRO) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  ],
  [
    'a product name containing "bott"',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Abbott/3.2 Chrome/119.0.0.0 Safari/537.36',
  ],
  [
    'Yandex Browser — a browser, not YandexBot',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 YaBrowser/23.11.0.0 Safari/537.36',
  ],
];

describe('isCrawlerUserAgent', () => {
  it.each(CRAWLER_AGENTS)('flags %s', (_label, userAgent) => {
    expect(isCrawlerUserAgent(userAgent)).toBe(true);
  });

  it.each(HUMAN_AGENTS)('does not flag %s', (_label, userAgent) => {
    expect(isCrawlerUserAgent(userAgent)).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isCrawlerUserAgent('FACEBOOKEXTERNALHIT/1.1')).toBe(true);
    expect(isCrawlerUserAgent('TwItTeRbOt/1.0')).toBe(true);
  });

  it('treats an absent user agent as not-a-crawler, leaving it to its own rule', () => {
    // `classifyClick` flags this as `ua-missing`, which is a different and more
    // informative reason than "matched a crawler signature".
    expect(isCrawlerUserAgent(undefined)).toBe(false);
    expect(isCrawlerUserAgent('')).toBe(false);
  });
});

describe('acceptsHtml', () => {
  it('accepts a browser Accept header', () => {
    expect(acceptsHtml('text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8')).toBe(
      true,
    );
  });

  /**
   * `*\/*` is deliberately allowed. Plenty of real browsers send it on a redirect chain,
   * and demanding literal `text/html` would discard real people — the expensive direction
   * of error.
   */
  it('accepts a wildcard rather than discarding real people', () => {
    expect(acceptsHtml('*/*')).toBe(true);
    expect(acceptsHtml('text/*')).toBe(true);
  });

  it('accepts a missing Accept header', () => {
    expect(acceptsHtml(undefined)).toBe(true);
  });

  it.each([
    ['JSON only', 'application/json'],
    ['an image', 'image/webp,image/png'],
    ['plain text only', 'text/plain'],
  ])('rejects %s', (_label, accept) => {
    expect(acceptsHtml(accept)).toBe(false);
  });
});

describe('withinPublishProximity', () => {
  const publishedAt = new Date('2026-09-18T12:00:00.000Z');

  it('flags a click arriving immediately after publication', () => {
    expect(withinPublishProximity(publishedAt, new Date('2026-09-18T12:00:01.000Z'), 90)).toBe(
      true,
    );
  });

  it('does not flag a click arriving after the window', () => {
    expect(withinPublishProximity(publishedAt, new Date('2026-09-18T12:05:00.000Z'), 90)).toBe(
      false,
    );
  });

  it('treats the window boundary as outside', () => {
    expect(withinPublishProximity(publishedAt, new Date('2026-09-18T12:01:30.000Z'), 90)).toBe(
      false,
    );
    expect(withinPublishProximity(publishedAt, new Date('2026-09-18T12:01:29.999Z'), 90)).toBe(
      true,
    );
  });

  /**
   * A click timestamped before publication means a clock disagreement or a link shared
   * ahead of its post going live. Neither is evidence of a bot, and treating a negative
   * interval as "within seconds" would flag every one of them.
   */
  it('does not flag a click timestamped before publication', () => {
    expect(withinPublishProximity(publishedAt, new Date('2026-09-18T11:59:00.000Z'), 90)).toBe(
      false,
    );
  });

  it('cannot flag anything for a post that has not published', () => {
    expect(withinPublishProximity(null, new Date(), 90)).toBe(false);
    expect(withinPublishProximity(undefined, new Date(), 90)).toBe(false);
  });

  it('is disabled by a zero window', () => {
    expect(withinPublishProximity(publishedAt, new Date('2026-09-18T12:00:00.500Z'), 0)).toBe(
      false,
    );
  });
});

describe('classifyClick', () => {
  const human = {
    method: 'GET',
    userAgent: HUMAN_AGENTS[0]![1],
    accept: 'text/html,application/xhtml+xml',
    publishedAt: new Date('2026-09-18T12:00:00.000Z'),
    occurredAt: new Date('2026-09-18T14:00:00.000Z'),
    isDuplicate: false,
  } as const;

  /**
   * The positive control for the whole filter. If this ever goes red, every "flags a bot"
   * assertion below becomes meaningless — a classifier that flagged everything would
   * satisfy all of them.
   */
  it('passes a genuine browser click through unflagged', () => {
    expect(classifyClick(human)).toEqual({ isBot: false, botReason: null });
  });

  it('flags a crawler user agent', () => {
    expect(classifyClick({ ...human, userAgent: 'Twitterbot/1.0' })).toEqual({
      isBot: true,
      botReason: BOT_REASON.crawlerUserAgent,
    });
  });

  it.each([
    ['undefined', undefined],
    ['empty', ''],
    ['whitespace', '   '],
  ])('flags a %s user agent', (_label, userAgent) => {
    expect(classifyClick({ ...human, userAgent })).toEqual({
      isBot: true,
      botReason: BOT_REASON.missingUserAgent,
    });
  });

  it('flags a HEAD request', () => {
    expect(classifyClick({ ...human, method: 'HEAD' })).toEqual({
      isBot: true,
      botReason: BOT_REASON.headRequest,
    });
  });

  it('flags a lowercase head request too', () => {
    expect(classifyClick({ ...human, method: 'head' }).isBot).toBe(true);
  });

  it('flags a request that does not want HTML', () => {
    expect(classifyClick({ ...human, accept: 'application/json' })).toEqual({
      isBot: true,
      botReason: BOT_REASON.nonHtmlAccept,
    });
  });

  it('flags a click arriving within seconds of publication', () => {
    expect(classifyClick({ ...human, occurredAt: new Date('2026-09-18T12:00:02.000Z') })).toEqual({
      isBot: true,
      botReason: BOT_REASON.publishProximity,
    });
  });

  it('flags a duplicate within the window', () => {
    expect(classifyClick({ ...human, isDuplicate: true })).toEqual({
      isBot: true,
      botReason: BOT_REASON.duplicate,
    });
  });

  /**
   * Which reason is recorded when several apply is part of the data contract — the whole
   * point of storing a reason is that a layer can be retuned by selecting the clicks it
   * alone caught, and that only works if the recorded reason is stable and predictable.
   */
  it('records the most specific reason when several rules apply', () => {
    const everything = {
      ...human,
      method: 'HEAD',
      userAgent: 'facebookexternalhit/1.1',
      accept: 'application/json',
      occurredAt: new Date('2026-09-18T12:00:01.000Z'),
      isDuplicate: true,
    };
    expect(classifyClick(everything).botReason).toBe(BOT_REASON.crawlerUserAgent);
  });

  it('prefers the head-request reason over proximity', () => {
    expect(
      classifyClick({
        ...human,
        method: 'HEAD',
        occurredAt: new Date('2026-09-18T12:00:01.000Z'),
      }).botReason,
    ).toBe(BOT_REASON.headRequest);
  });

  /**
   * Every stored reason must be one of the documented tokens. A typo'd literal would
   * silently create a category nothing queries, and the filter it belongs to could then
   * never be retuned — the exact capability the column exists to provide.
   */
  it('only ever produces a documented reason token', () => {
    const tokens = new Set<string>(Object.values(BOT_REASON));
    const cases = [
      { ...human, userAgent: 'Twitterbot/1.0' },
      { ...human, userAgent: '' },
      { ...human, method: 'HEAD' },
      { ...human, accept: 'application/json' },
      { ...human, occurredAt: new Date('2026-09-18T12:00:01.000Z') },
      { ...human, isDuplicate: true },
    ];

    for (const signals of cases) {
      const verdict = classifyClick(signals);
      expect(verdict.isBot).toBe(true);
      expect(tokens).toContain(verdict.botReason);
    }
  });

  /**
   * A post that has not published yet cannot trip the proximity rule, and a real person
   * clicking a link shared before publication is a real click.
   */
  it('does not flag an unpublished post on proximity', () => {
    expect(classifyClick({ ...human, publishedAt: null }).isBot).toBe(false);
  });
});
