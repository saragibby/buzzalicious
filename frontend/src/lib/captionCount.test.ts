import { describe, expect, it } from 'vitest';
import {
  countCaption,
  countLinks,
  measureCaption,
  measureCaptionWithLink,
  substituteLinkForCount,
} from './captionCount';
import type { PlatformSpec } from './composerApi';

/**
 * The browser half of caption counting.
 *
 * These fixtures are deliberately the same ones as
 * `backend/src/modules/template/platform-spec.test.ts`. The counting algorithm exists
 * twice because the two workspaces share no package and a per-keystroke counter cannot
 * round-trip to the server; pinning both copies to identical documented cases is what
 * stops them drifting. If you change one of these numbers, the backend test should go red
 * too — if it does not, the user is being shown a different count from the one that will
 * actually be enforced.
 *
 * Every expectation below is a *documented platform rule*, not a restatement of what
 * `captionCount.ts` happens to do.
 */

function spec(overrides: Partial<PlatformSpec>): PlatformSpec {
  return {
    platform: 'INSTAGRAM',
    label: 'Instagram',
    captionMaxLength: 2200,
    captionLimitVerified: true,
    captionCountUnit: 'codepoints',
    feedRatios: ['SQUARE_1_1'],
    supportedRatios: ['SQUARE_1_1'],
    mediaRequired: true,
    hashtagLimit: 30,
    linkBehavior: 'bio-only',
    ...overrides,
  } as PlatformSpec;
}

describe('countCaption', () => {
  describe('code points (Instagram, Facebook)', () => {
    it('counts an emoji as one character, not two', () => {
      // 😀 is a surrogate pair, so `String.length` says 2. Instagram counts 1. The
      // difference shows up as a counter that says the caption is over when it is not.
      expect('😀'.length).toBe(2);
      expect(countCaption('codepoints', '😀')).toBe(1);
    });

    it('counts a family emoji by its joined code points', () => {
      const family = '👨‍👩‍👧';
      expect(countCaption('codepoints', family)).toBe([...family].length);
    });

    it('counts plain text the obvious way', () => {
      expect(countCaption('codepoints', 'hello')).toBe(5);
    });
  });

  describe('UTF-8 bytes (Threads)', () => {
    it('charges four bytes for an emoji', () => {
      // Threads' 500 limit is in bytes. An emoji-heavy caption hits it far sooner than a
      // character count suggests.
      expect(countCaption('utf8-bytes', '😀')).toBe(4);
    });

    it('charges three bytes for a CJK character and one for ASCII', () => {
      expect(countCaption('utf8-bytes', 'あ')).toBe(3);
      expect(countCaption('utf8-bytes', 'a')).toBe(1);
    });
  });

  describe('weighted (X)', () => {
    it('charges a flat 23 for a URL however long it really is', () => {
      // t.co wrapping. A 60-character link costs 23, so a caption a naive count calls
      // over-limit is fine — and users notice being told to cut text they did not need to.
      const long = 'https://example.com/an/extremely/long/path/that/keeps/going/and/going';
      expect(long.length).toBeGreaterThan(23);
      expect(countCaption('x-weighted', long)).toBe(23);
    });

    it('charges 23 per URL, not 23 once', () => {
      expect(countCaption('x-weighted', 'https://a.example https://b.example')).toBe(47);
    });

    it('charges two per CJK character', () => {
      // 140 CJK characters is exactly the 280 limit; 141 is over. This is the case that
      // makes `String.length` unsafe rather than merely imprecise.
      expect(countCaption('x-weighted', 'あ'.repeat(140))).toBe(280);
      expect(countCaption('x-weighted', 'あ'.repeat(141))).toBe(282);
    });

    it('charges two for an emoji and one for Latin text', () => {
      expect(countCaption('x-weighted', '😀')).toBe(2);
      expect(countCaption('x-weighted', 'hello there')).toBe(11);
    });
  });

  it('counts the same text differently per platform, which is the whole point', () => {
    const caption = 'Book now 😀 https://example.com/booking';

    const byUnit = {
      codepoints: countCaption('codepoints', caption),
      'utf8-bytes': countCaption('utf8-bytes', caption),
      'x-weighted': countCaption('x-weighted', caption),
    };

    // A single shared count would have to be wrong for at least two of these.
    expect(new Set(Object.values(byUnit)).size).toBe(3);
  });
});

describe('measureCaption', () => {
  it('takes the limit from the served spec rather than a local table', () => {
    // The signature takes a whole spec precisely so a local lookup is impossible. If the
    // server changes a limit, the UI follows without a frontend release.
    const invented = spec({ captionMaxLength: 42 });

    expect(measureCaption(invented, 'a'.repeat(40))).toMatchObject({
      used: 40,
      limit: 42,
      remaining: 2,
      over: false,
    });
  });

  it('reports over-limit rather than clamping at zero remaining', () => {
    const x = spec({ platform: 'X', captionMaxLength: 280, captionCountUnit: 'x-weighted' });

    const result = measureCaption(x, 'a'.repeat(300));

    expect(result.over).toBe(true);
    // A negative remaining tells the user *how much* to cut. Clamping to 0 hides that.
    expect(result.remaining).toBe(-20);
  });

  it('treats exactly the limit as allowed', () => {
    // Off-by-one here either blocks a legal caption or lets a rejected one through.
    const result = measureCaption(spec({ captionMaxLength: 10 }), 'a'.repeat(10));
    expect(result.over).toBe(false);
    expect(result.remaining).toBe(0);
  });
});

describe('countLinks', () => {
  it('counts each URL, for platforms that cap them', () => {
    // Threads allows 5 links per post as of 2025-12-22.
    expect(countLinks('see https://a.example and https://b.example')).toBe(2);
  });

  it('finds no links in ordinary text', () => {
    expect(countLinks('no links here, just example.com talk')).toBe(0);
  });
});

describe('measuring a caption that will have a link injected', () => {
  // Mirrors what `GET /api/platforms` serves: the real marker and a stand-in URL of the
  // real length. `backend/src/modules/link/link-injection.test.ts` pins the server side
  // against the same shapes.
  const preview = { marker: '{{link}}', syntheticUrl: 'https://bzz.to/aaaaaaa' };

  // `linkBehavior: 'inline'` is set explicitly on every X fixture below. The shared
  // `spec()` helper defaults to Instagram, which is `bio-only` — inheriting that made the
  // first draft of these tests strip the marker instead of injecting a URL, and two of
  // them passed for entirely the wrong reason.
  const xSpec = () =>
    spec({
      platform: 'X',
      captionMaxLength: 280,
      captionCountUnit: 'x-weighted',
      linkBehavior: 'inline',
    });

  it('bills the injected URL, not the placeholder', () => {
    const x = xSpec();
    const caption = `Read more: ${preview.marker}`;

    // "Read more: " is 11, and X charges a flat 23 for any URL. Counting the raw
    // placeholder would give 19 — under the truth, which is the direction that lets a
    // caption pass the composer and be rejected at publish.
    expect(measureCaptionWithLink(x, caption, preview).used).toBe(34);
    expect(measureCaption(x, caption).used).toBe(19);
  });

  it('lets an injected link push a caption over the limit', () => {
    const x = { ...xSpec(), captionMaxLength: 30 };
    const caption = `${'a'.repeat(19)} ${preview.marker}`;

    // 19 + 1 + 8 = 28 as written, 19 + 1 + 23 = 43 as published. The composer must say
    // over, because the server's gate will.
    expect(measureCaption(x, caption).over).toBe(false);
    expect(measureCaptionWithLink(x, caption, preview).over).toBe(true);
  });

  it('removes the placeholder on a bio-only platform rather than charging for it', () => {
    const instagram = spec({ platform: 'INSTAGRAM', linkBehavior: 'bio-only' });

    // Instagram does not linkify caption URLs, so the server strips the marker. Charging
    // for a URL that is never published would understate the budget the user has left.
    expect(measureCaptionWithLink(instagram, `Beach day ${preview.marker}`, preview).used).toBe(9);
  });

  it('does not leave a double space when it strips a mid-sentence placeholder', () => {
    const instagram = spec({ platform: 'INSTAGRAM', linkBehavior: 'bio-only' });

    // 'Book' + ' ' + 'now' = 8. A naive replace leaves 'Book  now' and counts 9, which
    // disagrees with the server by one — the kind of off-by-one that only shows up on a
    // caption sitting exactly at the limit.
    expect(substituteLinkForCount(instagram, `Book ${preview.marker} now`, preview)).toBe(
      'Book now',
    );
  });

  it('counts unchanged when the caption has no placeholder', () => {
    const x = xSpec();

    expect(measureCaptionWithLink(x, 'plain caption', preview).used).toBe(
      measureCaption(x, 'plain caption').used,
    );
  });

  it('falls back to a plain count before the specs have loaded', () => {
    const x = xSpec();
    const caption = `Read more: ${preview.marker}`;

    // Degrading to the old count is the right failure: it is a known-imperfect number
    // rather than one built from a guessed URL length.
    expect(measureCaptionWithLink(x, caption, null).used).toBe(measureCaption(x, caption).used);
  });
});
