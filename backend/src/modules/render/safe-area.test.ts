import { describe, expect, it } from 'vitest';
import { contentBox, resolveSafeArea, PLATFORM_DEFAULT } from './safe-area';
import { specFor } from './renderer';

/**
 * The safe-area resolution docs/05 was ambiguous about. These pin the merge semantics,
 * because the failure they prevent is invisible: a template that sets one edge and
 * silently loses the Stories chrome inset on the others renders fine, publishes fine, and
 * puts the CTA under Instagram's reply bar.
 */

const noCanvas = { canvas: undefined };

describe('resolveSafeArea', () => {
  it('applies the platform default for stories with no template input', () => {
    expect(resolveSafeArea(noCanvas, 'STORY_9_16')).toEqual({
      top: 0.08,
      bottom: 0.12,
      left: 0,
      right: 0,
    });
  });

  it('reserves nothing on feed ratios, which draw chrome outside the image', () => {
    for (const ratio of ['SQUARE_1_1', 'PORTRAIT_4_5', 'LANDSCAPE_16_9'] as const) {
      expect(resolveSafeArea(noCanvas, ratio)).toEqual({ top: 0, bottom: 0, left: 0, right: 0 });
    }
  });

  it('merges per edge, so a flat value cannot erase the platform default', () => {
    // The load-bearing assertion. `stat-with-photo` in the seed sets exactly this, and
    // wholesale merging would drop the 8% top inset it never mentioned.
    const layout = { canvas: { safeArea: { bottom: 0.04 } } };

    expect(resolveSafeArea(layout, 'STORY_9_16')).toEqual({
      top: 0.08,
      bottom: 0.04,
      left: 0,
      right: 0,
    });
  });

  it('lets byRatio win over both other layers', () => {
    const layout = {
      canvas: { safeArea: { bottom: 0.04 }, byRatio: { STORY_9_16: { bottom: 0.2 } } },
    };

    expect(resolveSafeArea(layout, 'STORY_9_16').bottom).toBe(0.2);
    expect(resolveSafeArea(layout, 'SQUARE_1_1').bottom).toBe(0.04);
  });

  it('applies a template-wide safe area to every ratio', () => {
    const layout = { canvas: { safeArea: { left: 0.1, right: 0.1 } } };

    for (const ratio of ['SQUARE_1_1', 'STORY_9_16'] as const) {
      const safe = resolveSafeArea(layout, ratio);
      expect(safe.left).toBe(0.1);
      expect(safe.right).toBe(0.1);
    }
  });
});

describe('contentBox', () => {
  it('insets the story canvas by the platform chrome, in pixels', () => {
    const spec = specFor('STORY_9_16');
    const box = contentBox(noCanvas, 'STORY_9_16');

    expect(box.top).toBe(Math.round(spec.height * 0.08));
    expect(box.height).toBe(Math.round(spec.height * (1 - 0.08 - 0.12)));
    expect(box.width).toBe(spec.width);
  });

  it('gives a feed ratio the whole canvas', () => {
    const spec = specFor('SQUARE_1_1');

    expect(contentBox(noCanvas, 'SQUARE_1_1')).toEqual({
      top: 0,
      left: 0,
      width: spec.width,
      height: spec.height,
    });
  });
});

describe('PLATFORM_DEFAULT', () => {
  it('only reserves space on the ratio whose chrome we actually know about', () => {
    // If this ever grows, the ratio-as-proxy-for-surface assumption documented in
    // safe-area.ts needs revisiting rather than extending.
    const withInsets = Object.entries(PLATFORM_DEFAULT).filter(
      ([, area]) => Object.keys(area).length > 0,
    );

    expect(withInsets.map(([ratio]) => ratio)).toEqual(['STORY_9_16']);
  });
});
