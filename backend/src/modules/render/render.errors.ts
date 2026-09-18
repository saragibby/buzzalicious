import { AppError } from '../../platform/errors';

/**
 * Rendering has two distinct failure classes and conflating them costs real money.
 *
 * A **pipeline fault** — a missing font file, a Satori crash, a template that does not
 * parse — is ours. The user cannot act on it and the message may name internals, so it is
 * a 500 and is never exposed.
 *
 * A **content fault** — copy too long to fit, a glyph no vendored font contains — is the
 * user's, is fixable in the composer in five seconds, and must say precisely what to fix.
 * The alternative is what docs/05 warns about: a technically-successful render with the
 * CTA sliced in half, which nothing surfaces because nothing failed.
 */

/** 500 — the render pipeline itself broke. Not exposed. */
export class RenderError extends AppError {
  readonly code = 'INTERNAL_ERROR' as const;
  readonly status = 500;
  readonly expose = false;
}

export interface OverflowDetail {
  /** `LayoutNode.id` where available, so the composer can point at the offending field. */
  node: string;
  slot?: string;
  /** How far past the available box the content ran, in rendered pixels. */
  overflowPx: number;
  /** The smallest font size `$fit` was allowed to try before giving up. */
  minFontSize?: number;
}

/**
 * 400 — content does not fit, even at the smallest size `$fit` is permitted to use.
 *
 * Deliberately an error and not a warning. Silently clipping produces an image that looks
 * fine in a thumbnail and is unusable at full size, and by the time anyone notices it has
 * been published.
 */
export class RenderOverflowError extends AppError {
  readonly code = 'VALIDATION_FAILED' as const;
  readonly status = 400;

  constructor(
    readonly aspectRatio: string,
    readonly overflows: OverflowDetail[],
    options?: { cause?: unknown },
  ) {
    super(
      `Content does not fit the ${aspectRatio} canvas: ` +
        overflows.map((item) => `${item.slot ?? item.node} overflows by ${Math.ceil(item.overflowPx)}px`).join(', '),
      { details: { aspectRatio, overflows }, cause: options?.cause },
    );
  }
}

/**
 * 400 — text contains a character no vendored font can draw.
 *
 * Satori's behaviour here is to render nothing at all, so without this the user gets a
 * headline with a hole in it and no indication why. See `fonts.ts` for the coverage we
 * actually ship (`latin-ext` plus the emoji set).
 */
export interface UnrenderableDetail {
  /** Where the text came from — a slot key, or a brand field. */
  field: string;
  /** The distinct graphemes in that field nothing can draw. */
  characters: string[];
}

export class UnrenderableTextError extends AppError {
  readonly code = 'VALIDATION_FAILED' as const;
  readonly status = 400;

  constructor(
    message: string,
    readonly offences: UnrenderableDetail[],
    options?: { cause?: unknown },
  ) {
    super(message, { details: { offences }, cause: options?.cause });
  }
}
