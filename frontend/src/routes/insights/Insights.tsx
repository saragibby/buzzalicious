import { useState } from 'react';
import { useCurrentBrand } from '../../lib/scope';
import {
  formatMetric,
  useInsights,
  useMetricTimeline,
  type OutcomeGroup,
  type TargetOutcome,
} from '../../lib/insights';

/**
 * The insights screen.
 *
 * Two rules shape every decision in this file, and both are about what *not* to render:
 *
 * 1. **A zero is a lie.** An unreported metric shows an em dash and, on hover, why —
 *    never `0`. Metric availability varies sharply by platform and account tier, so this
 *    is the common case rather than an edge one.
 * 2. **A ranking without a sample is noise wearing a ranking's clothes.** Every group
 *    shows how many posts it rests on, and the headline is absent — with an explanation —
 *    whenever the server refused to name one. Users read a confident sentence as a
 *    finding; the cost of an unearned one is that they change what they make.
 */

const WINDOWS = [7, 30, 90];

function scoreLabel(value: number | null): string {
  if (value === null) return '—';
  return value.toFixed(1);
}

function GroupTable({
  title,
  groups,
  labelFor,
  emptyHint,
}: {
  title: string;
  groups: OutcomeGroup[];
  labelFor: (key: string) => string;
  emptyHint: string;
}) {
  if (groups.length === 0) {
    return (
      <section className="insight-panel">
        <h2>{title}</h2>
        <p className="insight-empty">{emptyHint}</p>
      </section>
    );
  }

  const ranked = [...groups].sort((a, b) => (b.meanScore ?? -1) - (a.meanScore ?? -1));

  return (
    <section className="insight-panel">
      <h2>{title}</h2>
      <table className="insight-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Score</th>
            <th>Clicks</th>
            <th>Posts</th>
          </tr>
        </thead>
        <tbody>
          {ranked.map((group) => (
            <tr key={group.key}>
              <td>{labelFor(group.key)}</td>
              <td>
                {scoreLabel(group.meanScore)}
                {group.meanScore !== null && group.sharedComponents.length === 0 ? (
                  <span
                    className="insight-flag"
                    title="These posts were measured on different metrics, so this average mixes things that are not comparable. Shown for context, not for ranking."
                  >
                    mixed
                  </span>
                ) : null}
              </td>
              <td>
                {group.clicks === null || group.clicks.measured === 0
                  ? '—'
                  : group.clicks.clicks.toLocaleString()}
              </td>
              <td>
                {group.scored}
                {group.unscored > 0 ? (
                  <span
                    className="insight-muted"
                    title={`${group.unscored} more published with nothing measurable yet. They are not counted as zeros.`}
                  >
                    {' '}
                    +{group.unscored} unmeasured
                  </span>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function ageLabel(hours: number | null): string {
  if (hours === null) return '—';
  return hours < 48 ? `${Math.round(hours)}h` : `${Math.round(hours / 24)}d`;
}

function Timeline({ brandId, postTargetId }: { brandId: string; postTargetId: string }) {
  const { data, isLoading } = useMetricTimeline(brandId, postTargetId);

  if (isLoading) return <p className="insight-empty">Loading history…</p>;

  const points = data?.points ?? [];
  if (points.length === 0) {
    return (
      <p className="insight-empty">
        No snapshots yet. The first poll runs an hour after publishing.
      </p>
    );
  }

  return (
    <table className="insight-table insight-timeline">
      <thead>
        <tr>
          <th>Age</th>
          <th>Clicks</th>
          <th>Reach</th>
          <th>Likes</th>
          <th>Comments</th>
          <th>Shares</th>
          <th>Saves</th>
        </tr>
      </thead>
      <tbody>
        {points.map((point) => (
          <tr key={point.capturedAt}>
            <td>{ageLabel(point.hoursSincePublish)}</td>
            <td>{formatMetric(point.linkClicks)}</td>
            <td>{formatMetric(point.reach)}</td>
            <td>{formatMetric(point.likes)}</td>
            <td>{formatMetric(point.comments)}</td>
            <td>{formatMetric(point.shares)}</td>
            <td>{formatMetric(point.saves)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PostRow({
  brandId,
  target,
  isOpen,
  onToggle,
}: {
  brandId: string;
  target: TargetOutcome;
  isOpen: boolean;
  onToggle: () => void;
}) {
  return (
    <li>
      <button type="button" className="insight-post-row" onClick={onToggle} aria-expanded={isOpen}>
        <span className="insight-post-title">{target.postTitle ?? 'Untitled post'}</span>
        <span className="insight-post-meta">
          {target.platform.toLowerCase()}
          {' · '}
          {target.capturedAt === null
            ? 'not measured yet'
            : `score ${scoreLabel(target.outcome.score)}`}
        </span>
        <span className="insight-post-clicks">
          {target.linkClicks === null ? (
            <span
              className="insight-muted"
              title="This platform does not carry a tracked link in the caption, so clicks cannot be measured here. That is not the same as nobody clicking."
            >
              clicks n/a
            </span>
          ) : (
            `${target.linkClicks.toLocaleString()} clicks`
          )}
        </span>
      </button>
      {isOpen ? <Timeline brandId={brandId} postTargetId={target.postTargetId} /> : null}
    </li>
  );
}

export function Insights() {
  const brand = useCurrentBrand();
  const [days, setDays] = useState(30);
  const [openTargetId, setOpenTargetId] = useState<string | null>(null);

  const { data, isLoading, error } = useInsights(brand?.id ?? null, days);

  if (!brand) {
    return (
      <section className="insight-page">
        <h1>Insights</h1>
        <p className="insight-empty">Pick a brand to see how its posts performed.</p>
      </section>
    );
  }

  if (isLoading) {
    return (
      <section className="insight-page">
        <h1>Insights</h1>
        <p className="insight-empty">Loading…</p>
      </section>
    );
  }

  if (error || !data) {
    return (
      <section className="insight-page">
        <h1>Insights</h1>
        <p className="insight-error">Could not load insights. Try again in a moment.</p>
      </section>
    );
  }

  // Template ids are opaque, so names come from the targets that used them. A template
  // whose posts are all outside the window simply is not in `byTemplate` either.
  const templateNames = new Map<string, string>();
  for (const target of data.targets) {
    if (target.templateId && target.templateName) {
      templateNames.set(target.templateId, target.templateName);
    }
  }

  return (
    <section className="insight-page">
      <header className="insight-head">
        <h1>Insights</h1>
        <div className="insight-windows">
          {WINDOWS.map((option) => (
            <button
              key={option}
              type="button"
              className={option === days ? 'is-selected' : undefined}
              onClick={() => setDays(option)}
            >
              {option} days
            </button>
          ))}
        </div>
      </header>

      <section className="insight-headline">
        {data.headline ? (
          <p>
            Your best {data.headline.kind} is scoring{' '}
            <strong>{scoreLabel(data.headline.meanScore)}</strong> across {data.headline.scored}{' '}
            posts — ahead of the next one at {scoreLabel(data.headline.runnerUpScore)}.
          </p>
        ) : (
          <p className="insight-empty">
            Not enough comparable posts yet to say what is working. Keep publishing — this fills
            in once a few posts have been measured the same way.
          </p>
        )}
      </section>

      <GroupTable
        title="By platform"
        groups={data.byPlatform}
        labelFor={(key) => key.toLowerCase()}
        emptyHint="Nothing published in this window."
      />

      <GroupTable
        title="By template"
        groups={data.byTemplate}
        labelFor={(key) => templateNames.get(key) ?? 'Deleted template'}
        emptyHint="No template-built posts published in this window."
      />

      <section className="insight-panel">
        <h2>Posts</h2>
        {data.targets.length === 0 ? (
          <p className="insight-empty">Nothing published in this window.</p>
        ) : (
          <ul className="insight-posts">
            {data.targets.map((target) => (
              <PostRow
                key={target.postTargetId}
                brandId={brand.id}
                target={target}
                isOpen={openTargetId === target.postTargetId}
                onToggle={() =>
                  setOpenTargetId(
                    openTargetId === target.postTargetId ? null : target.postTargetId,
                  )
                }
              />
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}
