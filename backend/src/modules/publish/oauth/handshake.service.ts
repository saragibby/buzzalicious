import type { OAuthHandshake, Platform } from '@prisma/client';
import { getConfig } from '../../../platform/config';
import type { Db } from '../../../platform/db';
import { InvalidOAuthStateError } from './state';

/**
 * Durable state for an in-flight OAuth authorization.
 *
 * Replaces the prototype's in-process `Map`, which was wrong in four separate ways
 * (docs/reference/x-oauth1a.md): it missed whenever Heroku routed the callback to a
 * different dyno, lost everything on restart, grew without bound because entries were
 * only deleted on success, and had no expiry or CSRF binding at all.
 *
 * A row is created before the user is redirected and consumed exactly once on the way
 * back. "Exactly once" is enforced by a conditional update rather than a read-then-write:
 * a duplicated callback — a double-click, a browser prefetch, a replayed link — must not
 * be able to run the code exchange twice.
 */

export interface StartHandshakeInput {
  credentialId: string;
  platform: Platform;
  brandId: string;
  nonce: string;
  initiatedByUserId?: string | null;
}

export function handshakeExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + getConfig().publish.handshakeTtlSeconds * 1000);
}

export async function startHandshake(
  db: Db,
  input: StartHandshakeInput,
  now: Date = new Date(),
): Promise<OAuthHandshake> {
  return db.oAuthHandshake.create({
    data: {
      credentialId: input.credentialId,
      platform: input.platform,
      brandId: input.brandId,
      nonce: input.nonce,
      initiatedByUserId: input.initiatedByUserId ?? null,
      expiresAt: handshakeExpiry(now),
    },
  });
}

/**
 * Attach OAuth 1.0a leg-1 material to a handshake.
 *
 * Separate from `startHandshake` because the request token only exists after the adapter
 * has talked to X, and the row has to exist first so that a crash between the two leaves
 * an expiring row rather than an unattributable secret.
 */
export async function attachRequestToken(
  db: Db,
  handshakeId: string,
  token: { token: string; secret: string },
): Promise<void> {
  await db.oAuthHandshake.update({
    where: { id: handshakeId },
    // `requestTokenSecret` is encrypted on the way in by the Prisma extension.
    data: { requestToken: token.token, requestTokenSecret: token.secret },
  });
}

/**
 * Consume a handshake by nonce, atomically.
 *
 * `updateMany` with the full precondition in the `where` is the point: the database
 * decides whether this caller is the one that got there first. A `findFirst` followed by
 * an `update` has a window in which two concurrent callbacks both see an unconsumed row,
 * and the cost of losing that race is two authorizations exchanged against one code.
 */
export async function consumeHandshake(
  db: Db,
  nonce: string,
  now: Date = new Date(),
): Promise<OAuthHandshake> {
  const claimed = await db.oAuthHandshake.updateMany({
    where: { nonce, consumedAt: null, expiresAt: { gt: now } },
    data: { consumedAt: now },
  });

  if (claimed.count !== 1) throw new InvalidOAuthStateError();

  const handshake = await db.oAuthHandshake.findFirst({ where: { nonce } });
  if (!handshake) throw new InvalidOAuthStateError();
  return handshake;
}

/**
 * Delete expired and consumed handshakes.
 *
 * Runs on the maintenance cron. Consumed rows are kept for a grace period rather than
 * deleted immediately so that a duplicate callback arriving seconds later still fails
 * with "already used" instead of "never existed" — the same outcome, but the logs are
 * readable when someone is trying to work out why a connect flow misbehaved.
 */
export async function pruneHandshakes(
  db: Db,
  now: Date = new Date(),
  graceMs = 60 * 60 * 1000,
): Promise<number> {
  const cutoff = new Date(now.getTime() - graceMs);
  const { count } = await db.oAuthHandshake.deleteMany({
    where: {
      OR: [{ expiresAt: { lt: cutoff } }, { consumedAt: { lt: cutoff } }],
    },
  });
  return count;
}
