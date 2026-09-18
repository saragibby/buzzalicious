import { useQuery } from '@tanstack/react-query';
import { fetchAssets, type AssetView } from '../../lib/brandApi';
import type { ImageSlot, Slot, SlotValues, TextSlot } from '../../lib/composerApi';

/**
 * The form the composer builds from a template's `slotSchema`.
 *
 * Generated rather than hand-written per template, because templates are data: a new
 * template added by W4 has to produce a working form without a frontend release. That
 * means every affordance here has to be driven by the schema — `maxLength` becomes a
 * counter, `multiline` becomes a textarea, `aiHint` becomes the hint text, and an image
 * slot becomes a picker over the brand's own assets.
 *
 * Counts are shown against `maxLength` from the slot schema, which is the same number the
 * renderer fits text against. Over-limit is not blocked — the draft still saves, because
 * refusing to store a half-typed sentence loses work — but it is flagged, and the preview
 * reports the overflow independently.
 */

function slotLabel(name: string, slot: Slot): string {
  return slot.label ?? name.replace(/[_-]/g, ' ');
}

function TextSlotField({
  name,
  slot,
  value,
  onChange,
}: {
  name: string;
  slot: TextSlot;
  value: string;
  onChange: (value: string) => void;
}) {
  const used = [...value].length;
  const over = used > slot.maxLength;
  const short = slot.minLength !== undefined && used > 0 && used < slot.minLength;
  const countId = `${name}-count`;

  return (
    <div className="field">
      <label className="field-label" htmlFor={`slot-${name}`}>
        {slotLabel(name, slot)}
      </label>
      {slot.aiHint ? <p className="field-hint">{slot.aiHint}</p> : null}

      {slot.multiline ? (
        <textarea
          id={`slot-${name}`}
          rows={4}
          value={value}
          aria-describedby={countId}
          aria-invalid={over || undefined}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <input
          id={`slot-${name}`}
          type="text"
          value={value}
          aria-describedby={countId}
          aria-invalid={over || undefined}
          onChange={(event) => onChange(event.target.value)}
        />
      )}

      <p id={countId} className={over ? 'slot-count over' : 'slot-count'}>
        {used} / {slot.maxLength}
        {over ? ' — too long to fit the design' : null}
        {short ? ` — at least ${slot.minLength} characters` : null}
      </p>
    </div>
  );
}

function ImageSlotField({
  name,
  slot,
  value,
  brandId,
  onChange,
}: {
  name: string;
  slot: ImageSlot;
  value: string;
  brandId: string;
  onChange: (value: string) => void;
}) {
  const assetsQuery = useQuery({
    queryKey: ['brands', brandId, 'assets', 'PHOTO'],
    queryFn: () => fetchAssets(brandId, 'PHOTO'),
  });

  const assets: AssetView[] = assetsQuery.data ?? [];

  const tooSmall = (asset: AssetView): boolean =>
    (slot.minWidth !== undefined && (asset.width ?? 0) < slot.minWidth) ||
    (slot.minHeight !== undefined && (asset.height ?? 0) < slot.minHeight);

  return (
    <div className="field">
      <span className="field-label">{slotLabel(name, slot)}</span>
      {slot.aiHint ? <p className="field-hint">{slot.aiHint}</p> : null}
      {slot.aspectHint ? (
        <p className="field-hint">
          Looks best at {slot.aspectHint}
          {slot.minWidth ? ` and at least ${slot.minWidth}px wide` : null}.
        </p>
      ) : null}

      {assetsQuery.isLoading ? <p className="composer-muted">Loading your photos…</p> : null}

      {assetsQuery.isError ? (
        <p className="composer-error" role="alert">
          Your photo library could not be loaded. Reload the page to try again.
        </p>
      ) : null}

      {!assetsQuery.isLoading && !assetsQuery.isError && assets.length === 0 ? (
        // An empty picker with no explanation reads as broken. Say what to do instead.
        <p className="composer-empty">
          No photos yet. Upload some in your <a href="/brand">brand kit</a> and they will appear
          here.
        </p>
      ) : null}

      <ul className="asset-picker">
        {assets.map((asset) => {
          const selected = value === asset.url;
          return (
            <li key={asset.id}>
              <button
                type="button"
                className={selected ? 'asset-option selected' : 'asset-option'}
                aria-pressed={selected}
                onClick={() => onChange(selected ? '' : asset.url)}
              >
                <img src={asset.thumbnailUrl ?? asset.url} alt={asset.altText ?? ''} />
                {tooSmall(asset) ? (
                  // Not disabled: the user may know better than the template's minimum.
                  // Warned, because a stretched photo is the kind of thing nobody notices
                  // until it is published.
                  <span className="asset-warn">Smaller than this slot wants</span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export interface SlotFormProps {
  slotSchema: Record<string, Slot>;
  values: SlotValues;
  brandId: string;
  onChange: (values: SlotValues) => void;
}

export function SlotForm({ slotSchema, values, brandId, onChange }: SlotFormProps) {
  const entries = Object.entries(slotSchema);

  if (entries.length === 0) {
    return <p className="composer-empty">This template has no fields to fill in.</p>;
  }

  const set = (name: string, value: string) => onChange({ ...values, [name]: value });

  return (
    <div className="composer-slots">
      {entries.map(([name, slot]) =>
        slot.type === 'image' ? (
          <ImageSlotField
            key={name}
            name={name}
            slot={slot}
            brandId={brandId}
            value={values[name] ?? ''}
            onChange={(value) => set(name, value)}
          />
        ) : (
          <TextSlotField
            key={name}
            name={name}
            slot={slot}
            value={values[name] ?? slot.default ?? ''}
            onChange={(value) => set(name, value)}
          />
        ),
      )}
    </div>
  );
}
