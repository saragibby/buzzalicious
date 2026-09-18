import type { AccountStatus, Platform } from '@prisma/client';
import type { Db } from '../../platform/db';
import { withTenantScope, type ScopedDb, type TenantScope } from '../../platform/tenancy';
import { getLogger } from '../../platform/logger';
import { getAdapter, type AdapterRegistry } from './adapter.registry';
import type { AccountHealth, StoredAccount } from './adapter.types';
import { resolveCredential } from './credential.resolver';
import { isPlatformError } from './publish.errors';

/**
 * The periodic account health sweep.
 *
 * The publish pipeline already knows what to do with a `REVOKED` account — it blocks the
 * dependent targets instead of retrying them into the ground. What did not exist is the
 * thing that *notices*. Without it, an account whose token was revoked in January is
 * discovered in March, by a post that did not go out, and the client's first sign of a
 * problem is a gap in their feed.
 *
 * ## Why this file is the most dangerous one in the workstream
 *
 * A sweep is inherently cross-tenant: it has to look at every workspace's accounts, which
 * is precisely the shape of query the tenancy layer exists to prevent. So the selection
 * step is given a **deliberately narrow** system client — `SystemAccountReader`, below,
 * which can do exactly one thing — rather than the ambient `Db`. And the moment the sweep
 * has candidates it stops being cross-tenant: every write goes back through
 * `withTenantScope` for that account's own workspace.
 *
 * The narrow type is the point. A sweep handed a raw `Db` could later grow an unscoped
 * `updateMany` in a follow-up change and nothing would object.
 */

/** How long before expiry to refresh. Meta tokens can only be renewed while still alive. */
const REFRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** How stale a validation may be before the sweep re-checks a non-expiring token. */
const REVALIDATE_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * The only cross-tenant capability the sweep gets.
 *
 * Not `Db`, and not `ScopedDb` either: this is a third thing, and naming it makes the
 * exception auditable. Anything wanting to *write* has to go and get a scope.
 */
export interface SystemAccountReader {
  findAccountsDueForHealthCheck(now: Date, limit: number): Promise<DueAccount[]>;
}

export interface DueAccount {
  readonly id: string;
  readonly brandId: string;
  readonly workspaceId: string;
  readonly platform: Platform;
  readonly externalId: string;
  readonly credentialId: string | null;
  readonly status: AccountStatus;
  readonly expiresAt: Date | null;
  readonly lastValidatedAt: Date | null;
}

/**
 * Build the system reader over the real database.
 *
 * The `where` is the entire cross-tenant surface of the sweep, and it is visible in one
 * place on purpose.
 */
export function createSystemAccountReader(db: Db): SystemAccountReader {
  return {
    async findAccountsDueForHealthCheck(now, limit) {
      const rows = await db.socialAccount.findMany({
        where: {
          // REVOKED accounts are excluded: they have already been dealt with and
          // re-checking them every hour would be a self-inflicted rate limit on behalf of
          // a client who has not reconnected yet.
          status: { in: ['ACTIVE', 'EXPIRED', 'ERROR'] },
          OR: [
            { expiresAt: { not: null, lte: new Date(now.getTime() + REFRESH_WINDOW_MS) } },
            { lastValidatedAt: null },
            { lastValidatedAt: { lte: new Date(now.getTime() - REVALIDATE_AFTER_MS) } },
          ],
        },
        select: {
          id: true,
          brandId: true,
          platform: true,
          externalId: true,
          credentialId: true,
          status: true,
          expiresAt: true,
          lastValidatedAt: true,
          brand: { select: { workspaceId: true } },
        },
        // Oldest first, so a large backlog drains fairly rather than starving whichever
        // workspace happens to sort last.
        orderBy: { lastValidatedAt: { sort: 'asc', nulls: 'first' } },
        take: limit,
      });

      return rows.map((row) => ({
        id: row.id,
        brandId: row.brandId,
        workspaceId: row.brand.workspaceId,
        platform: row.platform,
        externalId: row.externalId,
        credentialId: row.credentialId,
        status: row.status,
        expiresAt: row.expiresAt,
        lastValidatedAt: row.lastValidatedAt,
      }));
    },
  };
}

export interface HealthSweepDeps {
  readonly db: Db;
  readonly reader: SystemAccountReader;
  readonly registry?: AdapterRegistry;
  readonly now?: () => Date;
  readonly limit?: number;
}

export interface HealthSweepResult {
  readonly checked: number;
  readonly refreshed: number;
  readonly revoked: number;
  readonly failed: number;
}

/**
 * Run one sweep pass.
 *
 * Never throws for a single bad account. One workspace with a broken credential must not
 * stop every other workspace's accounts being checked — that failure mode turns one
 * client's problem into everyone's.
 */
export async function runHealthSweep(deps: HealthSweepDeps): Promise<HealthSweepResult> {
  const now = deps.now?.() ?? new Date();
  const due = await deps.reader.findAccountsDueForHealthCheck(now, deps.limit ?? 100);

  let refreshed = 0;
  let revoked = 0;
  let failed = 0;

  for (const account of due) {
    try {
      const outcome = await checkOneAccount(deps, account, now);
      if (outcome === 'refreshed') refreshed += 1;
      if (outcome === 'revoked') revoked += 1;
    } catch (error) {
      failed += 1;
      getLogger().warn(
        {
          accountId: account.id,
          platform: account.platform,
          // Never the error object: a platform error's `message` can carry an upstream
          // body, and an upstream body can carry a token fragment.
          reason: isPlatformError(error) ? error.errorClass : 'UNKNOWN',
        },
        'Health check failed for account',
      );
    }
  }

  return { checked: due.length, refreshed, revoked, failed };
}

type Outcome = 'refreshed' | 'revoked' | 'ok';

async function checkOneAccount(
  deps: HealthSweepDeps,
  account: DueAccount,
  now: Date,
): Promise<Outcome> {
  // The sweep stops being cross-tenant here. Everything past this line is scoped to the
  // brand that owns the account, so a bug in the selection query cannot become a write to
  // someone else's row.
  const scope: TenantScope = {
    kind: 'brand',
    workspaceId: account.workspaceId,
    brandId: account.brandId,
  };
  const scoped = withTenantScope(deps.db, scope);

  const stored = await loadStoredAccount(scoped, account.id);
  if (!stored) return 'ok';

  const credential = await resolveCredential(scoped, {
    workspaceId: account.workspaceId,
    brandId: account.brandId,
    platform: account.platform,
    actor: 'job:publish.health-sweep',
    // Only that app can refresh the token it minted, so a stored `credentialId` is
    // followed exactly rather than re-searched — a search could land on a different
    // credential for the same platform and produce a refresh that cannot possibly work.
    ...(account.credentialId ? { credentialId: account.credentialId } : {}),
    context: { accountId: account.id },
  });

  const adapter = getAdapter(account.platform, deps.registry);

  // Refresh first, and only when expiry is actually near. A token refreshed on every pass
  // is a token rotated hundreds of times a day for no reason, and some platforms count
  // that against a quota.
  if (shouldRefresh(account, now)) {
    const tokens = await adapter.refresh(credential, stored);
    await scoped.socialAccount.update({
      where: { id: account.id },
      data: {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken ?? null,
        expiresAt: tokens.expiresAt ?? null,
        status: 'ACTIVE',
        lastError: null,
        lastValidatedAt: now,
      },
    });
    return 'refreshed';
  }

  const health = await adapter.validate(credential, stored);
  await applyHealth(scoped, account.id, health);

  return health.status === 'REVOKED' ? 'revoked' : 'ok';
}

function shouldRefresh(account: DueAccount, now: Date): boolean {
  if (!account.expiresAt) return false;
  return account.expiresAt.getTime() - now.getTime() <= REFRESH_WINDOW_MS;
}

async function loadStoredAccount(db: ScopedDb, id: string): Promise<StoredAccount | null> {
  const row = await db.socialAccount.findUnique({
    where: { id },
    select: {
      externalId: true,
      accessToken: true,
      refreshToken: true,
      tokenSecret: true,
      expiresAt: true,
      scopes: true,
      platformMeta: true,
    },
  });
  if (!row) return null;

  return {
    externalId: row.externalId,
    tokens: {
      accessToken: row.accessToken,
      refreshToken: row.refreshToken ?? undefined,
      tokenSecret: row.tokenSecret ?? undefined,
      expiresAt: row.expiresAt,
      scopes: row.scopes,
    },
    platformMeta: (row.platformMeta as StoredAccount['platformMeta']) ?? undefined,
  };
}

/** Map a health verdict onto the account row. */
export async function applyHealth(
  db: ScopedDb,
  accountId: string,
  health: AccountHealth,
): Promise<void> {
  await db.socialAccount.update({
    where: { id: accountId },
    data: {
      status: health.status,
      // Cleared on success rather than left behind: a stale error next to an ACTIVE status
      // is read by a human as "still broken".
      lastError: health.status === 'ACTIVE' ? null : (health.message ?? null),
      lastValidatedAt: health.checkedAt,
    },
  });
}
