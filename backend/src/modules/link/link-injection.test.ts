import { describe, expect, it } from 'vitest';
import {
  acceptsInlineLink,
  hasLinkPlaceholder,
  measureWithLink,
  substituteLink,
  syntheticLink,
} from './link-injection';
import { LINK_MARKER } from '../post/post.schemas';
import { shortLinkLength } from './shortlink.service';
import { SLUG_LENGTH, generateSlug } from './slug';
import { measureCaption, type SupportedPlatform } from '../template/platform-spec';

const PLATFORMS: SupportedPlatform[] = ['X', 'FACEBOOK', 'INSTAGRAM', 'THREADS'];

/** A real short link for this deployment, with a real random slug. */
function realLink(): string {
  return `${process.env.APP_URL}/s/${generateSlug()}`;
}

describe('hasLinkPlaceholder', () => {
  it('finds the placeholder', () => {
    expect(hasLinkPlaceholder(`Read more: ${LINK_MARKER}`)).toBe(true);
  });

  it('tolerates inner whitespace', () => {
    expect(hasLinkPlaceholder('Read more: {{ link }}')).toBe(true);
  });

  it('is false for a caption without one', () => {
    expect(hasLinkPlaceholder('Read more at our website')).toBe(false);
  });

  /**
   * The pattern is global, and a global regex carries `lastIndex` between calls. Without
   * the reset in `hasLinkPlaceholder`, the second identical call returns false — a bug
   * that only appears on the second call and would be maddening to find in production.
   */
  it('gives the same answer when asked twice', () => {
    const caption = `Read more: ${LINK_MARKER}`;
    expect(hasLinkPlaceholder(caption)).toBe(true);
    expect(hasLinkPlaceholder(caption)).toBe(true);
    expect(hasLinkPlaceholder(caption)).toBe(true);
  });
});

describe('syntheticLink', () => {
  it('is exactly as long as a real short link', () => {
    expect(syntheticLink().length).toBe(shortLinkLength());
    expect(syntheticLink().length).toBe(realLink().length);
  });

  /**
   * X charges a flat 23 for anything matching its URL pattern. A synthetic that did not
   * match would be counted character by character, and the measurement would disagree
   * with the real thing by exactly the amount that matters.
   */
  it('looks like a URL, so X weights it as one', () => {
    expect(syntheticLink()).toMatch(/^https?:\/\/\S+$/);
  });
});

describe('substituteLink', () => {
  it.each(['X', 'FACEBOOK', 'THREADS'] as const)('injects the link for %s', (platform) => {
    const url = realLink();
    expect(substituteLink(platform, `Read more: ${LINK_MARKER}`, url)).toBe(
      `Read more: ${url}`,
    );
  });

  it('replaces every occurrence, not only the first', () => {
    const url = realLink();
    const result = substituteLink('X', `${LINK_MARKER} and ${LINK_MARKER}`, url);
    expect(result).toBe(`${url} and ${url}`);
    expect(result).not.toContain(LINK_MARKER);
  });

  it('leaves a caption with no placeholder untouched', () => {
    const caption = 'Just a caption.';
    expect(substituteLink('X', caption, realLink())).toBe(caption);
  });

  /**
   * Instagram does not linkify caption URLs. Injecting one would spend caption budget on
   * characters no reader can click, so the placeholder is removed instead — and the
   * `ShortLink` still exists, because Instagram traffic arrives through the profile link
   * and those clicks need somewhere to land.
   */
  it('removes the placeholder on Instagram rather than injecting an unclickable URL', () => {
    const url = realLink();
    const result = substituteLink('INSTAGRAM', `Read more: ${LINK_MARKER}`, url);

    expect(result).not.toContain(url);
    expect(result).not.toContain(LINK_MARKER);
    expect(result).toBe('Read more:');
  });

  it('does not leave a double space behind on Instagram', () => {
    expect(substituteLink('INSTAGRAM', `Before ${LINK_MARKER} after`, realLink())).toBe(
      'Before after',
    );
  });
});

describe('measureWithLink', () => {
  /**
   * ## The invariant this whole module exists for
   *
   * What the composer measures must equal what publishing produces. If these two numbers
   * can differ by even one character, a caption can pass every check the user sees and be
   * rejected hours later inside a job.
   *
   * This asserts it against a *real* slug rather than the synthetic one, which is the
   * only version of the question that matters: the synthetic agreeing with itself would
   * be a tautology.
   */
  it.each(PLATFORMS)('measures %s exactly as the published caption will measure', (platform) => {
    const caption = `Our new guide is live. Read it here: ${LINK_MARKER} — worth a look.`;

    for (let attempt = 0; attempt < 50; attempt += 1) {
      const published = substituteLink(platform, caption, realLink());
      expect(measureWithLink(platform, caption).used).toBe(measureCaption(platform, published).used);
    }
  });

  /**
   * Positive control. Without it, a `measureWithLink` that ignored the placeholder
   * entirely would satisfy the invariant above on any platform where substitution also
   * did nothing — two wrongs agreeing.
   */
  it.each(['X', 'FACEBOOK', 'THREADS'] as const)(
    'counts more for %s with a link than without',
    (platform) => {
      const withPlaceholder = `Read more: ${LINK_MARKER}`;
      const withoutLink = 'Read more: ';

      expect(measureWithLink(platform, withPlaceholder).used).toBeGreaterThan(
        measureCaption(platform, withoutLink).used,
      );
    },
  );

  it('measures a caption with no placeholder identically to the plain measurement', () => {
    for (const platform of PLATFORMS) {
      const caption = 'No link here at all.';
      expect(measureWithLink(platform, caption)).toEqual(measureCaption(platform, caption));
    }
  });

  /**
   * The composer-promises-what-publish-rejects case, stated as an assertion.
   *
   * A caption sized to sit just under the limit *before* injection goes over *after* it.
   * The gate has to see the second number. Measuring the raw caption would pass this and
   * the publish would fail.
   */
  it('reports over-length for a caption that only overflows once the link is added', () => {
    const platform: SupportedPlatform = 'X';
    const limit = measureCaption(platform, '').limit;

    // Fill to exactly the limit, then swap the tail for the placeholder. The raw text is
    // now comfortably under; the published text will not be.
    const filler = 'a'.repeat(limit - LINK_MARKER.length);
    const caption = `${filler}${LINK_MARKER}`;

    expect(measureCaption(platform, caption).over).toBe(false);
    expect(measureWithLink(platform, caption).over).toBe(true);
  });

  /**
   * And the mirror image, which is the reason the Instagram branch removes rather than
   * injects: a caption that fits on Instagram must not be reported as over-length because
   * of a link Instagram will never show.
   */
  it('does not charge Instagram for a link it will not render', () => {
    const caption = `Read more: ${LINK_MARKER}`;
    expect(measureWithLink('INSTAGRAM', caption).used).toBeLessThan(
      measureWithLink('FACEBOOK', caption).used,
    );
  });
});

describe('acceptsInlineLink', () => {
  it('is false only for Instagram', () => {
    expect(acceptsInlineLink('INSTAGRAM')).toBe(false);
    expect(acceptsInlineLink('X')).toBe(true);
    expect(acceptsInlineLink('FACEBOOK')).toBe(true);
    expect(acceptsInlineLink('THREADS')).toBe(true);
  });
});

describe('the length constant cannot drift', () => {
  /**
   * `shortLinkLength()` is arithmetic over two constants, and arithmetic can be wrong.
   * This checks it against a genuinely generated slug rather than against the same
   * arithmetic restated.
   */
  it('agrees with a real generated link', () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      expect(realLink().length).toBe(shortLinkLength());
    }
  });

  it('a slug really is SLUG_LENGTH characters', () => {
    expect(generateSlug()).toHaveLength(SLUG_LENGTH);
  });
});
