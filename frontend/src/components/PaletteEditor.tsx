import { useRef, useState } from 'react';
import { READABLE_CONTRAST, contrastRatio } from '../lib/contrast';
import type { BrandPalette } from '../lib/brandApi';

const ROLES: { key: keyof BrandPalette; label: string; hint: string }[] = [
  { key: 'primary', label: 'Primary', hint: 'Your main brand colour' },
  { key: 'secondary', label: 'Secondary', hint: 'Supporting colour' },
  { key: 'accent', label: 'Accent', hint: 'Highlights and calls to action' },
  { key: 'neutral', label: 'Neutral', hint: 'Borders, dividers, muted text' },
  { key: 'background', label: 'Background', hint: 'Behind everything' },
  { key: 'text', label: 'Text', hint: 'On top of the background' },
];

export interface PaletteEditorProps {
  value: BrandPalette;
  onChange: (palette: BrandPalette) => void;
  onSuggestFromLogo?: (file: File) => Promise<void>;
}

/**
 * The palette editor.
 *
 * The contrast warning is the part that earns its place. A palette is chosen here and
 * then applied to every rendered post, and low-contrast text is not obvious in a colour
 * picker — it is obvious in a finished image, after it has been published. Warning rather
 * than blocking, because a brand may legitimately want a low-contrast look and a hard
 * rule would just be worked around.
 */
export function PaletteEditor({ value, onChange, onSuggestFromLogo }: PaletteEditorProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [suggesting, setSuggesting] = useState(false);

  const ratio = contrastRatio(value.text, value.background);
  const readable = ratio >= READABLE_CONTRAST;

  const handleSuggest = async (file: File) => {
    if (!onSuggestFromLogo) return;
    setSuggesting(true);
    try {
      await onSuggestFromLogo(file);
    } finally {
      setSuggesting(false);
    }
  };

  return (
    <fieldset className="brand-section">
      <legend>Palette</legend>

      <div className="palette-grid">
        {ROLES.map(({ key, label, hint }) => (
          <label key={key} className="palette-swatch">
            <span className="palette-role">{label}</span>
            <input
              type="color"
              value={value[key]}
              onChange={(event) => onChange({ ...value, [key]: event.target.value })}
              aria-label={label}
            />
            {/* The hex field matters: brand guidelines are written in hex, and matching
                one by dragging a colour wheel is not achievable. */}
            <input
              type="text"
              className="palette-hex"
              value={value[key]}
              onChange={(event) => {
                const next = event.target.value;
                if (/^#[0-9a-fA-F]{0,6}$/.test(next)) {
                  onChange({ ...value, [key]: next });
                }
              }}
              aria-label={`${label} hex value`}
              spellCheck={false}
            />
            <span className="palette-hint">{hint}</span>
          </label>
        ))}
      </div>

      <p
        className={readable ? 'palette-contrast ok' : 'palette-contrast warn'}
        role={readable ? undefined : 'status'}
      >
        {readable
          ? `Text on background: ${ratio.toFixed(1)}:1 — readable.`
          : `Text on background is only ${ratio.toFixed(1)}:1. Below 4.5:1, small text is ` +
            `hard to read once it is in a post.`}
      </p>

      {onSuggestFromLogo && (
        <div className="palette-suggest">
          <button type="button" onClick={() => fileInput.current?.click()} disabled={suggesting}>
            {suggesting ? 'Reading your logo…' : 'Suggest from a logo'}
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              // Reset first: picking the same file twice fires no change event otherwise,
              // which reads as the button being broken.
              event.target.value = '';
              if (file) void handleSuggest(file);
            }}
          />
          <span className="palette-hint">
            We&rsquo;ll pull colours out of it. Nothing is saved until you do.
          </span>
        </div>
      )}
    </fieldset>
  );
}
