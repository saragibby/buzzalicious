import { PublishErrorClass } from '@prisma/client';
import { AppError, type ErrorCode } from '../../platform/errors';

/**
 * The publish error taxonomy from docs/08, as code.
 *
 * The prototype stored a raw error string per platform, which meant the UI could only say
 * "publish failed". Every useful thing the product wants to do with a failure — retry it,
 * stop retrying it, tell the client to reconnect one account, tell them to fix one app
 * secret — needs to know *which kind* of failure it was.
 *
 * Two distinctions carry most of the value:
 *
 *  - **`CREDENTIAL` vs `AUTH`.** A bad app secret breaks every account minted by that
 *    credential and one client action fixes all of them. A revoked token breaks one
 *    account. Pointing the UI at the wrong one either understates or overstates the work.
 *  - **`QUOTA` vs `TRANSIENT`.** Both are temporary, but a rate limit clears in seconds
 *    and a daily publishing quota clears tomorrow. Backing off exponentially against a
 *    24-hour window burns every retry the job has.
 */

/** How the pipeline should react. Derived from the class, never set independently. */
export interface ErrorPolicy {
  /** Retry the same job. */
  readonly retryable: boolean;
  /** The failure is the credential's, so sibling accounts are affected too. */
  readonly credentialLevel: boolean;
  /** The failure is this account's token. */
  readonly accountLevel: boolean;
}

const POLICIES: Readonly<Record<PublishErrorClass, ErrorPolicy>> = {
  TRANSIENT: { retryable: true, credentialLevel: false, accountLevel: false },
  // Not retried blindly: a revoked token does not un-revoke, and hammering it is how an
  // app gets rate limited on top of being broken.
  AUTH: { retryable: false, credentialLevel: false, accountLevel: true },
  CREDENTIAL: { retryable: false, credentialLevel: true, accountLevel: false },
  VALIDATION: { retryable: false, credentialLevel: false, accountLevel: false },
  POLICY: { retryable: false, credentialLevel: false, accountLevel: false },
  // Retryable, but only after the window — the pipeline reschedules rather than backing
  // off, so `retryable` here means "will be attempted again", not "requeue immediately".
  QUOTA: { retryable: true, credentialLevel: false, accountLevel: false },
};

export function policyFor(errorClass: PublishErrorClass): ErrorPolicy {
  return POLICIES[errorClass];
}

/**
 * A classified platform failure.
 *
 * `expose` is false for the same reason `ExternalServiceError`'s is: upstream bodies echo
 * back request parameters, and for an OAuth call those parameters are credentials. The
 * client gets `clientMessage`, which is written by us.
 */
export class PlatformError extends AppError {
  readonly code: ErrorCode = 'EXTERNAL_SERVICE_ERROR';
  readonly status = 502;
  readonly expose = false;

  readonly errorClass: PublishErrorClass;
  readonly platform: string;
  /** Plain language, safe to show. Never an upstream message unless `POLICY`. */
  readonly clientMessage: string;
  readonly retryAfterSeconds?: number;

  constructor(options: {
    platform: string;
    errorClass: PublishErrorClass;
    message: string;
    clientMessage: string;
    retryAfterSeconds?: number;
    cause?: unknown;
  }) {
    super(options.message, { cause: options.cause });
    this.platform = options.platform;
    this.errorClass = options.errorClass;
    this.clientMessage = options.clientMessage;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }

  get policy(): ErrorPolicy {
    return policyFor(this.errorClass);
  }
}

export function isPlatformError(error: unknown): error is PlatformError {
  return error instanceof PlatformError;
}

/** What `classifyPlatformError` can work with. Shaped to what real SDKs actually throw. */
export interface PlatformFailure {
  readonly platform: string;
  /** HTTP status, when there was one. */
  readonly status?: number;
  /** Platform-specific numeric or string code. */
  readonly code?: string | number;
  /** The upstream message. Used for matching, never returned to a client verbatim. */
  readonly message?: string;
  readonly retryAfterSeconds?: number;
  readonly cause?: unknown;
}

/**
 * Patterns that identify a class regardless of status code.
 *
 * Matched against the upstream message because the platforms disagree about status
 * codes far more than they disagree about wording. X's read-only refusal is the canonical
 * example: it is a 403 whose message never mentions permissions, and it is a *credential*
 * problem — the client's app is configured read-only — not an account one. Treating it as
 * `AUTH` would tell the client to reconnect their account, which cannot possibly help.
 */
const MESSAGE_RULES: ReadonlyArray<{ pattern: RegExp; errorClass: PublishErrorClass }> = [
  { pattern: /read-?only application cannot post/i, errorClass: 'CREDENTIAL' },
  {
    pattern: /invalid (client|consumer|application)|client credentials are invalid/i,
    errorClass: 'CREDENTIAL',
  },
  {
    pattern: /invalid or expired token|token (has )?expired|session has expired/i,
    errorClass: 'AUTH',
  },
  { pattern: /revoked|user has not authorized|permission.*deauthorized/i, errorClass: 'AUTH' },
  { pattern: /rate ?limit|too many requests/i, errorClass: 'TRANSIENT' },
  { pattern: /daily.*limit|publishing limit|quota (exceeded|reached)/i, errorClass: 'QUOTA' },
  { pattern: /status is a duplicate|duplicate (tweet|post)/i, errorClass: 'VALIDATION' },
  {
    pattern: /violat|not allowed by (our )?polic|community (standards|guidelines)/i,
    errorClass: 'POLICY',
  },
];

const CLIENT_MESSAGES: Readonly<Record<PublishErrorClass, string>> = {
  TRANSIENT: 'The platform was temporarily unavailable. This will be retried automatically.',
  AUTH: 'This account needs to be reconnected — the platform no longer accepts its access token.',
  CREDENTIAL:
    'The platform app credentials for this workspace were rejected. Check the app ID, secret and permissions, then re-run the pre-flight check.',
  VALIDATION: 'The platform rejected this post as invalid. Editing the post should fix it.',
  POLICY: 'The platform rejected this post on content-policy grounds.',
  QUOTA: 'This account has hit its publishing limit for now. The post will be tried again later.',
};

/**
 * Turn whatever a platform threw into a classified error.
 *
 * Message rules run **before** status rules. A 403 is `AUTH` by default, but X's
 * read-only refusal is a 403 that means something else entirely, and defaulting first
 * would mean the specific rule never fires.
 */
export function classifyPlatformError(failure: PlatformFailure): PlatformError {
  const message = failure.message ?? 'Unknown platform error';
  let errorClass = matchByMessage(message) ?? matchByStatus(failure.status);

  // A 429 always means slow down, whatever the body says.
  if (failure.status === 429) errorClass = 'TRANSIENT';

  const clientMessage =
    errorClass === 'POLICY'
      ? // The one class where the upstream text is the useful part: only the platform
        // knows which rule the content broke, and paraphrasing it helps nobody.
        `The platform rejected this post: ${message}`
      : CLIENT_MESSAGES[errorClass];

  return new PlatformError({
    platform: failure.platform,
    errorClass,
    message: `${failure.platform}: ${message}`,
    clientMessage,
    retryAfterSeconds: failure.retryAfterSeconds,
    cause: failure.cause,
  });
}

function matchByMessage(message: string): PublishErrorClass | undefined {
  return MESSAGE_RULES.find((rule) => rule.pattern.test(message))?.errorClass;
}

function matchByStatus(status: number | undefined): PublishErrorClass {
  if (status === undefined) return 'TRANSIENT';
  if (status === 401) return 'AUTH';
  if (status === 403) return 'AUTH';
  if (status === 400 || status === 422) return 'VALIDATION';
  if (status === 404) return 'VALIDATION';
  if (status === 429) return 'TRANSIENT';
  if (status >= 500) return 'TRANSIENT';
  // Anything else 4xx: unknown, and a retry of an unknown 4xx is very unlikely to help.
  return status >= 400 ? 'VALIDATION' : 'TRANSIENT';
}

export { PublishErrorClass };
