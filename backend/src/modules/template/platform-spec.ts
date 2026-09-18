import type { AspectRatio, Platform } from '@prisma/client';

/**
 * What the composer needs to know about each platform it exports for.
 *
 * ## Why this lives here and not in `modules/publish/`
 *
 * docs/08 puts `PlatformSpec` on the `PlatformAdapter`, which is W6's. That is the right
 * long-term home: the adapter knows what its API accepts, and a spec that disagrees with
 * the adapter publishing through it is worse than no spec.
 *
 * W5 ships before any adapter exists and needs the same facts for a screen that never
 * calls a platform API — a character count has to count against something. So this is a
 * deliberately *narrow* read-only table of composer-facing fields only: no auth, no
 * scopes, no capability model, nothing an adapter would own.
 *
 * **W6 should absorb this.** When `PlatformAdapter` lands the adapter becomes the source
 * of truth and this file should be reduced to re-exporting from it. It sits in
 * `template/` rather than `publish/` purely so both workstreams do not create
 * `modules/publish/platform-spec.ts` in parallel and collide.
 *
 * ## Provenance
 *
 * Verified against official developer documentation on 2026-09-18, cited per field. Every
 * number is the *API's* limit, not the web composer's.
 *
 * Two widely-repeated figures turned out **not** to appear in any official doc, and are
 * marked `captionLimitVerified: false` rather than encoded as if they were authoritative:
 *
 *  - Facebook's "63,206 character" `message` limit. Absent from the v23.0 Page Feed
 *    reference, the Pages API posts guide, and the Page Post reference. A conservative
 *    value is used instead, because a counter that is too generous fails at publish time
 *    and a counter that is slightly mean only nags.
 *  - X's "25,000 character" Premium long-post limit. Long-form posts are acknowledged to
 *    exist but no number is published, and `POST /2/tweets` declares no `maxLength` at
 *    all. The standard 280 is used; W6 can raise it per credential once it knows the
 *    account's tier.
 *
 * Working rule 7 applies: re-verify rather than trust this comment. Meta in particular is
 * mid-migration from `/docs/` to `/documentation/` and moves these pages.
 */

export type LinkBehavior = 'inline' | 'bio-only' | 'first-comment';

/**
 * How a platform counts a caption.
 *
 * Not cosmetic, and the reason this is an enum rather than an assumption: "character
 * counts match the real per-platform limits" is a W5 acceptance criterion, and three of
 * the four platforms disagree with `String.length`.
 */
export type CaptionCountUnit =
  /** One code point, one unit. */
  | 'codepoints'
  /** X's weighted length: emoji and CJK count double, every URL counts as exactly 23. */
  | 'x-weighted'
  /** Threads: "emojis are counted as the number of UTF-8 bytes". */
  | 'utf8-bytes';

export interface PlatformSpec {
  readonly platform: Platform;
  /** For UI copy. `Platform` is SCREAMING_CASE and nobody wants to read that. */
  readonly label: string;
  readonly captionMaxLength: number;
  /** False when the limit is a conservative guess because no official source states one. */
  readonly captionLimitVerified: boolean;
  readonly captionCountUnit: CaptionCountUnit;
  /** Every ratio the platform accepts anywhere — feed, Stories or Reels. */
  readonly supportedRatios: readonly AspectRatio[];
  /**
   * The subset valid as an ordinary **feed** post.
   *
   * Instagram is the reason this field exists: its documented feed range is 4:5 to
   * 1.91:1, so a 9:16 image is a Story or a Reel and is rejected as a feed post. Offering
   * one ratio list would mean either hiding a rendition people want or quietly producing
   * an image Instagram refuses.
   */
  readonly feedRatios: readonly AspectRatio[];
  readonly mediaRequired: boolean;
  readonly hashtagLimit?: number;
  /** Maximum URLs in the body, where the platform documents one. */
  readonly maxLinks?: number;
  /**
   * Whether a URL in the caption body is clickable.
   *
   * The one field here that is not cosmetic. W7's short links only produce click data if
   * the link is followable, so a `bio-only` platform needs the user told *before* they
   * place a `{{link}}` marker, not after the post is live and the clicks never arrive.
   */
  readonly linkBehavior: LinkBehavior;
  /** Shown next to the link warning, so the guidance is actionable rather than a shrug. */
  readonly linkNote?: string;
}

/**
 * The four v1 platforms (ADR-0005).
 *
 * LinkedIn, TikTok and YouTube exist in the `Platform` enum and are deliberately absent:
 * v1 does not publish to them, and a caption limit for a platform the product cannot
 * export for is a promise the rest of the app does not keep.
 */
export const PLATFORM_SPECS = {
  INSTAGRAM: {
    platform: 'INSTAGRAM',
    label: 'Instagram',
    // developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media
    // "Maximum 2200 characters, 30 hashtags, and 20 @ tags."
    captionMaxLength: 2200,
    captionLimitVerified: true,
    captionCountUnit: 'codepoints',
    hashtagLimit: 30,
    // Feed images must fall within 4:5 to 1.91:1, so 9:16 is Stories/Reels only.
    supportedRatios: ['SQUARE_1_1', 'PORTRAIT_4_5', 'STORY_9_16', 'LANDSCAPE_16_9'],
    feedRatios: ['SQUARE_1_1', 'PORTRAIT_4_5', 'LANDSCAPE_16_9'],
    mediaRequired: true,
    linkBehavior: 'bio-only',
    // Observed behaviour, NOT documented: no Meta developer doc states that feed-caption
    // URLs are non-clickable, and the Help Center pages that discuss it are JS-rendered.
    // It is nonetheless true, and the cost of being wrong in the other direction — a user
    // trusting a caption link nobody can click — is far higher than an unnecessary hint.
    linkNote:
      'Instagram does not make links in a feed caption clickable. Put the link in your ' +
      'bio or the first comment, and say “link in bio” in the caption.',
  },
  FACEBOOK: {
    platform: 'FACEBOOK',
    label: 'Facebook',
    // NOT officially documented — see the provenance note above. The Page Feed reference
    // describes `message` only as "the status message in the post" and states no limit.
    // 5,000 is a deliberately conservative stand-in: far above any real social caption,
    // far below the folklore figure, and flagged so nobody mistakes it for a fact.
    captionMaxLength: 5000,
    captionLimitVerified: false,
    captionCountUnit: 'codepoints',
    // Also undocumented. The photos endpoint states file type and size limits only, and
    // notes Facebook resizes images itself — so this is "no known constraint", which is
    // not the same as a documented guarantee.
    supportedRatios: ['SQUARE_1_1', 'PORTRAIT_4_5', 'STORY_9_16', 'LANDSCAPE_16_9'],
    feedRatios: ['SQUARE_1_1', 'PORTRAIT_4_5', 'LANDSCAPE_16_9'],
    // Page Feed: "Either `link` or `message` must be supplied."
    mediaRequired: false,
    linkBehavior: 'inline',
  },
  THREADS: {
    platform: 'THREADS',
    label: 'Threads',
    // developers.facebook.com/docs/threads/posts — "Text posts are limited to 500 characters."
    captionMaxLength: 500,
    captionLimitVerified: true,
    // Same page: "Emojis are counted as the number of UTF-8 bytes."
    captionCountUnit: 'utf8-bytes',
    // "Aspect Ratio Limit: 10:1" — every ratio here is comfortably inside it.
    supportedRatios: ['SQUARE_1_1', 'PORTRAIT_4_5', 'STORY_9_16', 'LANDSCAPE_16_9'],
    feedRatios: ['SQUARE_1_1', 'PORTRAIT_4_5', 'STORY_9_16', 'LANDSCAPE_16_9'],
    mediaRequired: false,
    // "Starting December 22, 2025, Threads posts containing more than 5 links will fail."
    maxLinks: 5,
    linkBehavior: 'inline',
    linkNote: 'The first link in the text becomes the post’s preview card.',
  },
  X: {
    platform: 'X',
    label: 'X',
    // docs.x.com/fundamentals/counting-characters — "Posts on X can contain up to 280
    // characters", weighted. Premium raises it; no official number is published, so the
    // conservative limit is the correct default for everyone.
    captionMaxLength: 280,
    captionLimitVerified: true,
    captionCountUnit: 'x-weighted',
    // Not documented for still images: the ratio and dimension bounds people cite are in
    // the *video* section of the media best-practices page. Treated as unconstrained.
    supportedRatios: ['SQUARE_1_1', 'PORTRAIT_4_5', 'STORY_9_16', 'LANDSCAPE_16_9'],
    feedRatios: ['SQUARE_1_1', 'PORTRAIT_4_5', 'STORY_9_16', 'LANDSCAPE_16_9'],
    // "text — Required unless media is provided."
    mediaRequired: false,
    linkBehavior: 'inline',
    linkNote: 'X counts every link as 23 characters, however long the URL really is.',
  },
} as const satisfies Partial<Record<Platform, PlatformSpec>>;

export type SupportedPlatform = keyof typeof PLATFORM_SPECS;

export const SUPPORTED_PLATFORMS = Object.keys(PLATFORM_SPECS) as SupportedPlatform[];

export function isSupportedPlatform(value: string): value is SupportedPlatform {
  return value in PLATFORM_SPECS;
}

export function specFor(platform: SupportedPlatform): PlatformSpec {
  return PLATFORM_SPECS[platform];
}

/**
 * Every ratio at least one of the named platforms can use.
 *
 * The gallery filters by platform, and "templates I could post to Threads" means
 * templates supporting *a* ratio Threads accepts — not all of them. Intersecting instead
 * would return nothing for any template that omits a single ratio.
 */
export function ratiosForPlatforms(platforms: readonly SupportedPlatform[]): AspectRatio[] {
  const ratios = new Set<AspectRatio>();
  for (const platform of platforms) {
    for (const ratio of PLATFORM_SPECS[platform].supportedRatios) ratios.add(ratio);
  }
  return [...ratios];
}

// ─── Caption counting ────────────────────────────────────────────────────────────

/** A URL costs a fixed 23 on X, whatever its real length, because of t.co wrapping. */
const X_URL_WEIGHT = 23;

const URL_PATTERN = /https?:\/\/\S+/gi;

/**
 * Code points a platform charges double for.
 *
 * X's documented weighting charges 2 for anything outside a set of Latin and common
 * punctuation ranges, which in practice means emoji and CJK. This approximates that with
 * the ranges that actually occur in captions rather than transcribing the full table;
 * `twitter-text`'s `parseTweet().weightedLength` is the exact implementation if this ever
 * needs to be precise to the character.
 */
function isDoubleWeight(codePoint: number): boolean {
  return (
    // CJK, Hiragana, Katakana, Hangul.
    (codePoint >= 0x1100 && codePoint <= 0x11ff) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    // Emoji and pictographs.
    (codePoint >= 0x1f000 && codePoint <= 0x1ffff) ||
    (codePoint >= 0x2600 && codePoint <= 0x27bf)
  );
}

/**
 * How long a caption is, *as the platform counts it*.
 *
 * `String.length` is wrong on all three counts that matter: it counts a surrogate pair as
 * two, it does not know a URL is 23 on X, and it has never heard of UTF-8 bytes. A
 * counter reading 270/280 while X rejects the post is worse than no counter, because the
 * user believes it.
 */
export function countCaption(platform: SupportedPlatform, text: string): number {
  const unit = PLATFORM_SPECS[platform].captionCountUnit;

  if (unit === 'utf8-bytes') {
    // Threads: emoji cost their UTF-8 byte count. Plain ASCII is unaffected, which is why
    // this matches `length` for most captions and diverges exactly where it matters.
    return Buffer.byteLength(text, 'utf8');
  }

  if (unit === 'x-weighted') {
    let weighted = 0;
    const withoutUrls = text.replace(URL_PATTERN, () => {
      weighted += X_URL_WEIGHT;
      return '';
    });

    for (const character of withoutUrls) {
      weighted += isDoubleWeight(character.codePointAt(0) ?? 0) ? 2 : 1;
    }

    return weighted;
  }

  // Code points, not UTF-16 units: an emoji is one character to Instagram, not two.
  return [...text].length;
}

export interface CaptionCount {
  used: number;
  limit: number;
  remaining: number;
  over: boolean;
}

export function measureCaption(platform: SupportedPlatform, text: string): CaptionCount {
  const limit = PLATFORM_SPECS[platform].captionMaxLength;
  const used = countCaption(platform, text);
  return { used, limit, remaining: limit - used, over: used > limit };
}
