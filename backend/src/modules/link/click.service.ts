import { getConfig } from '../../platform/config';
import { getPrisma } from '../../platform/db';
import { getLogger } from '../../platform/logger';
import { classifyClick } from './bot-filter';
import { describeClient } from './ip-hash';
import type { ResolvedShortLink } from './shortlink.service';

/**
 * Recording that a click happened.
 *
 * ## The ordering rule
 *
 * **The redirect is sent first; the click is recorded afterwards.** A visitor must never
 * wait on our write, and a failed write must never cost them their destination. Analytics
 * are core to this product (docs/06), but they are not more important than the person
 * holding the phone.
 *
 * That ordering is why `recordClick` logs its failures instead of throwing them: by the
 * time it runs, the response is already on the wire and there is nobody left to tell.
 *
 * ## What is deliberately absent
 *
 * The raw IP. It reaches `describeClient()` and nothing else — see `ip-hash.ts`.
 */

/** Everything the redirector observed about one request. */
export interface ClickContext {
  readonly method: string;
  readonly ip: string | undefined;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly occurredAt?: Date;
}

/**
 * Coarse device class, derived from the user agent.
 *
 * Three buckets, not a device database. The recommender's question is "does this audience
 * read on a phone", and a parsed model name would be more PII for no more answer.
 */
export function deviceTypeFrom(userAgent: string | undefined): string | null {
  if (!userAgent) return null;
  const lower = userAgent.toLowerCase();

  if (/\b(ipad|tablet|playbook|silk)\b/.test(lower)) return 'tablet';
  if (/(mobile|iphone|ipod|android.*mobile|windows phone)/.test(lower)) return 'mobile';
  if (/(macintosh|windows nt|x11|linux|cros)/.test(lower)) return 'desktop';

  return null;
}

function firstHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const raw = headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * Has this pseudonym already clicked this link inside the dedupe window?
 *
 * A request with no address yields a null `ipHash`, and a null can never be "the same
 * person" as anything. Treating null as a matchable value would collapse every
 * address-less visitor into one identity and discard all but the first as duplicates.
 */
async function isDuplicate(
  shortLinkId: string,
  ipHash: string | null,
  occurredAt: Date,
): Promise<boolean> {
  if (!ipHash) return false;

  const windowSeconds = getConfig().link.dedupeWindowSeconds;
  if (windowSeconds <= 0) return false;

  const since = new Date(occurredAt.getTime() - windowSeconds * 1000);
  const prior = await getPrisma().linkClick.findFirst({
    where: { shortLinkId, ipHash, occurredAt: { gte: since } },
    select: { id: true },
  });

  return prior !== null;
}

/**
 * Write one click.
 *
 * Bot traffic is **flagged, not discarded** (ADR-0006). Every platform fetches a link
 * preview the moment a post publishes, often several times before a human sees it, so on
 * a fresh post the crawlers can outnumber the readers. Dropping them would keep the
 * numbers clean today and make the filters permanently unauditable — there would be no
 * record against which to ask whether a layer was too aggressive. Keeping the rows costs
 * storage and buys the ability to retune later, which is the trade ADR-0006 makes
 * explicitly.
 *
 * Every consumer of this data therefore has to filter on `isBot` itself. That is a real
 * obligation and the aggregation layer is where it is discharged.
 */
export async function recordClick(link: ResolvedShortLink, context: ClickContext): Promise<void> {
  const occurredAt = context.occurredAt ?? new Date();

  try {
    const userAgent = firstHeader(context.headers, 'user-agent');
    const { ipHash, country } = describeClient(context.ip, context.headers);

    const verdict = classifyClick({
      method: context.method,
      userAgent,
      accept: firstHeader(context.headers, 'accept'),
      publishedAt: link.publishedAt,
      occurredAt,
      isDuplicate: await isDuplicate(link.id, ipHash, occurredAt),
    });

    await getPrisma().linkClick.create({
      data: {
        shortLinkId: link.id,
        occurredAt,
        ipHash,
        country,
        userAgent: userAgent ?? null,
        referrer: firstHeader(context.headers, 'referer') ?? null,
        deviceType: deviceTypeFrom(userAgent),
        isBot: verdict.isBot,
        botReason: verdict.botReason,
      },
    });
  } catch (error) {
    // The visitor already has their redirect. Losing a click is a dent in a number;
    // throwing here would be an unhandled rejection for a request that already succeeded.
    getLogger().error(
      { err: error, shortLinkId: link.id },
      'Failed to record a link click. The redirect was already served.',
    );
  }
}
