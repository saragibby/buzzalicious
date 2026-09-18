import { useMemo, useState } from 'react';
import {
  useAdminTrends,
  useRecordObservation,
  useRescore,
  useReviewMapping,
  useSaveCuration,
  type AdminTrend,
  type ObservationInput,
  type SuggestedAngle,
  type TrendKind,
} from '../../lib/trends';
import { ApiError } from '../../lib/api';

/**
 * The weekly curation workspace.
 *
 * Shaped around the pass a person actually makes — what still needs an angle, what the
 * classifier wasn't sure about, what's new this week — rather than around rows in a table.
 * The two counts at the top are the job; the list beneath is how you do it.
 *
 * The manual collector is not a placeholder for the automated one. A weekly pass by
 * someone who understands small-business marketing beats a naive automated feed, and it is
 * the only source of signals to score while collectors mature.
 */

const KINDS: TrendKind[] = ['HASHTAG', 'SOUND', 'FORMAT', 'TOPIC'];
const PLATFORMS = ['INSTAGRAM', 'FACEBOOK', 'THREADS', 'X'] as const;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function ObservationForm({ onDone }: { onDone: () => void }) {
  const record = useRecordObservation();
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<TrendKind>('TOPIC');
  const [platform, setPlatform] = useState<string>('');
  const [description, setDescription] = useState('');
  const [exampleUrl, setExampleUrl] = useState('');
  const [observedOn, setObservedOn] = useState(todayIso());
  const [volume, setVolume] = useState('');
  const [engagement, setEngagement] = useState('');
  const [sourceNote, setSourceNote] = useState('');

  const submit = (event: React.FormEvent) => {
    event.preventDefault();

    const metrics: Record<string, number> = {};
    // Blank stays absent rather than becoming zero. A curator who didn't measure
    // engagement has not observed that it was zero, and scoring treats those differently.
    if (volume.trim()) metrics.volume = Number(volume);
    if (engagement.trim()) metrics.engagement = Number(engagement);

    const input: ObservationInput = {
      title: title.trim(),
      kind,
      platform: platform || null,
      externalRef: null,
      description: description.trim() || null,
      exampleUrls: exampleUrl.trim() ? [exampleUrl.trim()] : [],
      observedAt: new Date(`${observedOn}T12:00:00Z`).toISOString(),
      metrics,
      ...(sourceNote.trim() ? { sourceNote: sourceNote.trim() } : {}),
    };

    record.mutate(input, {
      onSuccess: () => {
        setTitle('');
        setDescription('');
        setExampleUrl('');
        setVolume('');
        setEngagement('');
        onDone();
      },
    });
  };

  return (
    <form className="curate-form" onSubmit={submit}>
      <h2>Record what you saw</h2>
      <p className="curate-form-hint">
        Recording the same trend again next week appends a second data point — that’s what makes a
        velocity. It never overwrites the first.
      </p>

      <label>
        What is it
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Shoulder-season value posts"
          required
          minLength={3}
        />
      </label>

      <div className="curate-form-row">
        <label>
          Kind
          <select value={kind} onChange={(e) => setKind(e.target.value as TrendKind)}>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {k.toLowerCase()}
              </option>
            ))}
          </select>
        </label>

        <label>
          Platform
          <select value={platform} onChange={(e) => setPlatform(e.target.value)}>
            <option value="">any platform</option>
            {PLATFORMS.map((p) => (
              <option key={p} value={p}>
                {p.toLowerCase()}
              </option>
            ))}
          </select>
        </label>

        <label>
          Seen on
          <input type="date" value={observedOn} onChange={(e) => setObservedOn(e.target.value)} />
        </label>
      </div>

      <label>
        What’s actually happening
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          placeholder="Off-peak pricing framed as “same place, half the people”."
        />
      </label>

      <div className="curate-form-row">
        <label>
          Volume seen
          <input
            type="number"
            min={0}
            value={volume}
            onChange={(e) => setVolume(e.target.value)}
            placeholder="leave blank if unknown"
          />
        </label>

        <label>
          Engagement seen
          <input
            type="number"
            min={0}
            value={engagement}
            onChange={(e) => setEngagement(e.target.value)}
            placeholder="leave blank if unknown"
          />
        </label>
      </div>

      <label>
        Example link
        <input
          type="url"
          value={exampleUrl}
          onChange={(e) => setExampleUrl(e.target.value)}
          placeholder="https://…"
        />
      </label>

      <label>
        Where you found it
        <input
          value={sourceNote}
          onChange={(e) => setSourceNote(e.target.value)}
          placeholder="Weekly pass — saw it across three rental accounts"
        />
      </label>

      <button type="submit" disabled={record.isPending}>
        {record.isPending ? 'Recording…' : 'Record observation'}
      </button>

      {record.isError ? <p className="curate-error">{(record.error as Error).message}</p> : null}
    </form>
  );
}

function AngleEditor({ trend }: { trend: AdminTrend }) {
  const save = useSaveCuration();
  const [defaultAngle, setDefaultAngle] = useState(trend.curation?.defaultAngle ?? '');
  const [angles, setAngles] = useState<SuggestedAngle[]>(trend.curation?.angles ?? []);
  const [rationale, setRationale] = useState(trend.curation?.rationale ?? '');
  const [newSlug, setNewSlug] = useState('');
  const [newAngle, setNewAngle] = useState('');

  const addAngle = () => {
    if (!newSlug.trim() || newAngle.trim().length < 20) return;
    setAngles([...angles, { categorySlug: newSlug.trim(), angle: newAngle.trim() }]);
    setNewSlug('');
    setNewAngle('');
  };

  return (
    <div className="curate-angles">
      <h4>Suggested angle</h4>
      <p className="curate-form-hint">
        A trend with no angle is withheld from every feed. “What would this business actually post?”
        — not a list of hashtags.
      </p>

      <label>
        Default angle (used for any category without its own)
        <textarea
          value={defaultAngle}
          onChange={(e) => setDefaultAngle(e.target.value)}
          rows={2}
          placeholder="Post the same view in February and July with the price under each one."
        />
      </label>

      {angles.length > 0 ? (
        <ul className="curate-angle-list">
          {angles.map((angle, index) => (
            <li key={`${angle.categorySlug}-${index}`}>
              <code>{angle.categorySlug}</code>
              <span>{angle.angle}</span>
              <button
                type="button"
                onClick={() => setAngles(angles.filter((_, i) => i !== index))}
                aria-label={`Remove angle for ${angle.categorySlug}`}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="curate-form-row">
        <label>
          Category slug
          <input
            value={newSlug}
            onChange={(e) => setNewSlug(e.target.value)}
            placeholder="vacation-rental"
          />
        </label>
        <label>
          Angle for that category
          <input
            value={newAngle}
            onChange={(e) => setNewAngle(e.target.value)}
            placeholder="At least a sentence a person could act on"
          />
        </label>
        <button type="button" onClick={addAngle}>
          Add
        </button>
      </div>

      <label>
        Why you picked this (for the next curator, not the user)
        <input value={rationale} onChange={(e) => setRationale(e.target.value)} />
      </label>

      <button
        type="button"
        disabled={save.isPending}
        onClick={() =>
          save.mutate({
            trendId: trend.id,
            angles,
            ...(defaultAngle.trim() ? { defaultAngle: defaultAngle.trim() } : {}),
            ...(rationale.trim() ? { rationale: rationale.trim() } : {}),
          })
        }
      >
        {save.isPending ? 'Saving…' : 'Save angles'}
      </button>

      {save.isError ? <p className="curate-error">{(save.error as Error).message}</p> : null}
    </div>
  );
}

function TrendRow({ trend }: { trend: AdminTrend }) {
  const [open, setOpen] = useState(false);
  const review = useReviewMapping();

  return (
    <li className="curate-row">
      <button type="button" className="curate-row-head" onClick={() => setOpen(!open)}>
        <span className="curate-row-title">{trend.title}</span>
        <span className="curate-row-meta">
          {trend.status.toLowerCase()} · {trend.signalCount} observation
          {trend.signalCount === 1 ? '' : 's'} · {trend.categoryScoreCount} categories
        </span>
        <span className="curate-row-flags">
          {trend.hasAngle ? null : <em className="curate-flag-warn">needs an angle</em>}
          {trend.needsReview ? <em className="curate-flag-warn">check category</em> : null}
        </span>
      </button>

      {open ? (
        <div className="curate-row-body">
          {trend.description ? <p>{trend.description}</p> : null}

          {trend.mapping ? (
            <div className="curate-mapping">
              <h4>Category mapping</h4>
              <p>
                {trend.mapping.method} · {Math.round(trend.mapping.confidence * 100)}% confident ·{' '}
                {trend.mapping.reviewStatus.toLowerCase().replace(/_/g, ' ')}
              </p>
              <ul>
                {trend.mapping.evidence.slice(0, 5).map((item) => (
                  <li key={item.categorySlug}>
                    <code>{item.categorySlug}</code> — {item.reason}
                  </li>
                ))}
              </ul>

              {/* Confirming or rejecting sticks: a later re-map won't overwrite it. */}
              {trend.needsReview ? (
                <div className="curate-review-actions">
                  <button
                    type="button"
                    onClick={() => review.mutate({ trendId: trend.id, reviewStatus: 'CONFIRMED' })}
                  >
                    Mapping is right
                  </button>
                  <button
                    type="button"
                    onClick={() => review.mutate({ trendId: trend.id, reviewStatus: 'REJECTED' })}
                  >
                    Wrong — keep it out of feeds
                  </button>
                </div>
              ) : null}
            </div>
          ) : (
            <p className="curate-form-hint">Not classified yet.</p>
          )}

          <AngleEditor trend={trend} />
        </div>
      ) : null}
    </li>
  );
}

export function TrendCurate() {
  const [search, setSearch] = useState('');
  const [onlyNeedsReview, setOnlyNeedsReview] = useState(false);
  const trends = useAdminTrends({
    ...(search.trim() ? { search: search.trim() } : {}),
    needsReview: onlyNeedsReview,
  });
  const rescore = useRescore();

  const counts = useMemo(() => {
    const items = trends.data?.trends ?? [];
    return {
      total: items.length,
      missingAngle: items.filter((t) => !t.hasAngle).length,
      needsReview: items.filter((t) => t.needsReview).length,
    };
  }, [trends.data]);

  // A non-admin gets an explanation, not a broken page. The allow list is fail-closed, so
  // this is the expected state for most signed-in users rather than an error.
  if (trends.isError && trends.error instanceof ApiError && trends.error.status === 403) {
    return (
      <section className="curate-page">
        <h1>Trend curation</h1>
        <p className="curate-empty">
          Curation writes trends that every workspace reads, so it’s limited to platform
          administrators. Ask to be added to <code>TREND_ADMIN_EMAILS</code>.
        </p>
      </section>
    );
  }

  return (
    <section className="curate-page">
      <header className="curate-head">
        <div>
          <h1>Trend curation</h1>
          <p className="curate-subtitle">
            The weekly pass. {counts.missingAngle} need an angle · {counts.needsReview} need a
            category check · {counts.total} tracked.
          </p>
        </div>
        <button
          type="button"
          onClick={() => rescore.mutate(false)}
          disabled={rescore.isPending}
          title="Recomputes every score from the full signal history"
        >
          {rescore.isPending ? 'Rescoring…' : 'Rescore all'}
        </button>
      </header>

      {rescore.data && !rescore.data.dryRun ? (
        <p className="curate-note">
          Rescored {rescore.data.total} trends, {rescore.data.changed} changed.
        </p>
      ) : null}

      <ObservationForm onDone={() => setSearch('')} />

      <div className="curate-filters">
        <label>
          Search
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="tax, rental…"
          />
        </label>
        <label className="curate-checkbox">
          <input
            type="checkbox"
            checked={onlyNeedsReview}
            onChange={(e) => setOnlyNeedsReview(e.target.checked)}
          />
          Only ones needing a category check
        </label>
      </div>

      {trends.isLoading ? <p className="curate-empty">Loading…</p> : null}
      {trends.isError && !(trends.error instanceof ApiError && trends.error.status === 403) ? (
        <p className="curate-error">{(trends.error as Error).message}</p>
      ) : null}

      <ul className="curate-list">
        {trends.data?.trends.map((trend) => (
          <TrendRow key={trend.id} trend={trend} />
        ))}
      </ul>

      {trends.data && trends.data.trends.length === 0 ? (
        <p className="curate-empty">Nothing matches. Record what you saw above.</p>
      ) : null}
    </section>
  );
}

export default TrendCurate;
