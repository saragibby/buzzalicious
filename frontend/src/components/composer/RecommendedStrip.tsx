import { useMemo } from 'react';
import {
  archetypeLabel,
  explanationText,
  useRecommendations,
  type ArchetypeRecommendation,
} from '../../lib/recommendApi';
import type { RankedTemplate } from '../../lib/composerApi';

/**
 * "Recommended for you" — the feedback loop made visible.
 *
 * ## This strip is additive, and that is a guardrail rather than a layout choice
 *
 * `docs/06` requires that the gallery is **never** collapsed to recommendations only:
 * `template acceptance rate` is a success metric, and a rate needs alternatives to exist
 * before it can measure anything. So this renders *above* the full grid and never filters
 * it. The grid is not conditional on this component's state — if the query fails, the
 * strip disappears and the library is still fully there.
 *
 * ## Exploration is labelled, not hidden
 *
 * Some slots are deliberately under-explored picks rather than the best-known option. They
 * say so. Users tolerate experimentation they were told about, and an unlabelled
 * experiment that underperforms reads as the product being wrong rather than the product
 * learning.
 *
 * ## Why no number is rendered from `value`
 *
 * `value` is a *shrunk* estimate — partly this brand, partly a prior over other
 * businesses. The only figure shown is `explanation.multiplier`, which the backend takes
 * from the raw observed mean and only supplies once two separate gates pass (enough
 * sample, big enough effect). Rendering `value` as "1.9× your average" would be publishing
 * other businesses' data as this brand's measurement.
 */

interface Props {
  brandId: string;
  templates: RankedTemplate[];
  onUse: (template: RankedTemplate) => void;
  pendingSlug: string | null;
  isPending: boolean;
}

const MAX_SHOWN = 3;

export function RecommendedStrip({ brandId, templates, onUse, pendingSlug, isPending }: Props) {
  const { data, isLoading, isError } = useRecommendations(brandId);

  const picks = useMemo(() => {
    // Tolerates a response without an `archetypes` array rather than throwing. A render
    // crash here would take the whole template library down with it, which is the opposite
    // of the additive guarantee this component is supposed to provide.
    if (!data || !Array.isArray(data.archetypes)) return [];

    const byId = new Map(templates.map((template) => [template.id, template]));

    const resolved: { item: ArchetypeRecommendation; template: RankedTemplate }[] = [];
    for (const item of data.archetypes) {
      // An archetype with no template in the *currently filtered* library cannot be acted
      // on, so it is skipped rather than rendered as a dead card. The recommendation is
      // still correct; there is just nothing here to press.
      const template = item.templateIds.map((id) => byId.get(id)).find(Boolean);
      if (template) resolved.push({ item, template });
      if (resolved.length === MAX_SHOWN) break;
    }
    return resolved;
  }, [data, templates]);

  // Silent on failure, deliberately. A recommendation is an enhancement to a library that
  // works without it, so an error banner here would make the loop's absence louder than
  // the loop's presence.
  if (isLoading || isError || picks.length === 0) return null;

  return (
    <section className="recommend-strip" aria-labelledby="recommend-heading">
      <h2 id="recommend-heading">Recommended for you</h2>

      <ul className="recommend-list">
        {picks.map(({ item, template }) => (
          <li key={item.archetype}>
            <article className="recommend-card">
              <h3>{archetypeLabel(item.archetype)}</h3>

              {item.selection === 'explore' ? (
                <p className="recommend-badge">Trying something new</p>
              ) : null}

              <p className="recommend-why">{explanationText(item)}</p>
              <p className="recommend-template">via {template.name}</p>

              <button
                type="button"
                disabled={isPending && pendingSlug === template.slug}
                onClick={() => onUse(template)}
              >
                {isPending && pendingSlug === template.slug ? 'Starting…' : 'Use this'}
              </button>
            </article>
          </li>
        ))}
      </ul>

      <p className="recommend-footnote">
        Based on your measured results. The full library is below — recommendations never replace
        it.
      </p>
    </section>
  );
}
