import type { PlatformSpec } from './composerApi';

/**
 * Caption length, as each platform counts it.
 *
 * ## Why this is duplicated from the backend
 *
 * `backend/src/modules/template/platform-spec.ts` has the same functions. That is not an
 * oversight and not laziness: the two workspaces are separate npm packages with no shared
 * one between them, and a counter that has to round-trip to the server cannot run on a
 * keystroke.
 *
 * The duplication is contained in two ways. The *numbers* — limits, units, link behaviour
 * — are served by `GET /api/platforms`, so there is exactly one source for them and this
 * file never hard-codes a limit. Only the counting *algorithm* is written twice, and both
 * copies are pinned to the same documented fixtures (`captionCount.test.ts` here,
 * `platform-spec.test.ts` there), so a change to one that is not made to the other turns a
 * test red rather than showing the user a different number from the one that will be
 * enforced.
 *
 * ## Why not `String.length`
 *
 * It is wrong for three of the four v1 platforms, and wrong in the direction that hurts:
 * it counts an emoji as two where Instagram counts one, ignores that Threads charges
 * UTF-8 bytes, and has never heard of X billing every URL at a flat 23. A counter reading
 * "270/280" while X rejects the post is worse than no counter, because the user believes
 * it.
 */

/** A URL costs a fixed 23 on X, whatever its real length, because of t.co wrapping. */
const X_URL_WEIGHT = 23;

const URL_PATTERN = /https?:\/\/\S+/gi;

/**
 * Code points X charges double for.
 *
 * X's documented weighting charges 2 for anything outside a set of Latin and common
 * punctuation ranges, which in practice means emoji and CJK. This mirrors the backend
 * implementation range for range; if it ever needs to be exact to the character,
 * `twitter-text`'s `parseTweet().weightedLength` is the reference.
 */
function isDoubleWeight(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x11ff) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0x1f000 && codePoint <= 0x1ffff) ||
    (codePoint >= 0x2600 && codePoint <= 0x27bf)
  );
}

function utf8Bytes(text: string): number {
  // `TextEncoder` rather than `Buffer`: this runs in a browser, where `Buffer` does not
  // exist. It is the same count.
  return new TextEncoder().encode(text).length;
}

export function countCaption(unit: PlatformSpec['captionCountUnit'], text: string): number {
  if (unit === 'utf8-bytes') {
    return utf8Bytes(text);
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

/**
 * Measure a caption against a spec served by the API.
 *
 * Takes the whole spec rather than a platform name so the limit can only come from the
 * server's table. A signature taking `(platform, text)` would invite a local lookup, and
 * a local lookup is how the two numbers drift apart.
 */
export function measureCaption(spec: PlatformSpec, text: string): CaptionCount {
  const used = countCaption(spec.captionCountUnit, text);
  return {
    used,
    limit: spec.captionMaxLength,
    remaining: spec.captionMaxLength - used,
    over: used > spec.captionMaxLength,
  };
}

/** How many URLs a caption contains, for platforms that cap them (Threads: 5). */
export function countLinks(text: string): number {
  return text.match(URL_PATTERN)?.length ?? 0;
}
