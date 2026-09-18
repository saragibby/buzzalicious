/**
 * Safe areas: the region of a canvas a template may actually draw into.
 *
 * ## The decision W2 handed over
 *
 * docs/05 contradicted itself — the prose described safe areas as per-ratio, the worked
 * example showed a single flat value — and W2 hedged by accepting both. This is the
 * resolution: **both, merged per edge, in three layers.**
 *
 *     platform default for the ratio  ⊕  canvas.safeArea  ⊕  canvas.byRatio[ratio]
 *
 * Later layers win, and they win *per edge*: a template that sets `{ bottom: 0.04 }`
 * narrows the bottom and leaves the platform's top inset alone. Merging wholesale would
 * mean any template touching one edge silently discards the Stories chrome inset on the
 * others, which is precisely the bug this shape exists to prevent.
 *
 * Why not pick one of the two:
 *
 * - **Flat only** has to be conservative enough for the tightest ratio. 9:16 needs 20% of
 *   its height reserved; applying that to 1:1 and 16:9 throws away a fifth of every feed
 *   post to protect against chrome that is not there.
 * - **Per-ratio only** is correct but makes every template author tune four ratios by
 *   hand, and 11 seeded templates × 4 ratios is 44 tuning decisions to get a first render.
 *
 * The expensive half of per-ratio safe areas is the authoring, and the only ratio that
 * genuinely needs tuning is the one whose chrome we already know. So the platform default
 * supplies it, authors write a flat value for their own design margins, and `byRatio` is
 * an escape hatch for the template that actually needs one. The common case is zero
 * authoring; the hard case is still expressible.
 *
 * ## The assumption in the table below, stated plainly
 *
 * `PLATFORM_DEFAULT` is keyed by **aspect ratio**, but chrome is a property of the
 * **surface** — Instagram Stories overlays UI, a 9:16 video on a website does not. Ratio
 * is a proxy, and it is the only key available: `Rendition` hangs off `Post`, not
 * `PostTarget`, precisely so one render is reused across every platform sharing a ratio,
 * so nothing at render time knows where the image will be published.
 *
 * The cost is real and worth naming: a 9:16 rendition used somewhere without chrome
 * wastes 20% of its canvas. We accept that, because the failure is cosmetic and
 * symmetrical — the alternative is a CTA underneath Instagram's own buttons, which is not.
 * If renditions ever become per-surface, this table should be re-keyed rather than
 * extended.
 *
 * See docs/05-template-engine.md.
 */

import type { AspectRatio } from '@prisma/client';
import type { TemplateLayout } from '../template/template.schemas';
import { specFor } from './renderer';

export interface SafeArea {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** Fractions of each edge reserved before a template says anything. */
export const PLATFORM_DEFAULT: Record<AspectRatio, Partial<SafeArea>> = {
  // Stories and Reels overlay the sender's avatar and caption at the top and the reply
  // bar, progress dots and share affordances at the bottom. ~8%/~12% is the figure in
  // docs/05; it is deliberately a little generous because the exact inset moves between
  // app releases and a render outlives the version it was made on.
  STORY_9_16: { top: 0.08, bottom: 0.12 },

  // Feed surfaces draw chrome outside the image, not over it.
  SQUARE_1_1: {},
  PORTRAIT_4_5: {},
  LANDSCAPE_16_9: {},
};

const NONE: SafeArea = { top: 0, bottom: 0, left: 0, right: 0 };

function merge(base: SafeArea, override: Partial<SafeArea> | undefined): SafeArea {
  if (!override) return base;

  return {
    top: override.top ?? base.top,
    bottom: override.bottom ?? base.bottom,
    left: override.left ?? base.left,
    right: override.right ?? base.right,
  };
}

/** The three layers, resolved to fractions. */
export function resolveSafeArea(
  layout: Pick<TemplateLayout, 'canvas'>,
  aspectRatio: AspectRatio,
): SafeArea {
  return merge(
    merge(merge(NONE, PLATFORM_DEFAULT[aspectRatio]), layout.canvas?.safeArea),
    layout.canvas?.byRatio?.[aspectRatio],
  );
}

export interface ContentBox {
  top: number;
  left: number;
  width: number;
  height: number;
}

/**
 * The safe area in pixels for a ratio — the box the compiled root is laid out inside.
 *
 * Padding rather than a clip: content is positioned within the box, and anything that
 * cannot fit raises instead of being cropped. Cropping is the silent failure docs/05
 * warns about.
 */
export function contentBox(
  layout: Pick<TemplateLayout, 'canvas'>,
  aspectRatio: AspectRatio,
): ContentBox {
  const spec = specFor(aspectRatio);
  const safe = resolveSafeArea(layout, aspectRatio);

  return {
    top: Math.round(spec.height * safe.top),
    left: Math.round(spec.width * safe.left),
    width: Math.round(spec.width * (1 - safe.left - safe.right)),
    height: Math.round(spec.height * (1 - safe.top - safe.bottom)),
  };
}
