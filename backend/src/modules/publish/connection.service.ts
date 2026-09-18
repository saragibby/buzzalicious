import type { Platform } from '@prisma/client';
import type { ScopedDb } from '../../platform/tenancy';

/**
 * Reading connected accounts for the Settings → Connections page.
 *
 * ## What this must never return
 *
 * `SocialAccount` holds `accessToken`, `refreshToken` and `tokenSecret`, all encrypted at
 * rest and all decrypted transparently by the Prisma extension the moment a row is read.
 * That means a `findMany` with no `select` hands back live plaintext credentials, and
 * `res.json(accounts)` would put them on the wire.
 *
 * So every query here is an explicit `select`, and the token columns are absent from it.
 * Not omitted afterwards, not deleted from the object — never fetched. docs/10 requires
 * that a credential value is never returned by an API, and the only reliable way to keep
 * that true through future edits is for the value to have no path into the response.
 */

export interface ConnectionView {
  readonly id: string;
  readonly platform: Platform;
  readonly externalId: string;
  readonly handle: string | null;
  readonly displayName: string | null;
  readonly avatarUrl: string | null;
  readonly status: string;
  readonly lastError: string | null;
  readonly lastValidatedAt: string | null;
  readonly expiresAt: string | null;
  readonly scopes: readonly string[];
  /** Which credential minted this. Null means the shared Buzzalicious platform app. */
  readonly credentialId: string | null;
  readonly credentialLabel: string | null;
  /** True when the account needs the client to do something. Drives the UI's call to action. */
  readonly needsAttention: boolean;
}

export async function listConnections(db: ScopedDb): Promise<ConnectionView[]> {
  const accounts = await db.socialAccount.findMany({
    // Explicit, and the token columns are deliberately not in it.
    select: {
      id: true,
      platform: true,
      externalId: true,
      handle: true,
      displayName: true,
      avatarUrl: true,
      status: true,
      lastError: true,
      lastValidatedAt: true,
      expiresAt: true,
      scopes: true,
      credentialId: true,
      credential: { select: { label: true } },
    },
    orderBy: [{ platform: 'asc' }, { handle: 'asc' }],
  });

  return accounts.map((account) => ({
    id: account.id,
    platform: account.platform,
    externalId: account.externalId,
    handle: account.handle,
    displayName: account.displayName,
    avatarUrl: account.avatarUrl,
    status: account.status,
    lastError: account.lastError,
    // Serialized here rather than left as a Date. The HTTP body is what the frontend
    // parses, and a Date crossing `JSON.stringify` silently becomes a string anyway — so
    // it is done explicitly and the type says so.
    lastValidatedAt: account.lastValidatedAt?.toISOString() ?? null,
    expiresAt: account.expiresAt?.toISOString() ?? null,
    scopes: account.scopes,
    credentialId: account.credentialId,
    credentialLabel: account.credential?.label ?? null,
    needsAttention: account.status !== 'ACTIVE',
  }));
}

export async function getConnection(db: ScopedDb, id: string): Promise<ConnectionView | null> {
  const all = await listConnections(db);
  return all.find((account) => account.id === id) ?? null;
}
