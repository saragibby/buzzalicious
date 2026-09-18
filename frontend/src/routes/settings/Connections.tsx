import { useState } from 'react';
import { useScope } from '../../lib/scope';
import {
  describeAccountStatus,
  useConnections,
  useCredentials,
  useRevokeCredential,
  PLATFORM_LABELS,
  type Connection,
  type CredentialView,
} from '../../lib/connections';

/**
 * Settings → Connections.
 *
 * The page answers one question: *can this brand actually publish right now, and if not,
 * what do I do about it?* Everything on it is subordinate to that.
 *
 * Two consequences worth not undoing:
 *
 * **Accounts lead, credentials follow.** A user thinks in terms of "my Instagram" — not
 * "the Meta app registration that minted a token for my Instagram". So the account cards
 * are the primary content and the credentials sit underneath as the administrative layer
 * that explains *why* a group of accounts died at once.
 *
 * **Revoking asks for confirmation inline rather than through `window.confirm`.** The
 * blast radius is the point: revoking stops queued posts for every account that used the
 * credential, and a native confirm dialog cannot show that. The inline panel can name it
 * before the click.
 */

function StatusPill({ connection }: { connection: Connection }) {
  const status = describeAccountStatus(connection);
  return (
    <span className={`conn-pill conn-pill-${status.tone}`} title={status.action ?? undefined}>
      {status.title}
    </span>
  );
}

function relative(iso: string | null): string {
  if (!iso) return 'never';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'unknown';
  const minutes = Math.round((Date.now() - then) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function AccountCard({ connection }: { connection: Connection }) {
  const status = describeAccountStatus(connection);
  return (
    <article className={`conn-card${connection.needsAttention ? ' conn-card-attention' : ''}`}>
      <header className="conn-card-head">
        <div>
          <h3>{connection.displayName ?? connection.handle ?? connection.externalId}</h3>
          <p className="conn-card-meta">
            {PLATFORM_LABELS[connection.platform]}
            {connection.handle ? ` · @${connection.handle}` : ''}
          </p>
        </div>
        <StatusPill connection={connection} />
      </header>

      {status.action ? <p className="conn-card-action">{status.action}</p> : null}

      <dl className="conn-card-facts">
        <div>
          <dt>Last checked</dt>
          <dd>{relative(connection.lastValidatedAt)}</dd>
        </div>
        <div>
          <dt>Token expires</dt>
          {/* "not reported" is truthful rather than reassuring: a blank expiry means the
              platform did not tell us one, not that the token is permanent. */}
          <dd>{connection.expiresAt ? relative(connection.expiresAt) : 'not reported'}</dd>
        </div>
        <div>
          <dt>Using</dt>
          <dd>{connection.credentialLabel ?? 'Buzzalicious platform app'}</dd>
        </div>
      </dl>

      {connection.scopes.length > 0 ? (
        <p className="conn-card-scopes">
          <span>Permissions granted:</span> {connection.scopes.join(', ')}
        </p>
      ) : null}
    </article>
  );
}

function CredentialRow({
  credential,
  accounts,
  onRevoke,
  revoking,
}: {
  credential: CredentialView;
  accounts: Connection[];
  onRevoke: (credentialId: string) => void;
  revoking: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const dependents = accounts.filter((account) => account.credentialId === credential.id);
  const alreadyRevoked = credential.status === 'REVOKED';

  return (
    <li className="conn-cred">
      <div className="conn-cred-head">
        <div>
          <strong>{credential.label}</strong>
          <span className="conn-cred-meta">
            {PLATFORM_LABELS[credential.platform]} · {credential.kind.toLowerCase()} ·{' '}
            {credential.status.toLowerCase()}
          </span>
        </div>
        {alreadyRevoked ? (
          <span className="conn-pill conn-pill-bad">Revoked</span>
        ) : (
          <button type="button" className="conn-danger" onClick={() => setConfirming(true)}>
            Revoke
          </button>
        )}
      </div>

      {credential.lastError ? <p className="conn-cred-error">{credential.lastError}</p> : null}

      {confirming ? (
        <div className="conn-confirm" role="alertdialog" aria-label="Confirm revoke">
          <p>
            Revoking stops publishing for{' '}
            <strong>
              {dependents.length} account{dependents.length === 1 ? '' : 's'}
            </strong>{' '}
            in this brand and blocks anything already queued against them. Posts are not deleted and
            nothing already published is affected.
          </p>
          <p className="conn-confirm-note">
            This does not remove the app at {PLATFORM_LABELS[credential.platform]} — do that there
            too if you are rotating a leaked secret.
          </p>
          <div className="conn-confirm-actions">
            <button
              type="button"
              className="conn-danger"
              disabled={revoking}
              onClick={() => {
                onRevoke(credential.id);
                setConfirming(false);
              }}
            >
              {revoking ? 'Revoking…' : 'Yes, revoke it'}
            </button>
            <button type="button" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

export function Connections() {
  const { workspace, brand } = useScope();
  const accounts = useConnections(brand?.id ?? null);
  const credentials = useCredentials(workspace?.id ?? null);
  const revoke = useRevokeCredential(workspace?.id ?? null, brand?.id ?? null);

  if (!workspace || !brand) {
    return (
      <section className="conn-page">
        <h1>Connections</h1>
        <p className="conn-empty">Pick a workspace and a brand to see its connected accounts.</p>
      </section>
    );
  }

  const list = accounts.data ?? [];
  const broken = list.filter((account) => account.needsAttention);

  return (
    <section className="conn-page">
      <header className="conn-page-head">
        <h1>Connections</h1>
        <p>
          Where {brand.name} can publish, and whether it still can. Checked automatically every
          hour.
        </p>
      </header>

      {broken.length > 0 ? (
        <div className="conn-banner" role="status">
          {broken.length} account{broken.length === 1 ? '' : 's'} need attention — posts scheduled
          to {broken.length === 1 ? 'it' : 'them'} will not go out.
        </div>
      ) : null}

      {accounts.isLoading ? <p className="conn-empty">Loading…</p> : null}
      {accounts.isError ? (
        <p className="conn-empty conn-error">Could not load connected accounts.</p>
      ) : null}

      {accounts.isSuccess && list.length === 0 ? (
        <p className="conn-empty">
          Nothing connected yet. Add a platform app below, then connect an account to it.
        </p>
      ) : null}

      <div className="conn-grid">
        {list.map((connection) => (
          <AccountCard key={connection.id} connection={connection} />
        ))}
      </div>

      <section className="conn-creds">
        <h2>Platform apps</h2>
        <p className="conn-creds-blurb">
          Your own app registrations. One app can power several accounts, so revoking one affects
          everything connected through it.
        </p>
        {revoke.isError ? <p className="conn-error">Could not revoke that credential.</p> : null}
        {revoke.isSuccess ? (
          <p className="conn-ok">
            Revoked. {revoke.data.accountsRevoked} account
            {revoke.data.accountsRevoked === 1 ? '' : 's'} marked and {revoke.data.targetsBlocked}{' '}
            queued post{revoke.data.targetsBlocked === 1 ? '' : 's'} blocked.
          </p>
        ) : null}
        <ul className="conn-cred-list">
          {(credentials.data ?? []).map((credential) => (
            <CredentialRow
              key={credential.id}
              credential={credential}
              accounts={list}
              revoking={revoke.isPending}
              onRevoke={(credentialId) => revoke.mutate({ credentialId })}
            />
          ))}
        </ul>
        {credentials.isSuccess && (credentials.data ?? []).length === 0 ? (
          <p className="conn-empty">
            No platform apps yet — this brand is publishing through the shared Buzzalicious app.
          </p>
        ) : null}
      </section>
    </section>
  );
}
