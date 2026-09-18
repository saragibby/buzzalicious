import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../../lib/api';
import { PLATFORMS, type Platform } from '../../lib/brandApi';
import { useScope } from '../../lib/scope';
import { CaptionPanel } from '../../components/composer/CaptionPanel';
import { LivePreview } from '../../components/composer/LivePreview';
import { SlotForm } from '../../components/composer/SlotForm';
import {
  ASPECT_RATIOS,
  LINK_MARKER,
  RATIO_META,
  deleteDraft,
  downloadExport,
  draftQueryKey,
  fetchDraft,
  fetchTemplate,
  generateCaption,
  templateQueryKey,
  updateDraft,
  type AspectRatio,
  type Draft,
  type Readiness,
  type SlotValues,
  type TemplateDetail,
} from '../../lib/composerApi';

/**
 * The composer: fill the slots, see the preview, write the captions, take the files.
 *
 * ## Autosave, not a save button
 *
 * Every change is persisted on a trailing timer. A save button on a screen people spend
 * twenty minutes in is a way to lose twenty minutes, and the draft has no validity
 * requirements to enforce at save time — slot values are checked against the schema when
 * something is rendered, not when it is typed.
 *
 * The save state is shown rather than hidden. "Saved" appearing a moment after typing
 * stops is what makes the absence of a button trustworthy; silence reads as loss.
 *
 * ## Why the preview is not driven by the saved draft
 *
 * It renders from local state, so it keeps up with typing instead of waiting for a round
 * trip to finish. The save and the preview are independent; a failed save must not blank
 * the preview, and a failed render must not stop the work being stored.
 */

const AUTOSAVE_MS = 700;

export function Composer() {
  const { postId } = useParams<{ postId: string }>();
  const { brand, isLoading: scopeLoading } = useScope();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const brandId = brand?.id ?? '';

  const draftQuery = useQuery({
    queryKey: draftQueryKey(brandId, postId ?? ''),
    queryFn: () => fetchDraft(brandId, postId!),
    enabled: Boolean(brandId && postId),
  });

  const draft = draftQuery.data?.draft;

  const templateQuery = useQuery({
    queryKey: templateQueryKey(draft?.templateSlug ?? ''),
    queryFn: () => fetchTemplate(draft!.templateSlug!),
    enabled: Boolean(draft?.templateSlug),
  });

  if (scopeLoading || draftQuery.isLoading) {
    return <p className="composer-muted">Loading your post…</p>;
  }

  if (!brand) {
    return (
      <p className="composer-empty">
        You need a brand before you can edit a post. <Link to="/brand">Set up your brand kit</Link>.
      </p>
    );
  }

  if (draftQuery.isError) {
    const notFound = draftQuery.error instanceof ApiError && draftQuery.error.status === 404;
    return (
      <p className="composer-error" role="alert">
        {notFound
          ? 'That post does not exist, or it belongs to a different brand.'
          : 'This post could not be loaded.'}{' '}
        <Link to="/composer">Back to templates</Link>
      </p>
    );
  }

  if (!draft) return null;

  if (!draft.templateSlug) {
    // The template was retired underneath a saved draft. Better to say so than to render
    // an editor with no fields and no preview.
    return (
      <p className="composer-error" role="alert">
        The template this post was built from has been retired, so it can no longer be edited or
        exported. <Link to="/composer">Start a new post</Link>.
      </p>
    );
  }

  if (templateQuery.isLoading) return <p className="composer-muted">Loading the template…</p>;

  if (templateQuery.isError || !templateQuery.data) {
    return (
      <p className="composer-error" role="alert">
        The template for this post could not be loaded, so it cannot be previewed safely.{' '}
        <button type="button" className="link-button" onClick={() => void templateQuery.refetch()}>
          Try again
        </button>
      </p>
    );
  }

  return (
    <ComposerEditor
      key={draft.id}
      brandId={brand.id}
      draft={draft}
      readiness={draftQuery.data!.readiness}
      template={templateQuery.data}
      onDeleted={() => {
        void queryClient.invalidateQueries({ queryKey: ['brands', brand.id, 'posts'] });
        navigate('/composer');
      }}
    />
  );
}

interface ComposerEditorProps {
  brandId: string;
  draft: Draft;
  readiness: Readiness;
  template: TemplateDetail;
  onDeleted: () => void;
}

function ComposerEditor({ brandId, draft, readiness, template, onDeleted }: ComposerEditorProps) {
  const queryClient = useQueryClient();

  const [title, setTitle] = useState(draft.title ?? '');
  const [slotValues, setSlotValues] = useState<SlotValues>(draft.slotValues);
  const [baseCopy, setBaseCopy] = useState(draft.baseCopy ?? '');
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>(
    template.supportedRatios[0] ?? 'SQUARE_1_1',
  );

  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const currentReadiness = useRef(readiness);
  const [issues, setIssues] = useState(readiness.issues);
  const [ready, setReady] = useState(readiness.ready);

  const save = useMutation({
    mutationFn: (patch: Parameters<typeof updateDraft>[2]) => updateDraft(brandId, draft.id, patch),
    onMutate: () => {
      setSaveState('saving');
      setSaveError(null);
    },
    onSuccess: (result) => {
      setSaveState('saved');
      setReady(result.readiness.ready);
      setIssues(result.readiness.issues);
      currentReadiness.current = result.readiness;
      queryClient.setQueryData(draftQueryKey(brandId, draft.id), result);
    },
    onError: (error: unknown) => {
      setSaveState('error');
      // Named, not swallowed: an over-limit caption is refused by the API and the user has
      // to be told which one, or they will keep typing into a field that is not saving.
      setSaveError(
        error instanceof ApiError
          ? error.message
          : 'Your changes could not be saved. They are still on screen — check your connection.',
      );
    },
  });

  const saveRef = useRef(save);
  saveRef.current = save;

  // Autosave. Serialised so the effect compares values rather than object identity, which
  // would fire on every render.
  const serialisedSlots = JSON.stringify(slotValues);
  const first = useRef(true);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }

    const timer = window.setTimeout(() => {
      saveRef.current.mutate({
        title: title || null,
        slotValues: JSON.parse(serialisedSlots) as SlotValues,
        baseCopy: baseCopy || null,
      });
    }, AUTOSAVE_MS);

    return () => window.clearTimeout(timer);
  }, [title, serialisedSlots, baseCopy]);

  const togglePlatform = (platform: Platform) => {
    const next = draft.targets.some((target) => target.platform === platform)
      ? draft.targets.filter((target) => target.platform !== platform).map((t) => t.platform)
      : [...draft.targets.map((t) => t.platform), platform];

    save.mutate({ platforms: next });
  };

  const generate = useMutation({
    mutationFn: () =>
      generateCaption(brandId, draft.id, { includeLinkMarker: baseCopy.includes(LINK_MARKER) }),
    onMutate: () => setGenerateError(null),
    onSuccess: (result) => setBaseCopy(result.caption),
    onError: (error: unknown) => {
      setGenerateError(
        error instanceof ApiError
          ? // A 402 is a budget refusal and says so in its message — passing it through is
            // more useful than a generic failure.
            error.message
          : 'The caption could not be written. Try again in a moment.',
      );
    },
  });

  const runExport = async () => {
    setExporting(true);
    setExportError(null);

    try {
      const { blob, filename } = await downloadExport(brandId, draft.id);

      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      setExportError(
        error instanceof ApiError
          ? error.message
          : 'The download failed. Nothing was lost — try again.',
      );
    } finally {
      setExporting(false);
    }
  };

  const remove = useMutation({
    mutationFn: () => deleteDraft(brandId, draft.id),
    onSuccess: onDeleted,
  });

  const ratios = useMemo(
    () => ASPECT_RATIOS.filter((ratio) => template.supportedRatios.includes(ratio)),
    [template.supportedRatios],
  );

  return (
    <section className="composer">
      <header className="composer-head">
        <div>
          <input
            className="composer-title"
            type="text"
            value={title}
            placeholder={template.name}
            aria-label="Post title"
            onChange={(event) => setTitle(event.target.value)}
          />
          <p className="composer-muted">
            {template.name} · version {draft.templateVersion ?? template.version}
          </p>
        </div>

        <p className="composer-save-state" role="status">
          {saveState === 'saving'
            ? 'Saving…'
            : saveState === 'saved'
              ? 'Saved'
              : saveState === 'error'
                ? 'Not saved'
                : ''}
        </p>
      </header>

      {saveError ? (
        <p className="composer-error" role="alert">
          {saveError}
        </p>
      ) : null}

      <div className="composer-body">
        <div className="composer-column">
          <h2>Your content</h2>
          <SlotForm
            slotSchema={template.slotSchema}
            values={slotValues}
            brandId={brandId}
            onChange={setSlotValues}
          />

          <fieldset className="composer-platforms">
            <legend>Where this is going</legend>
            <div className="platform-toggles">
              {PLATFORMS.map((platform) => {
                const on = draft.targets.some((target) => target.platform === platform);
                return (
                  <label key={platform} className="field inline">
                    <input type="checkbox" checked={on} onChange={() => togglePlatform(platform)} />
                    {platform.charAt(0) + platform.slice(1).toLowerCase()}
                  </label>
                );
              })}
            </div>
          </fieldset>

          <CaptionPanel
            draft={draft}
            baseCopy={baseCopy}
            onBaseCopyChange={setBaseCopy}
            onOverrideChange={(platform, caption) =>
              save.mutate({ captionOverrides: { [platform]: caption } })
            }
            onGenerate={() => generate.mutate()}
            generating={generate.isPending}
            generateError={generateError}
          />
        </div>

        <div className="composer-column composer-column-preview">
          <h2>Preview</h2>
          <LivePreview
            templateSlug={template.slug}
            brandId={brandId}
            slotValues={slotValues}
            aspectRatio={aspectRatio}
            supportedRatios={ratios}
            onAspectRatioChange={setAspectRatio}
          />

          <section className="composer-export">
            <h2>Download</h2>
            <p className="composer-muted">
              {ratios.map((ratio) => RATIO_META[ratio].label).join(', ')} as PNG, plus your
              captions, in one zip.
            </p>

            {!ready ? (
              <ul className="composer-issues" aria-label="Before you can download">
                {issues.map((issue) => (
                  <li key={`${issue.slot}-${issue.message}`}>
                    {issue.slot ? <strong>{issue.slot}: </strong> : null}
                    {issue.message}
                  </li>
                ))}
              </ul>
            ) : null}

            {exportError ? (
              <p className="composer-error" role="alert">
                {exportError}
              </p>
            ) : null}

            <button type="button" disabled={!ready || exporting} onClick={() => void runExport()}>
              {exporting ? 'Building your files…' : 'Download the files'}
            </button>
          </section>
        </div>
      </div>

      <footer className="composer-foot">
        <button
          type="button"
          className="link-button"
          onClick={() => {
            if (window.confirm('Delete this post? This cannot be undone.')) remove.mutate();
          }}
        >
          Delete this post
        </button>
      </footer>
    </section>
  );
}
