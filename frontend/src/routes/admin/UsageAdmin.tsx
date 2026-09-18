import { useMemo, useState } from 'react';
import { formatCount, formatUsd, useUsagePeriod, type WorkspaceUsage } from '../../lib/usage';

/**
 * Platform usage, read-only.
 *
 * The question this page exists to answer is **"who ran out, and on what?"** — so that is
 * what it leads with, before any table. An admin view that makes you scan twelve rows to
 * find the exhausted one has failed at its only job.
 *
 * Read-only on purpose (ADR-0011). There is no control here to raise a ceiling or void an
 * event; changing what someone is charged needs an audit trail, and that is a decision for
 * whoever answers Q13 rather than something to acquire because a button was easy to add.
 */

function currentPeriodKey(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

function shiftPeriod(period: string, months: number): string {
  const [year, month] = period.split('-').map(Number);
  const date = new Date(Date.UTC(year!, month! - 1 + months, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function UsageRow({ workspace }: { workspace: WorkspaceUsage }) {
  const percent = Math.round(workspace.aiUtilization * 100);

  return (
    <li className={`usage-row${workspace.exhausted ? ' usage-row-exhausted' : ''}`}>
      <div className="usage-row-head">
        <span className="usage-row-name">
          {workspace.workspaceName}
          {workspace.isPlatformWorkspace ? (
            <span
              className="usage-tag"
              title="Platform-global AI work — trend classification, not any one client's spend"
            >
              platform
            </span>
          ) : null}
        </span>
        <span className="usage-row-spend">
          {formatUsd(workspace.aiSpendUsd)} / {formatUsd(workspace.aiCeilingUsd)}
          {workspace.exhausted ? <strong className="usage-row-flag"> exhausted</strong> : null}
        </span>
      </div>

      <div className="usage-bar" role="img" aria-label={`${percent}% of AI ceiling used`}>
        <span
          className="usage-bar-fill"
          style={{ width: `${Math.min(percent, 100)}%` }}
          data-over={workspace.exhausted ? 'true' : 'false'}
        />
      </div>

      <dl className="usage-metrics">
        {workspace.metrics.length === 0 ? (
          <span className="usage-empty">No usage recorded this period.</span>
        ) : (
          workspace.metrics.map((metric) => (
            <div key={metric.metric} className="usage-metric">
              <dt>{metric.metric.replace(/_/g, ' ').toLowerCase()}</dt>
              <dd>
                {formatCount(metric.quantity)}
                <span className="usage-metric-sub">
                  {formatCount(metric.eventCount)} events · {formatUsd(metric.providerCostUsd)}
                </span>
              </dd>
            </div>
          ))
        )}
      </dl>
    </li>
  );
}

export function UsageAdmin() {
  const [period, setPeriod] = useState(currentPeriodKey());
  const { data, isLoading, isError, error } = useUsagePeriod(period);

  const isCurrent = useMemo(() => period === currentPeriodKey(), [period]);

  return (
    <section className="usage-admin">
      <header className="usage-header">
        <div>
          <h1>Usage</h1>
          <p className="usage-hint">
            What the platform consumed, per workspace. Costs are what providers charged us, not what
            anyone is billed — pricing is still an open question.
          </p>
        </div>
        <div className="usage-period">
          <button type="button" onClick={() => setPeriod(shiftPeriod(period, -1))}>
            ← Previous
          </button>
          <span>{period}</span>
          <button
            type="button"
            disabled={isCurrent}
            onClick={() => setPeriod(shiftPeriod(period, 1))}
          >
            Next →
          </button>
        </div>
      </header>

      {isLoading ? <p className="usage-empty">Loading…</p> : null}
      {isError ? <p className="usage-error">{(error as Error).message}</p> : null}

      {data ? (
        <>
          {data.exhausted.length > 0 ? (
            <div className="usage-alert" role="alert">
              <strong>
                {data.exhausted.length === 1
                  ? '1 workspace is over its AI ceiling'
                  : `${data.exhausted.length} workspaces are over their AI ceiling`}
              </strong>
              <ul>
                {data.exhausted.map((workspace) => (
                  <li key={workspace.workspaceId}>
                    {workspace.workspaceName}
                    {workspace.isPlatformWorkspace ? ' (platform)' : ''} —{' '}
                    {formatUsd(workspace.aiSpendUsd)} of {formatUsd(workspace.aiCeilingUsd)}. New
                    generations are refused until {data.periodEnd.slice(0, 10)}.
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="usage-ok">No workspace is over its AI ceiling this period.</p>
          )}

          <ul className="usage-list">
            {data.workspaces.map((workspace) => (
              <UsageRow key={workspace.workspaceId} workspace={workspace} />
            ))}
          </ul>

          <footer className="usage-totals">
            <h2>Platform totals</h2>
            <ul>
              {data.totals.map((total) => (
                <li key={total.metric}>
                  <span>{total.metric.replace(/_/g, ' ').toLowerCase()}</span>
                  <span>
                    {formatCount(total.quantity)} · {formatCount(total.eventCount)} events ·{' '}
                    {formatUsd(total.providerCostUsd)}
                  </span>
                </li>
              ))}
            </ul>
          </footer>
        </>
      ) : null}
    </section>
  );
}
