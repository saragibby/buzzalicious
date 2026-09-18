import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ApiError } from '../../lib/api';
import { PLATFORMS, type Platform } from '../../lib/brandApi';
import { useScope } from '../../lib/scope';
import {
  createDraft,
  fetchTemplates,
  templatesQueryKey,
  type RankedTemplate,
} from '../../lib/composerApi';
import { RecommendedStrip } from '../../components/composer/RecommendedStrip';

/**
 * The template gallery — the first screen of the core loop.
 *
 * Ranked, not listed. Industry relevance is the product's wedge (docs/00): the same
 * gallery shown to a landscaper and a tax practice should not open with the same template,
 * and the ranking that makes that true lives server-side in `relevance.ts`. This screen's
 * job is to *show its work* — a template that ranked because the brand's category asked
 * for it says so, so the ordering reads as knowledge rather than as randomness.
 *
 * ## Empty states are the feature here
 *
 * Three of them, and each has a different cause and a different fix:
 *
 *  - no brand at all — onboarding is incomplete, send them to it;
 *  - a brand with no category — ranking has nothing to rank against, so the list is
 *    honest about being generic and links to the one field that fixes it;
 *  - filters that match nothing — the filters are the problem, not the library.
 *
 * Collapsing these into one "no results" would leave the most fixable case with no fix.
 */

export function TemplateGallery() {
  const { brand, isLoading: scopeLoading } = useScope();
  const navigate = useNavigate();

  const [platform, setPlatform] = useState<Platform | ''>('');
  const [creating, setCreating] = useState<string | null>(null);

  const filters = {
    categoryId: brand?.categoryId ?? undefined,
    platform: platform || undefined,
  };

  const templatesQuery = useQuery({
    queryKey: templatesQueryKey({ categoryId: filters.categoryId, platform: filters.platform }),
    queryFn: () => fetchTemplates(filters),
    enabled: Boolean(brand),
  });

  const create = useMutation({
    mutationFn: (template: RankedTemplate) =>
      createDraft(brand!.id, { templateSlug: template.slug }),
    onSuccess: (draft) => navigate(`/composer/${draft.id}`),
  });

  if (scopeLoading) {
    return <p className="composer-muted">Loading…</p>;
  }

  if (!brand) {
    return (
      <section className="composer-gallery">
        <h1>Create a post</h1>
        <p className="composer-empty">
          You need a brand before you can make a post — it is where your colours, fonts and voice
          come from. <Link to="/brand">Set up your brand kit</Link> and come back.
        </p>
      </section>
    );
  }

  const templates = templatesQuery.data ?? [];

  return (
    <section className="composer-gallery">
      <header className="composer-gallery-head">
        <h1>Create a post</h1>
        <p className="composer-muted">
          {brand.categoryId
            ? `Ordered for ${brand.name}, most relevant first.`
            : 'Ordered alphabetically.'}
        </p>
      </header>

      {!brand.categoryId ? (
        <p className="composer-notice">
          {brand.name} does not have an industry set, so these are in no particular order.{' '}
          <Link to="/brand">Pick your industry</Link> and this list will lead with what works for
          businesses like yours.
        </p>
      ) : null}

      <div className="composer-filters">
        <label className="field-label" htmlFor="platform-filter">
          Show templates I can post to
        </label>
        <select
          id="platform-filter"
          value={platform}
          onChange={(event) => setPlatform(event.target.value as Platform | '')}
        >
          <option value="">Any platform</option>
          {PLATFORMS.map((candidate) => (
            <option key={candidate} value={candidate}>
              {candidate.charAt(0) + candidate.slice(1).toLowerCase()}
            </option>
          ))}
        </select>
      </div>

      {templatesQuery.isLoading ? <p className="composer-muted">Loading templates…</p> : null}

      {templatesQuery.isError ? (
        <p className="composer-error" role="alert">
          The template library could not be loaded.{' '}
          <button
            type="button"
            className="link-button"
            onClick={() => void templatesQuery.refetch()}
          >
            Try again
          </button>
        </p>
      ) : null}

      {create.isError ? (
        <p className="composer-error" role="alert">
          {create.error instanceof ApiError
            ? create.error.message
            : 'That draft could not be started. Try again.'}
        </p>
      ) : null}

      {!templatesQuery.isLoading && !templatesQuery.isError && templates.length === 0 ? (
        <p className="composer-empty">
          {platform
            ? `No templates fit ${platform.charAt(0) + platform.slice(1).toLowerCase()} yet. Clear the filter to see everything.`
            : 'There are no templates in the library yet.'}
        </p>
      ) : null}

      {/* Above the grid, never instead of it. The grid below is not conditional on
          anything this renders -- see the guardrail note in RecommendedStrip. */}
      <RecommendedStrip
        brandId={brand.id}
        templates={templates}
        pendingSlug={creating}
        isPending={create.isPending}
        onUse={(template) => {
          setCreating(template.slug);
          create.mutate(template);
        }}
      />

      <ul className="template-grid">
        {templates.map((template) => (
          <li key={template.id}>
            <article className="template-card">
              <h2>{template.name}</h2>
              {template.description ? (
                <p className="template-card-description">{template.description}</p>
              ) : null}

              <p className="template-card-meta">
                {template.archetype.toLowerCase().replace(/_/g, ' ')} ·{' '}
                {template.supportedRatios.length} size
                {template.supportedRatios.length === 1 ? '' : 's'}
              </p>

              {/* Only claimed when there is a category match to point at — see the
                  `inherited`/`matchedCategoryId` pairing in relevance.ts. */}
              {template.matchedCategoryId ? (
                <p className="template-card-why">
                  {template.inherited
                    ? 'Works for businesses like yours'
                    : 'Popular in your industry'}
                </p>
              ) : null}

              <button
                type="button"
                disabled={create.isPending && creating === template.slug}
                onClick={() => {
                  setCreating(template.slug);
                  create.mutate(template);
                }}
              >
                {create.isPending && creating === template.slug ? 'Starting…' : 'Use this'}
              </button>
            </article>
          </li>
        ))}
      </ul>
    </section>
  );
}
