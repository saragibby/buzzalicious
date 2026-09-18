import { describe, expect, it } from 'vitest';
import {
  PLATFORM_SPECS,
  SUPPORTED_PLATFORMS,
  countCaption,
  isSupportedPlatform,
  measureCaption,
  ratiosForPlatforms,
} from './platform-spec';

/**
 * The spec table and the caption counter.
 *
 * These numbers are shown to users as "you have N characters left" and then enforced by a
 * platform that did not read our UI. So the tests pin the *documented* values and the
 * counting rules, not whatever the implementation happens to do — a test that read the
 * limit out of the table and compared it to itself would pass no matter what the table
 * said, which is exactly the failure mode this repo keeps hitting.
 */

describe('PLATFORM_SPECS', () => {
  it('covers exactly the four v1 platforms', () => {
    // LinkedIn, TikTok and YouTube exist in the Platform enum and must stay out: a caption
    // limit for a platform the product cannot export for is a promise nothing keeps.
    expect(SUPPORTED_PLATFORMS.sort()).toEqual(['FACEBOOK', 'INSTAGRAM', 'THREADS', 'X']);
  });

  it('uses the documented caption limits', () => {
    // developers.facebook.com/docs/instagram-platform/.../ig-user/media: "Maximum 2200
    // characters, 30 hashtags, and 20 @ tags."
    expect(PLATFORM_SPECS.INSTAGRAM.captionMaxLength).toBe(2200);
    expect(PLATFORM_SPECS.INSTAGRAM.hashtagLimit).toBe(30);

    // developers.facebook.com/docs/threads/posts: "Text posts are limited to 500 characters."
    expect(PLATFORM_SPECS.THREADS.captionMaxLength).toBe(500);

    // docs.x.com/fundamentals/counting-characters: "up to 280 characters", weighted.
    expect(PLATFORM_SPECS.X.captionMaxLength).toBe(280);
  });

  it('marks a limit unverified when no official source states one', () => {
    // The widely-repeated 63,206 for Facebook appears in no Meta developer document. The
    // value here is a conservative stand-in and the UI says "approximate" because of this
    // flag — if someone later finds a real source and raises the number, they must clear
    // the flag too, or the UI keeps hedging about a documented fact.
    expect(PLATFORM_SPECS.FACEBOOK.captionLimitVerified).toBe(false);
    expect(PLATFORM_SPECS.FACEBOOK.captionMaxLength).toBeLessThan(63_206);

    expect(PLATFORM_SPECS.INSTAGRAM.captionLimitVerified).toBe(true);
    expect(PLATFORM_SPECS.THREADS.captionLimitVerified).toBe(true);
    expect(PLATFORM_SPECS.X.captionLimitVerified).toBe(true);
  });

  it('excludes 9:16 from Instagram feed ratios but keeps it available', () => {
    // Instagram's documented feed range is 4:5 to 1.91:1, so a 9:16 image is a Story or a
    // Reel, not a feed post. Both lists matter: dropping it entirely would hide a
    // rendition people want, and treating it as a feed ratio produces an image Instagram
    // rejects.
    expect(PLATFORM_SPECS.INSTAGRAM.feedRatios).not.toContain('STORY_9_16');
    expect(PLATFORM_SPECS.INSTAGRAM.supportedRatios).toContain('STORY_9_16');
  });

  it('warns that Instagram caption links are not clickable', () => {
    // W7's short links only produce click data if the link is followable. A user has to be
    // told before they place a {{link}} marker, not after the post is live and no clicks
    // ever arrive.
    expect(PLATFORM_SPECS.INSTAGRAM.linkBehavior).toBe('bio-only');
    expect(PLATFORM_SPECS.INSTAGRAM.linkNote).toMatch(/bio/i);

    expect(PLATFORM_SPECS.FACEBOOK.linkBehavior).toBe('inline');
    expect(PLATFORM_SPECS.THREADS.linkBehavior).toBe('inline');
    expect(PLATFORM_SPECS.X.linkBehavior).toBe('inline');
  });

  it('caps Threads links at the documented five', () => {
    // "Starting December 22, 2025, Threads posts containing more than 5 links will fail."
    expect(PLATFORM_SPECS.THREADS.maxLinks).toBe(5);
  });

  it('recognises only the four supported platforms', () => {
    expect(isSupportedPlatform('INSTAGRAM')).toBe(true);
    expect(isSupportedPlatform('LINKEDIN')).toBe(false);
    expect(isSupportedPlatform('nonsense')).toBe(false);
  });
});

describe('ratiosForPlatforms', () => {
  it('unions rather than intersects', () => {
    // "Templates I could post to Instagram or Threads" means templates offering some ratio
    // one of them accepts. Intersecting would return nothing for a template missing a
    // single ratio, which is most of them.
    const ratios = ratiosForPlatforms(['INSTAGRAM', 'THREADS']);
    expect(ratios).toContain('SQUARE_1_1');
    expect(ratios).toContain('STORY_9_16');
    expect(new Set(ratios).size).toBe(ratios.length);
  });

  it('is empty for no platforms, so an unfiltered query is distinguishable', () => {
    expect(ratiosForPlatforms([])).toEqual([]);
  });
});

describe('countCaption', () => {
  it('counts plain ASCII identically everywhere', () => {
    const text = 'Book your spring clean today';
    for (const platform of SUPPORTED_PLATFORMS) {
      expect(countCaption(platform, text)).toBe(text.length);
    }
  });

  it('counts an emoji as one character on Instagram, not two', () => {
    // '🎉'.length === 2 in JavaScript because it is a surrogate pair. Instagram counts
    // code points, so String.length would tell the user they had spent twice what they
    // had.
    expect('🎉'.length).toBe(2);
    expect(countCaption('INSTAGRAM', '🎉')).toBe(1);
    expect(countCaption('FACEBOOK', '🎉')).toBe(1);
  });

  it('counts an emoji as its UTF-8 bytes on Threads', () => {
    // Threads documents exactly this: "Emojis are counted as the number of UTF-8 bytes."
    // '🎉' is four bytes in UTF-8.
    expect(countCaption('THREADS', '🎉')).toBe(4);
    // ASCII is one byte each, so ordinary captions are unaffected — which is precisely why
    // a naive implementation looks correct until someone uses an emoji.
    expect(countCaption('THREADS', 'hello')).toBe(5);
  });

  it('charges a URL a flat 23 on X regardless of its real length', () => {
    // t.co wraps every link, so a 120-character URL and a 25-character one cost the same.
    const short = countCaption('X', 'https://a.co');
    const long = countCaption('X', `https://example.com/${'x'.repeat(200)}`);

    expect(short).toBe(23);
    expect(long).toBe(23);
  });

  it('charges CJK and emoji double on X', () => {
    expect(countCaption('X', 'あ')).toBe(2);
    expect(countCaption('X', '🎉')).toBe(2);
    expect(countCaption('X', 'a')).toBe(1);
  });

  it('counts a URL literally on the platforms that do not wrap them', () => {
    const url = 'https://example.com/a-long-path-that-is-definitely-more-than-23-chars';
    expect(countCaption('INSTAGRAM', url)).toBe(url.length);
    expect(countCaption('X', url)).toBe(23);
  });
});

describe('measureCaption', () => {
  it('reports the limit from the spec table, not from the caller', () => {
    const measured = measureCaption('X', 'hello');
    expect(measured.limit).toBe(PLATFORM_SPECS.X.captionMaxLength);
    expect(measured.used).toBe(5);
    expect(measured.remaining).toBe(275);
    expect(measured.over).toBe(false);
  });

  it('flags over-limit using the weighted count, not the string length', () => {
    // 140 CJK characters is 140 by String.length and 280 by X's weighting — exactly at the
    // limit. One more is over, and a naive counter would still be reporting 141/280.
    const atLimit = 'あ'.repeat(140);
    const overLimit = 'あ'.repeat(141);

    expect(atLimit.length).toBe(140);
    expect(measureCaption('X', atLimit).over).toBe(false);
    expect(measureCaption('X', overLimit).over).toBe(true);
    expect(measureCaption('X', overLimit).used).toBe(282);
  });
});
