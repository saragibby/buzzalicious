import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Platform } from '../../lib/brandApi';
import { countLinks, measureCaptionWithLink, type LinkPreview } from '../../lib/captionCount';
import {
  LINK_MARKER,
  fetchPlatformSpecs,
  platformSpecsQueryKey,
  type Draft,
  type PlatformSpec,
} from '../../lib/composerApi';

/**
 * Captions: one base, then per-platform overrides.
 *
 * ## Why one base and not four blank boxes
 *
 * Four empty boxes is four times the work for a user whose real intent is "the same post,
 * adjusted". So the base caption is what every platform uses until someone deliberately
 * changes one, and an override starts as a copy of the base rather than as an empty field.
 * Only the platforms the user actually edits diverge.
 *
 * This also keeps the AI cost honest: one generated caption, then free edits. Generating
 * per platform would quadruple spend for four near-identical paragraphs.
 *
 * ## Why `null` and `''` are different
 *
 * `null` means "inherit the base". `''` means "this platform's caption is deliberately
 * empty". Collapsing them would resurrect the base copy on a caption somebody cleared on
 * purpose, which is the sort of bug that only shows up after publication.
 *
 * ## Counts
 *
 * Limits come from `GET /api/platforms`, not from constants in this file, so the number
 * shown is the number enforced. The counting is per-platform — see `captionCount.ts` for
 * why `String.length` is wrong for three of the four.
 */

export interface CaptionPanelProps {
  draft: Draft;
  baseCopy: string;
  onBaseCopyChange: (value: string) => void;
  onOverrideChange: (platform: Platform, caption: string | null) => void;
  onGenerate: () => void;
  generating: boolean;
  generateError: string | null;
}

export function CaptionPanel({
  draft,
  baseCopy,
  onBaseCopyChange,
  onOverrideChange,
  onGenerate,
  generating,
  generateError,
}: CaptionPanelProps) {
  const specsQuery = useQuery({ queryKey: platformSpecsQueryKey, queryFn: fetchPlatformSpecs });
  const [active, setActive] = useState<Platform | 'BASE'>('BASE');

  const specs = specsQuery.data?.platforms ?? [];
  // Null until the specs land. `measureCaptionWithLink` degrades to a plain count rather
  // than guessing a URL length.
  const linkPreview = specsQuery.data?.linkPreview ?? null;
  const targets = draft.targets;

  const specFor = (platform: Platform): PlatformSpec | undefined =>
    specs.find((spec) => spec.platform === platform);

  const captionFor = (platform: Platform): string => {
    const target = targets.find((candidate) => candidate.platform === platform);
    return target?.caption ?? baseCopy;
  };

  if (targets.length === 0) {
    return (
      <section className="composer-captions">
        <h2>Caption</h2>
        <p className="composer-empty">
          Pick at least one platform above and its caption will appear here.
        </p>
      </section>
    );
  }

  return (
    <section className="composer-captions">
      <div className="composer-captions-head">
        <h2>Caption</h2>
        <button type="button" onClick={onGenerate} disabled={generating}>
          {generating ? 'Writing…' : 'Write one for me'}
        </button>
      </div>

      {generateError ? (
        <p className="composer-error" role="alert">
          {generateError}
        </p>
      ) : null}

      <div className="caption-tabs" role="tablist" aria-label="Caption per platform">
        <button
          type="button"
          role="tab"
          aria-selected={active === 'BASE'}
          className={active === 'BASE' ? 'caption-tab active' : 'caption-tab'}
          onClick={() => setActive('BASE')}
        >
          All platforms
        </button>
        {targets.map((target) => {
          const spec = specFor(target.platform);
          const count = spec
            ? measureCaptionWithLink(spec, captionFor(target.platform), linkPreview)
            : null;
          return (
            <button
              key={target.platform}
              type="button"
              role="tab"
              aria-selected={active === target.platform}
              className={active === target.platform ? 'caption-tab active' : 'caption-tab'}
              onClick={() => setActive(target.platform)}
            >
              {spec?.label ?? target.platform}
              {count ? (
                <span className={count.over ? 'caption-tab-count over' : 'caption-tab-count'}>
                  {count.used}/{count.limit}
                </span>
              ) : null}
              {target.caption !== null ? (
                <span className="caption-tab-edited" title="Edited for this platform">
                  •
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {active === 'BASE' ? (
        <div className="field">
          <label className="field-label" htmlFor="caption-base">
            The caption every platform starts from
          </label>
          <textarea
            id="caption-base"
            rows={6}
            value={baseCopy}
            onChange={(event) => onBaseCopyChange(event.target.value)}
          />
          <p className="field-hint">
            Type {LINK_MARKER} where a link belongs. Publishing replaces it with a trackable short
            link; exporting leaves it for you to replace by hand.
          </p>
        </div>
      ) : (
        <PlatformCaption
          platform={active}
          spec={specFor(active)}
          value={captionFor(active)}
          overridden={targets.find((t) => t.platform === active)?.caption !== null}
          linkPreview={linkPreview}
          onChange={(value) => onOverrideChange(active, value)}
          onReset={() => onOverrideChange(active, null)}
        />
      )}
    </section>
  );
}

function PlatformCaption({
  platform,
  spec,
  value,
  overridden,
  linkPreview,
  onChange,
  onReset,
}: {
  platform: Platform;
  spec: PlatformSpec | undefined;
  value: string;
  overridden: boolean;
  linkPreview: LinkPreview | null;
  onChange: (value: string) => void;
  onReset: () => void;
}) {
  if (!spec) {
    return (
      <p className="composer-error" role="alert">
        The rules for {platform} could not be loaded, so this caption cannot be checked against its
        limit. Reload the page before posting.
      </p>
    );
  }

  const count = measureCaptionWithLink(spec, value, linkPreview);
  const links = countLinks(value);
  const usesMarker = value.includes(LINK_MARKER);

  return (
    <div className="field">
      <label className="field-label" htmlFor={`caption-${platform}`}>
        {spec.label}
      </label>

      <textarea
        id={`caption-${platform}`}
        rows={6}
        value={value}
        aria-invalid={count.over || undefined}
        aria-describedby={`caption-${platform}-count`}
        onChange={(event) => onChange(event.target.value)}
      />

      <p id={`caption-${platform}-count`} className={count.over ? 'slot-count over' : 'slot-count'}>
        {count.used} / {count.limit}
        {count.over ? ` — ${count.used - count.limit} over, ${spec.label} will reject this` : null}
        {!spec.captionLimitVerified ? (
          <span
            className="caption-unverified"
            title={`${spec.label} does not publish a caption limit. This is a conservative figure, not their number.`}
          >
            {' '}
            (approximate)
          </span>
        ) : null}
      </p>

      {spec.linkBehavior === 'bio-only' && (usesMarker || links > 0) ? (
        <p className="composer-warning" role="status">
          Links in an {spec.label} caption are not clickable. {spec.linkNote}
        </p>
      ) : null}

      {spec.maxLinks !== undefined && links > spec.maxLinks ? (
        <p className="composer-error" role="alert">
          {spec.label} allows at most {spec.maxLinks} links and this has {links}.
        </p>
      ) : null}

      {spec.hashtagLimit !== undefined ? <HashtagCount text={value} spec={spec} /> : null}

      {overridden ? (
        <button type="button" className="link-button" onClick={onReset}>
          Use the shared caption again
        </button>
      ) : (
        <p className="field-hint">
          This is the shared caption. Editing it here changes only {spec.label}.
        </p>
      )}
    </div>
  );
}

function HashtagCount({ text, spec }: { text: string; spec: PlatformSpec }) {
  const used = text.match(/(^|\s)#[^\s#]+/g)?.length ?? 0;
  if (spec.hashtagLimit === undefined || used <= spec.hashtagLimit) return null;

  return (
    <p className="composer-error" role="alert">
      {used} hashtags — {spec.label} allows {spec.hashtagLimit}.
    </p>
  );
}
