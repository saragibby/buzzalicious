import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../../lib/api';
import {
  RATIO_META,
  renderPreview,
  type AspectRatio,
  type PreviewResult,
  type SlotValues,
} from '../../lib/composerApi';

/**
 * The live preview.
 *
 * ## Debounce, and what it is actually for
 *
 * Preview is a server render. Firing one per keystroke would put a request on the wire for
 * every letter of a headline — a request the user has already invalidated by typing the
 * next letter. So edits are collected on a trailing timer and exactly one request goes out
 * per burst.
 *
 * The delay is 150ms because docs/05 budgets the render itself at under 150ms: pausing
 * longer than the render takes makes the preview feel slower than it is, and pausing less
 * spends requests on frames nobody sees.
 *
 * ## Stale responses
 *
 * Requests are sequenced and a response is dropped if a newer one has been issued. Without
 * that, a slow render of an old value can land after a fast render of a new one and the
 * preview shows text the user deleted — which reads as data loss, not as lag.
 *
 * ## Failure is loud
 *
 * A failed render shows an error where the image was, never a stale or partial image. The
 * whole point of the screen is "what you see is what you post"; silently showing the last
 * good render while the current one is broken breaks exactly that promise.
 */

const DEBOUNCE_MS = 150;

export interface LivePreviewProps {
  templateSlug: string;
  brandId: string;
  slotValues: SlotValues;
  aspectRatio: AspectRatio;
  supportedRatios: AspectRatio[];
  onAspectRatioChange: (ratio: AspectRatio) => void;
}

export function LivePreview({
  templateSlug,
  brandId,
  slotValues,
  aspectRatio,
  supportedRatios,
  onAspectRatioChange,
}: LivePreviewProps) {
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // Monotonic request id. Compared on arrival so an out-of-order response is discarded
  // rather than painted.
  const sequence = useRef(0);
  const serialized = JSON.stringify(slotValues);

  useEffect(() => {
    let cancelled = false;
    setPending(true);

    const timer = window.setTimeout(() => {
      const issued = ++sequence.current;

      void renderPreview(templateSlug, {
        brandId,
        aspectRatio,
        slotValues: JSON.parse(serialized) as SlotValues,
      })
        .then((result) => {
          if (cancelled || issued !== sequence.current) return;
          setPreview(result);
          setError(null);
        })
        .catch((cause: unknown) => {
          if (cancelled || issued !== sequence.current) return;
          // Cleared deliberately: a stale image under a new error would claim the post
          // looks like something it no longer does.
          setPreview(null);
          setError(
            cause instanceof ApiError
              ? cause.message
              : 'The preview could not be rendered. Check your connection and try again.',
          );
        })
        .finally(() => {
          if (!cancelled && issued === sequence.current) setPending(false);
        });
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [templateSlug, brandId, aspectRatio, serialized]);

  const ratio = RATIO_META[aspectRatio];

  return (
    <div className="composer-preview">
      <div className="composer-ratio-switch" role="group" aria-label="Preview size">
        {supportedRatios.map((candidate) => (
          <button
            key={candidate}
            type="button"
            className={candidate === aspectRatio ? 'ratio-tab active' : 'ratio-tab'}
            aria-pressed={candidate === aspectRatio}
            onClick={() => onAspectRatioChange(candidate)}
          >
            {RATIO_META[candidate].label}
            <span className="ratio-dims">
              {RATIO_META[candidate].width}:{RATIO_META[candidate].height}
            </span>
          </button>
        ))}
      </div>

      <div
        className="composer-preview-frame"
        style={{ aspectRatio: `${ratio.width} / ${ratio.height}` }}
        data-pending={pending ? 'true' : 'false'}
      >
        {error ? (
          <p className="composer-preview-error" role="alert">
            {error}
          </p>
        ) : preview ? (
          // The render is trusted SVG produced by our own template engine from our own
          // layouts — not user-supplied markup. Slot values reach it as Satori text nodes,
          // never as markup, so they cannot introduce elements here.
          <div className="composer-preview-svg" dangerouslySetInnerHTML={{ __html: preview.svg }} />
        ) : (
          <p className="composer-preview-placeholder">Rendering your preview…</p>
        )}
      </div>

      {preview && preview.overflows.length > 0 ? (
        <ul className="composer-overflows" aria-label="Text that does not fit">
          {preview.overflows.map((overflow) => (
            <li key={overflow.slot}>
              <strong>{overflow.slot}</strong> {overflow.message}
            </li>
          ))}
        </ul>
      ) : null}

      {preview && preview.fittedDown.length > 0 ? (
        <p className="composer-fitted">
          Shrunk to fit: {preview.fittedDown.join(', ')}. Shorter copy will look better.
        </p>
      ) : null}
    </div>
  );
}
