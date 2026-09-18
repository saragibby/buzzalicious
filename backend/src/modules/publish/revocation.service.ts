import type { CredentialStatus } from '@prisma/client';
import type { ScopedDb } from '../../platform/tenancy';
import { getLogger } from '../../platform/logger';
import { getCredential } from './credential.service';

/**
 * Revoking a credential, and everything that has to stop when it does.
 *
 * docs/10 is explicit that revocation must halt scheduled posts **visibly**. Three things
 * have to happen together or the revocation is a lie:
 *
 *  1. the credential is marked `REVOKED`, so nothing resolves it again;
 *  2. every account minted by it is marked `REVOKED`, so nothing publishes with a dead
 *     token;
 *  3. every still-pending target pointing at those accounts becomes `BLOCKED` — not
 *     `FAILED`, because telling a client their content was rejected when it is actually
 *     waiting for them to reconnect sends them to debug the wrong thing entirely.
 *
 * ## The failure this is written defensively against
 *
 * Steps 2 and 3 are `updateMany` calls whose result count nobody consumes. If the scoped
 * `where` were wrong, there would be no throw, no error and no zero to notice — the call
 * would report success having changed nothing, and the accounts would keep publishing
 * with a revoked credential. That is why the tests here assert the **status read back
 * from each row**, with a row that must not change present as a control, rather than
 * asserting on a count.
 */

export interface RevocationSummary {
  readonly credentialId: string;
  readonly accountsRevoked: number;
  readonly targetsBlocked: number;
}

/** Targets that have not gone out yet, and so can still be stopped. */
const HALTABLE_TARGET_STATUSES = ['DRAFT', 'SCHEDULED', 'PUBLISHING'] as const;

export async function revokeCredential(
  db: ScopedDb,
  credentialId: string,
  options: { reason?: string } = {},
): Promise<RevocationSummary> {
  // Throws if the credential is not in scope. Doing this first means a caller from
  // another tenant never reaches the writes below.
  await getCredential(db, credentialId);

  const reason = options.reason ?? 'The connected app credential was revoked.';

  const accounts = await db.socialAccount.findMany({
    where: { credentialId },
    select: { id: true },
  });
  const accountIds = accounts.map((account) => account.id);

  await db.platformCredential.update({
    where: { id: credentialId },
    data: {
      status: 'REVOKED' as CredentialStatus,
      lastError: reason,
    },
  });

  if (accountIds.length === 0) {
    // Not an error and not unusual. A credential can be revoked before it has ever been
    // used to connect anything, and `PLATFORM_APP`-minted accounts carry a null
    // `credentialId` and are genuinely unaffected by this revocation.
    return { credentialId, accountsRevoked: 0, targetsBlocked: 0 };
  }

  await db.socialAccount.updateMany({
    where: { id: { in: accountIds } },
    data: { status: 'REVOKED', lastError: reason },
  });

  const blocked = await db.postTarget.updateMany({
    where: {
      socialAccountId: { in: accountIds },
      status: { in: [...HALTABLE_TARGET_STATUSES] },
    },
    data: {
      status: 'BLOCKED',
      // Written so the composer can say why without another query, and phrased as the
      // client's next action rather than as a failure.
      lastError: reason,
    },
  });

  getLogger().info(
    { credentialId, accountsRevoked: accountIds.length, targetsBlocked: blocked.count },
    'Credential revoked; dependent accounts and scheduled targets halted',
  );

  return {
    credentialId,
    accountsRevoked: accountIds.length,
    targetsBlocked: blocked.count,
  };
}
