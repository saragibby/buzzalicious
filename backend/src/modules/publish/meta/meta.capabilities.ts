import type { Capability, CredentialCapabilities } from '../credential.schemas';
import type { CapabilityReport } from '../adapter.types';

/**
 * Turn "what Meta says this token was granted" into the per-capability report docs/10
 * requires.
 *
 * ## Why this is shared and mechanical
 *
 * The whole point of pre-flight is to convert an invisible failure into an actionable
 * task: a client whose app was never approved for `instagram_content_publish` should learn
 * that when they connect, naming the scope, not three weeks later from a post that did
 * not go out. That is only true if the missing scope is reported *specifically*, and the
 * reliable way to get that is to diff the granted list against the required list rather
 * than write prose per platform.
 *
 * Meta is unusually good here: `debug_token` returns the granted scopes, so unlike X this
 * does not have to guess.
 */

export const FB_PAGE_SCOPES = [
  'pages_show_list',
  'pages_manage_posts',
  'pages_read_engagement',
  'read_insights',
] as const;

export const IG_SCOPES = [
  'instagram_basic',
  'instagram_content_publish',
  'instagram_manage_insights',
  'pages_show_list',
  'pages_read_engagement',
] as const;

export const THREADS_SCOPES = [
  'threads_basic',
  'threads_content_publish',
  'threads_manage_insights',
] as const;

export interface CapabilityReportInput {
  /** Human-readable platform name, for the summary sentence. */
  readonly platform: string;
  readonly grantedScopes: readonly string[];
  readonly requiredScopes: Readonly<Record<Capability, readonly string[]>>;
  /** Capabilities the platform simply does not offer, with the reason shown to a client. */
  readonly unsupported?: Partial<Record<Capability, string>>;
  readonly checkedAt: Date;
}

export function buildCapabilityReport(input: CapabilityReportInput): CapabilityReport {
  const granted = new Set(input.grantedScopes);
  const checkedAt = input.checkedAt.toISOString();
  const capabilities: Record<string, unknown> = {};
  const blocking: string[] = [];

  for (const [capability, required] of Object.entries(input.requiredScopes) as Array<
    [Capability, readonly string[]]
  >) {
    const reason = input.unsupported?.[capability];
    if (reason) {
      capabilities[capability] = { supported: false, reason, missingScopes: [], checkedAt };
      continue;
    }

    const missingScopes = required.filter((scope) => !granted.has(scope));
    const supported = missingScopes.length === 0;

    capabilities[capability] = {
      supported,
      missingScopes,
      checkedAt,
      ...(supported
        ? {}
        : { reason: `The app is missing ${missingScopes.join(', ')} for this capability.` }),
    };

    // Only the publishing capabilities make a credential INSUFFICIENT. Missing insights
    // scopes cost metrics, which is a degraded product rather than a broken one, and
    // blocking a connection over them would stop a client publishing at all over a
    // permission Meta reviews separately and more slowly.
    if (!supported && capability.startsWith('publish_')) blocking.push(...missingScopes);
  }

  const uniqueBlocking = [...new Set(blocking)];

  return {
    status: uniqueBlocking.length === 0 ? 'ACTIVE' : 'INSUFFICIENT',
    grantedScopes: input.grantedScopes,
    capabilities: capabilities as CredentialCapabilities,
    summary:
      uniqueBlocking.length === 0
        ? `Connected to ${input.platform}. Publishing is available.`
        : `${input.platform} has not approved this app for ${uniqueBlocking.join(', ')}. Posts cannot be published until those permissions are granted.`,
    checkedAt: input.checkedAt,
  };
}
