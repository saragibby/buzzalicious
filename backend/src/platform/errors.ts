/**
 * Typed application errors.
 *
 * The prototype leaked internals to clients (`details: error.message` straight from a
 * third-party SDK) and handled failures inconsistently. The contract here:
 *
 *  - Throw an `AppError` subclass for anything a client should be told about.
 *  - Throw anything else for a bug. The error middleware turns it into a bare 500 and
 *    logs the detail server-side.
 *
 * `expose` is what separates the two. Nothing with `expose: false` reaches a response
 * body, ever.
 */

import { ZodError, type ZodIssue } from 'zod';

export type ErrorCode =
  | 'VALIDATION_FAILED'
  | 'NOT_FOUND'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'EXTERNAL_SERVICE_ERROR'
  | 'RATE_LIMITED'
  // W10/ADR-0011. Distinct from RATE_LIMITED on purpose: a spend ceiling is not a burst
  // limit, and "wait and retry" is the wrong advice — nothing changes until the billing
  // period rolls over. The subclass lives in modules/usage/usage.errors.ts.
  | 'BUDGET_EXCEEDED'
  | 'INTERNAL_ERROR';

export abstract class AppError extends Error {
  abstract readonly code: ErrorCode;
  abstract readonly status: number;

  /** Whether `message` and `details` may be returned to the client. */
  readonly expose: boolean = true;

  /** Safe, structured context for the client. Must never contain a secret. */
  readonly details?: unknown;

  constructor(message: string, options?: { details?: unknown; cause?: unknown }) {
    super(message, { cause: options?.cause });
    this.name = new.target.name;
    this.details = options?.details;
    Error.captureStackTrace?.(this, new.target);
  }
}

/** 400 — the request was understood but is not acceptable. */
export class ValidationError extends AppError {
  readonly code = 'VALIDATION_FAILED' as const;
  readonly status = 400;
}

/** 401 — no valid session. */
export class AuthError extends AppError {
  readonly code = 'UNAUTHENTICATED' as const;
  readonly status = 401;

  constructor(message = 'Not authenticated', options?: { details?: unknown; cause?: unknown }) {
    super(message, options);
  }
}

/** 403 — authenticated, but not permitted. Distinct from 401 so the SPA can tell them apart. */
export class ForbiddenError extends AppError {
  readonly code = 'FORBIDDEN' as const;
  readonly status = 403;

  constructor(message = 'Not permitted', options?: { details?: unknown; cause?: unknown }) {
    super(message, options);
  }
}

/** 404 */
export class NotFoundError extends AppError {
  readonly code = 'NOT_FOUND' as const;
  readonly status = 404;

  constructor(resource = 'Resource', options?: { details?: unknown; cause?: unknown }) {
    super(`${resource} not found`, options);
  }
}

/** 429 — ours or a platform's. `retryAfterSeconds` drives the header and job backoff. */
export class RateLimitError extends AppError {
  readonly code = 'RATE_LIMITED' as const;
  readonly status = 429;

  constructor(
    message = 'Too many requests',
    readonly retryAfterSeconds?: number,
    options?: { details?: unknown; cause?: unknown },
  ) {
    super(message, options);
  }
}

/**
 * 502 — a third party failed us. Not exposed: upstream error bodies routinely echo back
 * request parameters, and for OAuth calls those parameters are credentials.
 */
export class ExternalServiceError extends AppError {
  readonly code = 'EXTERNAL_SERVICE_ERROR' as const;
  readonly status = 502;
  readonly expose = false;

  constructor(
    readonly service: string,
    message: string,
    options?: { details?: unknown; cause?: unknown; retryable?: boolean },
  ) {
    super(message, options);
    this.retryable = options?.retryable ?? true;
  }

  /** Whether a job should retry. A 4xx from a platform usually should not. */
  readonly retryable: boolean;
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/** The only error shape the API returns. */
export interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
    requestId?: string;
  };
}

export function toErrorBody(error: unknown, requestId?: string): ErrorBody {
  if (isAppError(error) && error.expose) {
    return {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
        ...(requestId ? { requestId } : {}),
      },
    };
  }

  const code: ErrorCode = isAppError(error) ? error.code : 'INTERNAL_ERROR';

  return {
    error: {
      code,
      message: 'Something went wrong. Please try again.',
      ...(requestId ? { requestId } : {}),
    },
  };
}

export function statusFor(error: unknown): number {
  return isAppError(error) ? error.status : 500;
}

/**
 * Turns a `ZodError` into the `ValidationError` it always should have been.
 *
 * Roughly twenty handlers across seven route files call `Schema.parse(req.body)` and hand
 * the failure to `next(error)`. A `ZodError` is not an `AppError`, so `statusFor` fell
 * through to its default and **every malformed request in the app answered 500**. A
 * mistyped field looked identical to a crash: the client got "Something went wrong",
 * the user got no idea which field was wrong, and the 5xx log — the thing that is
 * supposed to mean "our bug" — filled up with other people's typos.
 *
 * Normalising centrally rather than at each call site is deliberate: the bug was that a
 * single omission defeated every route at once, and a fix applied per-handler would be
 * one forgotten `catch` away from reintroducing it.
 *
 * The issue list is safe to expose. Zod reports the shape of what the client itself
 * sent — a path and a reason — and never server state.
 *
 * With one sharp exception, which is why `safeMessage` exists. Most Zod issues describe
 * the *expectation* ("Expected string, received number" names the type, not the value),
 * but `invalid_enum_value` and `invalid_literal` interpolate the **submitted value** into
 * their prose: `... received 'super-secret-token'`. Forwarding those verbatim would echo
 * a rejected value straight back out in an error body, and docs/10 is absolute that a
 * credential secret is never returned, "not even to the client that sent it". Transposing
 * a secret into the wrong field is exactly the kind of client bug that then fails
 * validation, so this is reachable rather than theoretical.
 *
 * For those kinds the message is rebuilt from what *we* declared. `received` is never
 * forwarded at all.
 *
 * What is still echoed, stated precisely, because the previous version of this comment
 * claimed a blanket safety it did not have and that is how the enum leak survived review:
 *
 *  - **`path` forwards client-submitted object keys verbatim.** For a fixed schema a path
 *    segment is a field name we declared, which is safe. For a `z.record()` the key *is*
 *    client data: `CaptionOverridesSchema` is `z.record(PlatformSchema, …)`, so a bad key
 *    on `PATCH /posts/:id` comes back as `captionOverrides.<whatever-they-sent>`.
 *  - **`unrecognized_keys` names the offending key**, which is the whole point of it —
 *    a client cannot fix a misspelled field without being told which one.
 *
 * Both are the client's own input returned to the client that sent it, and both are the
 * information that makes the error actionable, so they are kept deliberately. The residual
 * risk is a caller that transposes a secret into a *key* position rather than a value.
 * If that ever needs closing, the fix is to drop `path` for record-keyed schemas rather
 * than to guess at which segments look sensitive — a length or charset heuristic does not
 * separate `sk-live-…` from a legitimate key and would give false assurance.
 */

/** Issue kinds whose `message` interpolates the value the client sent. */
const VALUE_BEARING_CODES = new Set(['invalid_enum_value', 'invalid_literal']);

function safeMessage(issue: ZodIssue): string {
  if (!VALUE_BEARING_CODES.has(issue.code)) return issue.message;

  if (issue.code === 'invalid_enum_value') {
    // `options` are the values this API declares, so disclosing them is intentional — it
    // is the same information as the API docs, and it is what makes the error actionable.
    return `Expected one of: ${issue.options.map((option) => String(option)).join(', ')}.`;
  }

  return 'That value is not one this field accepts.';
}

export function normalizeError(error: unknown): unknown {
  if (!(error instanceof ZodError)) return error;

  return new ValidationError('The request is not valid.', {
    cause: error,
    details: {
      issues: error.issues.map((issue) => ({
        path: issue.path.join('.'),
        // Exposed so a client can branch on the kind of failure — in particular
        // `unrecognized_keys`, which is a misspelled or renamed field rather than a bad
        // value, and needs a different fix.
        code: issue.code,
        message: safeMessage(issue),
      })),
    },
  });
}
