import { CredentialStatus, type Platform, type PlatformCredential } from '@prisma/client';
import { getConfig } from '../../platform/config';
import type { Db } from '../../platform/db';
import { ValidationError } from '../../platform/errors';
import { getLogger } from '../../platform/logger';
import type { ResolvedCredential } from './adapter.types';

/**
 * Buzzalicious's own app credentials, carrying no tenant.
 *
 * Deliberately **not** a `ResolvedCredential`: that type requires a `workspaceId`, and a
 * collector has no workspace to name. Keeping them distinct means a collector credential
 * cannot be passed to a publishing path, nor a client's to a collector, without the
 * compiler objecting. Defined here rather than in `adapter.types.ts` because nothing that
 * publishes should have a reason to import it.
 */
export interface CollectorCredential {
  readonly mode: 'PLATFORM_APP';
  readonly platform: Platform;
  readonly appId: string;
  /** Decrypted. Hold for the duration of the call and no longer. Never log it. */
  readonly appSecret: string;
}
/**
 * The `CredentialResolver` — **the only path to credentials** (docs/10).
 *
 * No adapter, job or route reads an app secret any other way. That is not a style
 * preference: a single choke point is what makes access logging, rotation and offboarding
 * tractable, and every additional construction site silently removes a row from the audit
 * trail without removing anything from the logs that would show it.
 *
 * Resolution order is brand → workspace → `PLATFORM_APP`, and within a tier `CLIENT_APP`
 * beats `DIRECT_TOKEN`, because a `DIRECT_TOKEN` is a bootstrap that expires and a
 * `CLIENT_APP` is the durable answer. A client who has upgraded should start using the
 * upgrade without having to delete the old row first.
 */

/** Who is asking, for the access log. `job:publish.target`, `user:<id>`, `cron:validate`. */
export type CredentialActor = string;

export class CredentialUnavailableError extends ValidationError {
  constructor(platform: Platform, reason: string) {
    super(`No usable ${platform} credentials: ${reason}`);
    this.name = 'CredentialUnavailableError';
  }
}

export interface ResolveOptions {
  workspaceId: string;
  /** Null for workspace-level work such as a validation sweep. */
  brandId?: string | null;
  platform: Platform;
  actor: CredentialActor;
  /** Extra access-log context. Identifiers only — never a value. */
  context?: Record<string, string | number | null>;
  /**
   * Resolve this exact credential rather than searching. Used by the OAuth callback,
   * which learns the id from the signed state, and by any job carrying a `credentialId`.
   */
  credentialId?: string;
}

/** Statuses a credential may be used under. */
const USABLE: readonly CredentialStatus[] = [
  CredentialStatus.ACTIVE,
  // Usable deliberately: `INSUFFICIENT` means "authenticates, missing some scope we want".
  // Refusing to resolve it would block the capabilities it *does* have, which is the
  // opposite of what the pre-flight report promises the client.
  CredentialStatus.INSUFFICIENT,
  // A credential entered but not yet validated has to be resolvable, or pre-flight —
  // whose entire job is to validate it — could never run.
  CredentialStatus.PENDING,
];

/** Which platform app covers which network. Meta's three share one. */
function platformAppKey(platform: Platform): 'X' | 'META' | 'THREADS' | null {
  switch (platform) {
    case 'X':
      return 'X';
    case 'INSTAGRAM':
    case 'FACEBOOK':
      return 'META';
    case 'THREADS':
      return 'THREADS';
    default:
      return null;
  }
}

/**
 * Rank candidates. Lower sorts first.
 *
 * Brand-specific before workspace-shared, and `CLIENT_APP` before `DIRECT_TOKEN` within
 * each. Ties break on `createdAt` at the query level so the order is total and a resolve
 * is reproducible — an ambiguous resolution that picks differently between two calls is
 * the kind of bug that only shows up as "it worked yesterday".
 */
function rank(credential: PlatformCredential, brandId: string | null): number {
  const scopeRank = brandId !== null && credential.brandId === brandId ? 0 : 2;
  const modeRank = credential.mode === 'CLIENT_APP' ? 0 : 1;
  return scopeRank + modeRank;
}

/**
 * Record that a credential was read.
 *
 * Best-effort on purpose. The publish path must not fail because an audit insert failed —
 * a lost log line is a gap in the record, and refusing to publish over it would turn an
 * observability problem into an outage. It is logged loudly instead.
 */
async function recordAccess(
  db: Db,
  credentialId: string,
  actor: CredentialActor,
  action: 'decrypt' | 'rotate' | 'validate' | 'revoke',
  context?: Record<string, string | number | null>,
): Promise<void> {
  try {
    await db.credentialAccessLog.create({
      data: { credentialId, actor, action, context: context ?? undefined },
    });
  } catch (error) {
    getLogger().error(
      { err: error, credentialId, actor, action },
      'Failed to write a credential access log row',
    );
  }
}

export { recordAccess as recordCredentialAccess };

/**
 * Resolve and decrypt credentials for one (brand, platform).
 *
 * Takes the **unscoped** client because it is also called from jobs and from the
 * unauthenticated OAuth callback, neither of which has a request scope. The tenant is not
 * lost by doing so: `workspaceId` is always bound explicitly in the query below, and the
 * returned credential carries the workspace it came from so a caller cannot mix them up.
 */
export async function resolveCredential(
  db: Db,
  options: ResolveOptions,
): Promise<ResolvedCredential> {
  const { workspaceId, platform, actor } = options;
  const brandId = options.brandId ?? null;

  if (options.credentialId) {
    const exact = await db.platformCredential.findFirst({
      where: { id: options.credentialId, workspaceId, platform },
    });
    if (!exact) {
      throw new CredentialUnavailableError(platform, 'the requested credential does not exist');
    }
    if (!USABLE.includes(exact.status)) {
      throw new CredentialUnavailableError(
        platform,
        `credential "${exact.label}" is ${exact.status}`,
      );
    }
    await recordAccess(db, exact.id, actor, 'decrypt', options.context);
    return toResolved(exact);
  }

  const candidates = await db.platformCredential.findMany({
    where: {
      workspaceId,
      platform,
      status: { in: [...USABLE] },
      // A brand-scoped read must see the workspace-shared credential too; that is the
      // ordinary case for a client with one Meta app and several brands.
      //
      // Workspace-level work (a sweep, an admin action) is restricted to shared
      // credentials rather than left unfiltered. Unfiltered looks harmless because
      // `rank()` scores every row the same when there is no brand — but "the same" means
      // the tie breaks on `createdAt`, so workspace-level work would quietly adopt
      // whichever brand happened to connect first. Borrowing one brand's app to act for
      // the workspace is exactly the kind of cross-brand bleed the tenancy layer exists
      // to prevent, and it would not show up as an error anywhere.
      ...(brandId === null ? { brandId: null } : { OR: [{ brandId }, { brandId: null }] }),
    },
    orderBy: { createdAt: 'asc' },
  });

  const best = candidates
    .map((credential) => ({ credential, rank: rank(credential, brandId) }))
    .sort((a, b) => a.rank - b.rank)[0]?.credential;

  if (best) {
    await recordAccess(db, best.id, actor, 'decrypt', options.context);
    return toResolved(best);
  }

  return resolvePlatformApp(platform, workspaceId, brandId, candidatesHint(candidates));
}

/** Say *why* nothing matched, since "connect credentials" is useless if one exists. */
function candidatesHint(candidates: PlatformCredential[]): string {
  return candidates.length === 0
    ? 'no credential is configured for this platform'
    : 'every configured credential is revoked or invalid';
}

function resolvePlatformApp(
  platform: Platform,
  workspaceId: string,
  brandId: string | null,
  reason: string,
): ResolvedCredential {
  const key = platformAppKey(platform);
  const app = key ? getConfig().publish.platformApps[key] : undefined;

  if (!app) {
    throw new CredentialUnavailableError(
      platform,
      `${reason}, and Buzzalicious has no ${platform} app of its own to fall back to. Connect your own ${platform} app credentials in Settings → Connections.`,
    );
  }

  return {
    id: null,
    mode: 'PLATFORM_APP',
    platform,
    workspaceId,
    brandId,
    appId: app.appId,
    appSecret: app.appSecret,
    redirectUri: getConfig().publish.callbackUrl(platform),
    grantedScopes: [],
  };
}

/**
 * Buzzalicious's own app credentials, for cross-tenant work that belongs to no client.
 *
 * ## Why this is a separate function and not a flag
 *
 * docs/07 and ADR-0009 both say a trend collector must resolve in `PLATFORM_APP` mode and
 * **never** fall back to a client credential. Until now that rule lived only in prose, and
 * `resolveCredential` — the obvious function to reach for — runs the full
 * brand → workspace → platform chain. The first automated collector to call it would have
 * silently published research traffic on a client's app: no error, no failing test, and
 * the damage invisible until that client's own publishing started hitting a quota it had
 * not spent. Instagram hashtag search is capped per *token*, so the collector and the
 * client draw down the same budget.
 *
 * **This function takes no `Db`.** That is the entire design. A rule enforced by an
 * argument that isn't there cannot be forgotten, misread, or regressed by someone adding a
 * fallback in good faith — where a boolean option would be one `true` away from the bug it
 * was meant to prevent.
 *
 * Two reasons the separation matters, both from docs/07:
 *
 * 1. **Quota.** Collecting on a client's app degrades the publishing they pay for.
 * 2. **Tenancy.** Trend data is cross-tenant by nature. Observations gathered through Rise
 *    & Shore's app would be scored and shown to Tax Dedux — a credential crossing the
 *    boundary that the rest of this codebase exists to hold.
 */
export function resolveCollectorCredential(platform: Platform): CollectorCredential {
  const key = platformAppKey(platform);
  const app = key ? getConfig().publish.platformApps[key] : undefined;

  if (!app) {
    throw new CredentialUnavailableError(
      platform,
      `Buzzalicious has no ${platform} app configured, so trend collection for ${platform} cannot run. Set PLATFORM_APP_* config vars. A collector deliberately cannot borrow a client's credentials (docs/07, ADR-0009).`,
    );
  }

  return { mode: 'PLATFORM_APP', platform, appId: app.appId, appSecret: app.appSecret };
}

function toResolved(credential: PlatformCredential): ResolvedCredential {
  // Values arrive already decrypted: the Prisma extension in platform/prisma-encryption.ts
  // did it on the way out. Nothing here calls the Encryptor directly, which is what keeps
  // "decrypt at the last possible moment" true without every caller remembering it.
  const appSecret = credential.appSecret ?? credential.directTokenSecret ?? '';

  if (credential.mode === 'CLIENT_APP' && (!credential.appId || !credential.appSecret)) {
    throw new CredentialUnavailableError(
      credential.platform,
      `credential "${credential.label}" is CLIENT_APP mode but is missing its app id or secret`,
    );
  }

  return {
    id: credential.id,
    mode: credential.mode,
    platform: credential.platform,
    workspaceId: credential.workspaceId,
    brandId: credential.brandId,
    appId: credential.appId ?? '',
    appSecret,
    redirectUri: credential.redirectUri ?? getConfig().publish.callbackUrl(credential.platform),
    grantedScopes: credential.grantedScopes,
    ...(credential.directToken ? { directToken: credential.directToken } : {}),
    ...(credential.directTokenSecret ? { directTokenSecret: credential.directTokenSecret } : {}),
    ...(credential.systemUserToken ? { systemUserToken: credential.systemUserToken } : {}),
  };
}
