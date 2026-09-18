import { getConfig } from '../../platform/config';
import {
  PLATFORM_SPECS,
  measureCaption,
  type CaptionCount,
  type SupportedPlatform,
} from '../template/platform-spec';
import { LINK_MARKER } from '../post/post.schemas';
import { SLUG_LENGTH } from './slug';

/**
 * Putting a tracked link into a caption.
 *
 * ## The bug this file exists to prevent
 *
 * Injecting a link makes a caption longer. If the composer measures the caption *without*
 * the link and publish measures it *with* one, then a caption can pass every check the
 * user sees and be rejected by the platform hours later, in a job, at a scheduled slot
 * nobody is watching. This project has already shipped that class of bug once — the
 * composer promising something publish would refuse — which is why the caption gate was
 * moved to schedule time in the first place.
 *
 * ## How it is prevented, structurally
 *
 * Not by remembering to add 30 in two places. `substituteLink()` is the *only* function
 * that turns a caption-with-placeholder into a caption-to-publish, and both the
 * measurement path and the publish path call it. Measurement passes a synthetic URL;
 * publish passes the real one. They cannot take different code paths because there is
 * only one.
 *
 * The synthetic URL is built from the same `baseUrl` and the same `SLUG_LENGTH` the real
 * one is, so it is not merely the same length by arithmetic — it is the same length by
 * construction, and a change to either constant moves both together. There is no number
 * here that can drift out of step with reality.
 */

/**
 * What a user types to say "put the tracked link here".
 *
 * **Re-exported from W5's `post.schemas.ts`, never redeclared.** The comment there is
 * explicit that the composer and the caption generator must agree on the exact spelling,
 * because a generator emitting `{link}` against a replacer looking for `{{link}}` fails
 * silently — and the failure is invisible until nobody's clicks are attributed. A second
 * constant in this file would be that bug waiting for one of the two to be edited.
 */
export { LINK_MARKER };

/** Every occurrence, not just the first — a user may paste the placeholder twice. */
const PLACEHOLDER_PATTERN = /\{\{\s*link\s*\}\}/g;

export function hasLinkPlaceholder(caption: string): boolean {
  PLACEHOLDER_PATTERN.lastIndex = 0;
  return PLACEHOLDER_PATTERN.test(caption);
}

/**
 * A stand-in of exactly the same length and shape as a real short link.
 *
 * Built from the real `baseUrl` and a slug of the real `SLUG_LENGTH`, so it matches the
 * URL pattern X uses to apply its flat 23-character weighting *and* has the exact
 * character count every other platform will see. Measuring with this is measuring the
 * real thing.
 */
export function syntheticLink(): string {
  return `${getConfig().link.baseUrl}/${'a'.repeat(SLUG_LENGTH)}`;
}

/**
 * Turn a caption containing the placeholder into the caption that will be published.
 *
 * **The single source of truth for what publishing does to a caption.** Measurement and
 * publication both go through here; see the file comment for why that is the whole point.
 *
 * On a `bio-only` platform the placeholder is *removed* rather than replaced. Instagram
 * does not linkify caption URLs, so injecting one would produce a caption containing a
 * string of characters no reader can click — it would consume caption budget and deliver
 * nothing. The surrounding whitespace is tidied so removal does not leave a double space
 * or a trailing gap.
 */
export function substituteLink(
  platform: SupportedPlatform,
  caption: string,
  url: string,
): string {
  // Two different reasons to end up with no URL, one correct behaviour. A `bio-only`
  // platform will not linkify a caption URL, and an empty `url` means the caller had no
  // destination to offer. Either way the marker comes out, and the space it was sitting
  // in comes out with it — `See {{link}} today` must not publish as `See  today`, which
  // is a visible typo in live copy.
  if (url === '' || PLATFORM_SPECS[platform].linkBehavior === 'bio-only') {
    return caption
      .replace(PLACEHOLDER_PATTERN, '')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/[ \t]+$/gm, '')
      .trim();
  }

  return caption.replace(PLACEHOLDER_PATTERN, url);
}

/**
 * Measure a caption as it will be *after* the link goes in.
 *
 * This is what the composer, the schedule gate and the publish path must all agree on.
 * A caption with no placeholder measures exactly as it does today, so this is safe to use
 * unconditionally and there is no "did we remember to call the link-aware one" branch for
 * anybody to get wrong.
 */
export function measureWithLink(platform: SupportedPlatform, caption: string): CaptionCount {
  return measureCaption(platform, substituteLink(platform, caption, syntheticLink()));
}

/**
 * Does this platform get a link in the caption at all?
 *
 * A `bio-only` platform still gets a `ShortLink` created — Instagram traffic is real and
 * arrives through the profile link, so the row has to exist for those clicks to have
 * somewhere to land. What it does not get is an injected caption URL.
 */
export function acceptsInlineLink(platform: SupportedPlatform): boolean {
  return PLATFORM_SPECS[platform].linkBehavior !== 'bio-only';
}
