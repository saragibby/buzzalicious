import { Prisma, type Platform } from '@prisma/client';
import { getConfig } from '../../platform/config';
import { getPrisma } from '../../platform/db';
import { ValidationError } from '../../platform/errors';
import { SLUG_LENGTH, generateUniqueSlug } from './slug';

/**
 * Creating and resolving first-party short links.
 *
 * ## Why these are first-party (ADR-0006)
 *
 * A third-party shortener would mean the click data that the entire feedback loop rests
 * on lives in someone else's database, on their retention policy, behind their export
 * API. The outcome signal is the product's differentiator; renting it is not an option.
 *
 * ## The one invariant
 *
 * **Exactly one `ShortLink` per `(postId, platform)`.** That pairing *is* the
 * per-platform attribution mechanism: a click's platform is known because the slug it
 * arrived on belongs to one platform's copy of the post. Two rows for one pairing splits
 * a post's click stream in half and silently under-reports both.
 *
 * The database enforces it with a unique index rather than this module enforcing it by
 * being careful, because get-or-create genuinely races here — pg-boss is at-least-once,
 * and the publish path and a retry can reach the same target concurrently.
 */

/** Schemes we will ever redirect to. Anything else is an open-redirect vector. */
const SAFE_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Reject anything we would not be willing to send a real person to.
 *
 * A short link is an *unauthenticated redirect under our own domain*, which is precisely
 * the shape of an open-redirect vulnerability: `javascript:` would execute in the
 * visitor's context, and `data:`/`file:` are equally not destinations. Validating at
 * write time is the primary defence; the redirector validates again at read time, because
 * a row written before this function existed would otherwise bypass it entirely.
 */
export function assertSafeDestination(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ValidationError(`Destination is not a valid absolute URL: ${url}`);
  }

  if (!SAFE_PROTOCOLS.has(parsed.protocol)) {
    throw new ValidationError(
      `Destination must be http or https, received "${parsed.protocol}". A short link is ` +
        'an unauthenticated redirect on our own domain, so anything else is an open-redirect.',
    );
  }

  return parsed;
}

/** The public URL a slug is reachable at. */
export function shortLinkUrl(slug: string): string {
  return `${getConfig().link.baseUrl}/${slug}`;
}

/**
 * The exact character length of any short link this deployment emits.
 *
 * Exported because caption-length gating consumes it. `baseUrl` is fixed per deployment
 * and `SLUG_LENGTH` is a constant, so the length of an injected link is knowable *before*
 * the slug exists — which is what lets the composer, the schedule gate and publish all
 * agree on whether a caption fits. See `link-injection.ts`.
 */
export function shortLinkLength(): number {
  // +1 for the '/' between the base and the slug.
  return getConfig().link.baseUrl.length + 1 + SLUG_LENGTH;
}

export interface ShortLinkRequest {
  readonly brandId: string;
  readonly postId: string;
  readonly platform: Platform;
  readonly destinationUrl: string;
  readonly expiresAt?: Date | null;
}

/**
 * Get the short link for one `(post, platform)`, creating it if absent.
 *
 * ## Why the race is handled by catching rather than by locking
 *
 * The obvious shape — `findFirst` then `create` — has a window between the two calls in
 * which a concurrent caller can insert. Under pg-boss's at-least-once delivery that
 * window is reached in practice, not just in theory. Rather than serialise every caller
 * to close it, we let the unique index arbitrate and treat P2002 as "someone else won,
 * read their row". The loser of the race returns the same link the winner created, which
 * is exactly the desired outcome.
 *
 * The re-read after P2002 is not defensive padding: without it the caller gets an
 * exception for a link that demonstrably exists.
 *
 * The initial `findFirst` is a **pure optimisation** and deliberately so. Deleting it
 * leaves behaviour identical — every call would fall through to `create`, take the P2002
 * branch and return the same winning row — which a mutation run confirmed by surviving.
 * It is kept because the steady state is "the link already exists", and paying for a
 * failed insert plus a re-read on every publish retry is wasteful, not because anything
 * depends on it.
 */
export async function getOrCreateShortLink(request: ShortLinkRequest) {
  const db = getPrisma();
  assertSafeDestination(request.destinationUrl);

  const existing = await db.shortLink.findFirst({
    where: { postId: request.postId, platform: request.platform },
  });
  if (existing) return existing;

  const slug = await generateUniqueSlug(async (candidate) => {
    const hit = await db.shortLink.findUnique({ where: { slug: candidate } });
    return hit !== null;
  });

  try {
    return await db.shortLink.create({
      data: {
        slug,
        brandId: request.brandId,
        postId: request.postId,
        platform: request.platform,
        destinationUrl: request.destinationUrl,
        expiresAt: request.expiresAt ?? null,
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const winner = await db.shortLink.findFirst({
        where: { postId: request.postId, platform: request.platform },
      });
      // A P2002 on this table is either the (postId, platform) index or the slug index.
      // If it was the slug, there is no winner to return and the error is genuine.
      if (winner) return winner;
    }
    throw error;
  }
}

export interface ResolvedShortLink {
  readonly id: string;
  readonly brandId: string;
  readonly postId: string | null;
  readonly platform: Platform | null;
  readonly destinationUrl: string;
  readonly expiresAt: Date | null;
  readonly publishedAt: Date | null;
}

/**
 * Look up a slug for the redirector.
 *
 * ## Why this reads unscoped
 *
 * A click arrives from a stranger on the public internet: no session, no workspace, no
 * tenant to scope by. This is genuine system work in the sense `tenancy.ts` means it, and
 * the row's own `brandId` re-establishes the tenant for everything written afterwards.
 *
 * The safety argument is that this returns exactly one row addressed by a unique
 * cryptographically-random slug. There is no filter for a tenancy bug to widen — a caller
 * cannot ask for "all short links" through this function.
 *
 * `publishedAt` comes along because the bot filter's time-proximity layer needs it, and
 * fetching it here avoids a second query on the hot path.
 *
 * It is read from the **matching `PostTarget`**, not the post, for two reasons. `Post` has
 * no `publishedAt` at all — publication is per platform, because a post can go live on X
 * on Tuesday and Instagram on Thursday. And it is the right semantic regardless: the
 * preview-crawler burst this filter exists to catch happens when *this platform's* copy
 * goes live, so that is the instant to measure proximity against. `PostTarget` carries
 * the same `@@unique([postId, platform])` as `ShortLink`, so the pairing is exact.
 */
export async function resolveSlug(slug: string): Promise<ResolvedShortLink | null> {
  const row = await getPrisma().shortLink.findUnique({
    where: { slug },
    select: {
      id: true,
      brandId: true,
      postId: true,
      platform: true,
      destinationUrl: true,
      expiresAt: true,
      post: {
        select: {
          targets: {
            select: { platform: true, publishedAt: true },
          },
        },
      },
    },
  });

  if (!row) return null;

  // A ShortLink with a null platform has no single target to match, so there is no
  // publication instant to measure against and proximity simply cannot fire. That is the
  // correct outcome rather than a gap: without a platform there was no preview burst.
  const target = row.platform
    ? row.post?.targets.find((candidate) => candidate.platform === row.platform)
    : undefined;

  return {
    id: row.id,
    brandId: row.brandId,
    postId: row.postId,
    platform: row.platform,
    destinationUrl: row.destinationUrl,
    expiresAt: row.expiresAt,
    publishedAt: target?.publishedAt ?? null,
  };
}
