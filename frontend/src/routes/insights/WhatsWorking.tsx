import {
  archetypeLabel,
  explanationText,
  useRecommendations,
  type Recommendations,
} from '../../lib/recommendApi';

/**
 * "What's working, and what to do about it."
 *
 * ## Why this reads the recommendation endpoint rather than recomputing anything
 *
 * The brief requires the insights summary and the composer's recommendations to be
 * *"driven by the same scoring, so the two can never disagree."* The only version of that
 * which stays true is structural: this panel calls the same endpoint the composer calls.
 * A second implementation that merely used the same formula would agree on the day it was
 * written and drift the first time either side changed — and the disagreement would show
 * up to the user as the product contradicting itself about their own business.
 *
 * ## Nulls stay nulls
 *
 * A cadence with no measurable history is `null`, and renders as "not enough history yet",
 * never as a suggested number. A cadence figure invented from no evidence is the one
 * output here a brand can act on to its own detriment.
 */

function cadenceSentence(cadence: Recommendations['cadence'] | null): string {
  if (!cadence?.suggested) {
    return 'Not enough measured weeks yet to suggest a posting frequency.';
  }

  const { minPerWeek, maxPerWeek } = cadence.suggested;
  const range =
    minPerWeek === maxPerWeek
      ? `${minPerWeek} post${minPerWeek === 1 ? '' : 's'} a week`
      : `${minPerWeek}–${maxPerWeek} posts a week`;

  const current =
    cadence.currentPerWeek === null
      ? ''
      : ` You're averaging ${cadence.currentPerWeek} a week right now.`;

  const cliff =
    cadence.fatigueAbove === null
      ? ''
      : ` Weeks above ${cadence.fatigueAbove} posts have done worse, not better.`;

  return `Based on your total weekly results, ${range} looks right.${current}${cliff}`;
}

export function WhatsWorking({ brandId }: { brandId: string }) {
  const { data, isLoading, isError } = useRecommendations(brandId);

  if (isLoading) return <p className="insight-muted">Working out what to suggest…</p>;
  if (isError || !data) return null;

  // Every field is read defensively, and that is not paranoia about `any`. This panel is
  // *additive* to a page that already works: the metric timeline and outcome tables below
  // it stand on their own. If a recommendation payload is partial — an older server, a
  // narrowed response, a field this workstream adds later — the correct behaviour is for
  // this section to say less, not for the whole Insights page to white-screen. A crash
  // here would take down the numbers the user actually came for in order to fail at
  // *suggesting* something, which is exactly backwards.
  const ranked = Array.isArray(data.archetypes) ? data.archetypes : [];
  const sendTime = data.sendTime ?? null;
  const cadence = data.cadence ?? null;

  // Exploration picks are excluded from *this* list specifically. The composer shows them
  // because their whole purpose is to get posted; here the question is "what is working",
  // and an untested candidate is not an answer to it. The same data, two honest readings.
  const working = ranked.filter((item) => item.selection === 'exploit').slice(0, 3);

  return (
    <section className="insight-panel" aria-labelledby="whats-working">
      <h2 id="whats-working">What&rsquo;s working</h2>

      {working.length === 0 ? (
        <p className="insight-empty">
          Nothing has enough measured posts behind it yet. This fills in as results come back.
        </p>
      ) : (
        <ul className="insight-working">
          {working.map((item) => (
            <li key={item.archetype}>
              <strong>{archetypeLabel(item.archetype)}</strong>
              <span>{explanationText(item)}</span>
            </li>
          ))}
        </ul>
      )}

      <h3>When to post</h3>
      {sendTime?.suggested ? (
        <p>
          {sendTime.suggested.local.replace('T', ' at ')} ({sendTime.suggested.timeZone})
          {sendTime.selection === 'explore' ? ' — a time we haven’t tested for you yet.' : '.'}
        </p>
      ) : (
        <p className="insight-empty">No suggested time yet.</p>
      )}

      <h3>How often</h3>
      <p>{cadenceSentence(cadence)}</p>
    </section>
  );
}
