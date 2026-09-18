import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AssetLibrary } from '../components/AssetLibrary';
import { CategoryPicker } from '../components/CategoryPicker';
import { PaletteEditor } from '../components/PaletteEditor';
import { TypographyEditor } from '../components/TypographyEditor';
import { VoiceGuideEditor } from '../components/VoiceGuideEditor';
import { ApiError } from '../lib/api';
import { useScope } from '../lib/scope';
import {
  PLATFORMS,
  draftVoiceGuide,
  fetchFonts,
  suggestPalette,
  updateBrand,
  type Brand,
  type Platform,
} from '../lib/brandApi';

/**
 * The brand kit.
 *
 * Edited as a local draft and saved explicitly, rather than autosaving each field. Every
 * value here feeds the render pipeline and the caption generator, so a half-typed hex or
 * a partly-rewritten voice summary being live is a real cost — the user would see it in
 * generated output before they had finished deciding.
 *
 * The draft is re-seeded whenever the server's copy changes identity or revision, so a
 * brand switch does not leave the previous brand's values in the form.
 */
export function BrandKit() {
  const { brand, workspace, isLoading } = useScope();
  const queryClient = useQueryClient();

  const [draft, setDraft] = useState<Brand | null>(brand);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setDraft(brand);
    setSaved(false);
    setError(null);
    // Keyed on identity and revision rather than on the object: `brand` is rebuilt on
    // every refetch, and depending on it would wipe a half-typed form under the user.
    // `updatedAt` as well as `id`, so a successful save does re-seed the draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brand?.id, brand?.updatedAt]);

  const fontsQuery = useQuery({
    queryKey: ['fonts'],
    queryFn: fetchFonts,
    staleTime: 60 * 60 * 1000,
  });

  const saveMutation = useMutation({
    mutationFn: async (next: Brand) =>
      updateBrand(next.id, {
        name: next.name,
        website: next.website,
        categoryId: next.categoryId,
        palette: next.palette,
        typography: next.typography,
        voiceGuide: next.voiceGuide,
        targetPlatforms: next.targetPlatforms,
        timezone: next.timezone,
      }),
    onSuccess: async () => {
      setError(null);
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: ['workspaces'] });
    },
    onError: (caught: unknown) =>
      setError(caught instanceof ApiError ? caught.message : 'Could not save those changes.'),
  });

  const draftVoiceMutation = useMutation({
    mutationFn: (input: { audience?: string; notes?: string }) => draftVoiceGuide(draft!.id, input),
    onSuccess: (result) => {
      // Into the form, not into the database. The user still has to press Save.
      setDraft((current) => (current ? { ...current, voiceGuide: result.draft } : current));
      setSaved(false);
    },
    onError: (caught: unknown) =>
      setError(
        caught instanceof ApiError ? caught.message : 'Could not draft a voice guide just now.',
      ),
  });

  if (isLoading) return <p className="field-hint">Loading…</p>;

  if (!draft || !workspace) {
    return (
      <section className="brand-kit">
        <h1>Brand kit</h1>
        <p className="field-hint">No brand yet. One is created for you when you sign in.</p>
      </section>
    );
  }

  const update = <K extends keyof Brand>(key: K, value: Brand[K]) => {
    setDraft((current) => (current ? { ...current, [key]: value } : current));
    setSaved(false);
  };

  const togglePlatform = (platform: Platform) => {
    const next = draft.targetPlatforms.includes(platform)
      ? draft.targetPlatforms.filter((candidate) => candidate !== platform)
      : [...draft.targetPlatforms, platform];
    update('targetPlatforms', next);
  };

  return (
    <section className="brand-kit">
      <header className="brand-kit-header">
        <h1>Brand kit</h1>
        <p className="field-hint">
          Everything here shapes what gets generated for <strong>{draft.name}</strong>. Fill in what
          you can — you can come back to the rest.
        </p>
      </header>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          saveMutation.mutate(draft);
        }}
      >
        <fieldset className="brand-section">
          <legend>Basics</legend>

          <label className="field">
            <span className="field-label">Name</span>
            <input
              type="text"
              value={draft.name}
              onChange={(event) => update('name', event.target.value)}
              required
              maxLength={120}
            />
          </label>

          <label className="field">
            <span className="field-label">Website</span>
            <input
              type="url"
              value={draft.website ?? ''}
              onChange={(event) => update('website', event.target.value || null)}
              placeholder="https://"
            />
          </label>

          <label className="field">
            <span className="field-label">Time zone</span>
            <span className="field-hint">
              Posts are scheduled in this zone, so a daylight-saving change does not move them.
            </span>
            <input
              type="text"
              value={draft.timezone}
              onChange={(event) => update('timezone', event.target.value)}
              placeholder="America/New_York"
              spellCheck={false}
            />
          </label>
        </fieldset>

        <CategoryPicker
          value={draft.categoryId}
          onChange={(categoryId) => update('categoryId', categoryId)}
        />

        <fieldset className="brand-section">
          <legend>Where you post</legend>
          <div className="platform-toggles">
            {PLATFORMS.map((platform) => (
              <label key={platform} className="platform-toggle">
                <input
                  type="checkbox"
                  checked={draft.targetPlatforms.includes(platform)}
                  onChange={() => togglePlatform(platform)}
                />
                <span>{platform.charAt(0) + platform.slice(1).toLowerCase()}</span>
              </label>
            ))}
          </div>
          <p className="field-hint">
            Connecting the accounts themselves comes later — this is just where content is aimed.
          </p>
        </fieldset>

        <PaletteEditor
          value={draft.palette}
          onChange={(palette) => update('palette', palette)}
          onSuggestFromLogo={async (file) => {
            try {
              update('palette', await suggestPalette(draft.id, file));
            } catch (caught) {
              setError(caught instanceof ApiError ? caught.message : 'Could not read that image.');
            }
          }}
        />

        <TypographyEditor
          value={draft.typography}
          fonts={fontsQuery.data ?? []}
          onChange={(typography) => update('typography', typography)}
        />

        <VoiceGuideEditor
          value={draft.voiceGuide}
          onChange={(voiceGuide) => update('voiceGuide', voiceGuide)}
          onDraft={async (input) => {
            await draftVoiceMutation.mutateAsync(input);
          }}
          drafting={draftVoiceMutation.isPending}
        />

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}

        <div className="brand-kit-actions">
          <button type="submit" disabled={saveMutation.isPending}>
            {saveMutation.isPending ? 'Saving…' : 'Save brand kit'}
          </button>
          {saved && <span className="form-success">Saved.</span>}
        </div>
      </form>

      <AssetLibrary />
    </section>
  );
}
