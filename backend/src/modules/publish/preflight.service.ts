import type { Platform } from '@prisma/client';
import type { Db } from '../../platform/db';
import { getLogger } from '../../platform/logger';
import type { AdapterRegistry } from './adapter.registry';
import { getAdapter } from './adapter.registry';
import type { CapabilityReport } from './adapter.types';
import { CAPABILITIES, type Capability, type CredentialCapabilities } from './credential.schemas';
import { recordCredentialAccess, resolveCredential } from './credential.resolver';

/**
 * Capability pre-flight.
 *
 * The problem this solves, from docs/10: under BYO, a client's app is approved by the
 * platform for whatever permissions *they* asked for, which is not necessarily what we
 * need. Without a pre-flight the first evidence of a mismatch is a scheduled post failing
 * weeks later, at which point the client has lost a slot and has no idea why.
 *
 * So the check runs at connect time and on a schedule, and its output is a plain-language
 * report naming the permission to request — not a boolean, and not an upstream error
 * string. "Missing `pages_manage_posts`" is actionable; "Error 200" is not.
 */

export interface PreflightOptions {
  workspaceId: string;
  brandId?: string | null;
  platform: Platform;
  credentialId: string;
  actor: string;
  registry?: AdapterRegistry;
}

/**
 * Run pre-flight and persist the verdict.
 *
 * Writes `capabilities`, `grantedScopes`, `status` and `lastValidatedAt` on the
 * credential. Persisting matters as much as checking: the composer needs to grey out a
 * destination *before* the user writes a post for it, and it cannot call a platform
 * synchronously to find out.
 */
export async function runPreflight(db: Db, options: PreflightOptions): Promise<CapabilityReport> {
  const credential = await resolveCredential(db, {
    workspaceId: options.workspaceId,
    brandId: options.brandId ?? null,
    platform: options.platform,
    actor: options.actor,
    credentialId: options.credentialId,
    context: { reason: 'preflight' },
  });

  const adapter = getAdapter(options.platform, options.registry);

  let report: CapabilityReport;
  try {
    report = await adapter.introspect(credential);
  } catch (error) {
    // An adapter that throws rather than returning an INVALID report is still a real
    // answer about the credential, and it must not leave the row stuck in PENDING
    // forever. The upstream detail goes to the log, never to the stored summary.
    getLogger().warn(
      { err: error, credentialId: options.credentialId, platform: options.platform },
      'Pre-flight introspection threw',
    );
    report = {
      status: 'INVALID',
      grantedScopes: [],
      capabilities: {},
      summary:
        'These credentials could not be verified with the platform. Check the app ID and secret, then try again.',
      checkedAt: new Date(),
    };
  }

  await db.platformCredential.update({
    where: { id: options.credentialId },
    data: {
      status: report.status,
      grantedScopes: [...report.grantedScopes],
      capabilities: report.capabilities as object,
      lastValidatedAt: report.checkedAt,
      lastError: report.status === 'ACTIVE' ? null : report.summary,
    },
  });

  await recordCredentialAccess(db, options.credentialId, options.actor, 'validate', {
    status: report.status,
  });

  return report;
}

/**
 * Compare granted scopes against what each capability needs.
 *
 * Pure, and separated from `runPreflight` so it can be tested exhaustively without a
 * database or a platform. Adapters whose protocol has no scopes (X, OAuth 1.0a) pass an
 * empty requirement map and get "supported" for everything — the honest answer, since
 * scope comparison genuinely cannot tell you anything there.
 */
export function evaluateCapabilities(
  granted: readonly string[],
  required: Readonly<Record<Capability, readonly string[]>>,
  checkedAt: Date = new Date(),
): CredentialCapabilities {
  const grantedSet = new Set(granted);
  const capabilities: CredentialCapabilities = {};

  for (const capability of CAPABILITIES) {
    const needed = required[capability] ?? [];
    const missingScopes = needed.filter((scope) => !grantedSet.has(scope));

    capabilities[capability] =
      missingScopes.length === 0
        ? { supported: true, missingScopes: [], checkedAt: checkedAt.toISOString() }
        : {
            supported: false,
            // Named, not counted. The whole value of the report is telling the client
            // which permission to go and request.
            reason: `Your app has not been granted ${missingScopes.join(', ')}.`,
            missingScopes,
            checkedAt: checkedAt.toISOString(),
          };
  }

  return capabilities;
}

/**
 * The credential-level verdict implied by a capability map.
 *
 * `INSUFFICIENT` rather than `INVALID` whenever *anything* works: the credential
 * authenticates, and refusing to use it at all would block the destinations it can
 * legitimately reach.
 */
export function summariseStatus(capabilities: CredentialCapabilities): 'ACTIVE' | 'INSUFFICIENT' {
  const entries = Object.values(capabilities);
  return entries.every((entry) => entry.supported) ? 'ACTIVE' : 'INSUFFICIENT';
}

/** Plain-language summary for the client. Never contains an upstream body or a secret. */
export function describeCapabilities(
  platform: Platform,
  capabilities: CredentialCapabilities,
): string {
  const missing = Object.entries(capabilities)
    .filter(([, entry]) => !entry.supported)
    .flatMap(([, entry]) => entry.missingScopes);

  const unique = [...new Set(missing)];
  if (unique.length === 0) return `Your ${platform} app has every permission Buzzalicious needs.`;

  return `Your ${platform} app is connected, but is missing ${unique.join(', ')}. Request these permissions in your app's settings, then re-run the check.`;
}
