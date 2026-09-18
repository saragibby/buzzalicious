import { describe, expect, it } from 'vitest';
import { emojiDataUri, twemojiCodepoints } from './emoji';
import { assertRenderableText, findUnrenderableGraphemes, graphemes } from './text';
import { fontFamilyStack } from './fonts';
import { getRenderer } from './satori-renderer';

/**
 * Emoji (Q9) and the loud-failure path for text nothing can draw.
 *
 * Satori renders an uncoverable character as a filled box and returns success. Without
 * these checks that is a 200, a PNG in storage and a `Rendition` row, for an image with a
 * hole in it — the same class of silent success as clipped text.
 */

const FAMILIES = ['Inter', 'Fraunces'];

describe('twemojiCodepoints', () => {
  it('drops the variation selector but keeps zero-width joiners', () => {
    // Twemoji's filenames follow this rule and getting it wrong misses most of the common
    // emoji silently — the lookup just returns nothing and the glyph vanishes.
    expect(twemojiCodepoints('✅')).toBe('2705');
    expect(twemojiCodepoints('❤️')).toBe('2764');
    expect(twemojiCodepoints('👩‍🚒')).toBe('1f469-200d-1f692');
  });
});

describe('emojiDataUri', () => {
  it('resolves a plain emoji', async () => {
    await expect(emojiDataUri('🎉')).resolves.toMatch(/^data:image\/svg\+xml/);
  });

  it('resolves a joined sequence', async () => {
    await expect(emojiDataUri('👩‍🚒')).resolves.toMatch(/^data:image\/svg\+xml/);
  });

  it('returns nothing for text, so ordinary characters still use the font', async () => {
    await expect(emojiDataUri('a')).resolves.toBeUndefined();
  });
});

describe('graphemes', () => {
  it('keeps a joined emoji sequence together', () => {
    // Splitting on code units would turn one firefighter into a woman, a joiner and a
    // fire engine, and each would be looked up separately.
    expect(graphemes('hi 👩‍🚒')).toEqual(['h', 'i', ' ', '👩‍🚒']);
  });
});

describe('findUnrenderableGraphemes', () => {
  it('accepts Latin text, accents and Central European letters', async () => {
    await expect(findUnrenderableGraphemes('Łódź café Muñoz', FAMILIES)).resolves.toEqual([]);
  });

  it('accepts emoji, which come from Twemoji rather than the fonts', async () => {
    await expect(findUnrenderableGraphemes('Open today 🎉✅', FAMILIES)).resolves.toEqual([]);
  });

  it('reports characters no font and no emoji asset covers', async () => {
    await expect(findUnrenderableGraphemes('こんにちは', FAMILIES)).resolves.toEqual([
      'こ',
      'ん',
      'に',
      'ち',
      'は',
    ]);
  });

  it('deduplicates, so a paragraph reports a readable list', async () => {
    await expect(findUnrenderableGraphemes('ああああ', FAMILIES)).resolves.toEqual(['あ']);
  });

  it('ignores whitespace and formatting characters', async () => {
    await expect(findUnrenderableGraphemes('a\n\tb ', FAMILIES)).resolves.toEqual([]);
  });

  it('treats an unknown family as covering nothing rather than everything', async () => {
    // A brand pointing at a font we never vendored must surface as unrenderable text, not
    // as a page of boxes.
    const result = await findUnrenderableGraphemes('Hello', ['Comic Sans MS']);

    expect(result).toEqual(['H', 'e', 'l', 'o']);
  });
});

describe('assertRenderableText', () => {
  it('passes text the curated set covers', async () => {
    await expect(
      assertRenderableText([{ field: 'headline', text: 'Open 7 days 🎉' }], FAMILIES),
    ).resolves.toBeUndefined();
  });

  it('names the field and the characters so the composer can point at them', async () => {
    await expect(
      assertRenderableText([{ field: 'headline', text: 'こんにちは' }], FAMILIES),
    ).rejects.toThrow(/headline/);
  });
});

describe('rendering emoji', () => {
  it('draws emoji as images through Satori', async () => {
    // The end-to-end check: Satori has no colour-emoji glyph, so this only produces pixels
    // if `loadAdditionalAsset` resolves the vendored SVG.
    const image = await getRenderer().render(
      {
        type: 'div',
        props: {
          style: {
            display: 'flex',
            width: '100%',
            height: '100%',
            background: '#ffffff',
            color: '#111111',
            fontFamily: fontFamilyStack('Inter'),
            fontSize: 72,
            padding: 40,
          },
          children: 'Łódź 🎉 ✅ 👩‍🚒',
        },
      },
      'SQUARE_1_1',
    );

    expect(image.png.byteLength).toBeGreaterThan(0);
  });
});
