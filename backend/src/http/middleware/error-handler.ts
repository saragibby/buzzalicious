import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError, type ZodIssue } from 'zod';
import { getLogger } from '../../platform/logger';
import {
  NotFoundError,
  ValidationError,
  isAppError,
  statusFor,
  toErrorBody,
} from '../../platform/errors';

/**
 * The single error boundary. Registered last, after every router.
 *
 * Client-facing rule: `toErrorBody` decides what is safe to say. An `AppError` with
 * `expose: true` gets its message; everything else gets a generic 500 body and a request
 * ID to quote. Full detail only ever reaches the log.
 */

/** 404 for unmatched API routes. Mounted before the error handler. */
export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new NotFoundError(`Route ${req.method} ${req.path}`));
};

/**
 * A rejected request body is the client's mistake, not ours.
 *
 * Every router validates with `Schema.parse(req.body)`, which throws a `ZodError`. A
 * `ZodError` is not an `AppError`, so without this it fell through to the generic branch
 * and became a **500 logged at error level** — telling the client nothing actionable,
 * blaming the server for a malformed request, and burying real faults in noise from
 * ordinary bad input.
 *
 * Converted rather than special-cased downstream so `statusFor`/`toErrorBody` stay
 * Zod-free and every existing exposure rule continues to apply unchanged.
 *
 * ## What may be said back
 *
 * `issues` names the offending path and why it failed, which is what the client needs to
 * fix the call. What it must **not** do is echo the rejected value: docs/10 is absolute
 * that a credential secret is never returned, "not even to the client that sent it", and
 * a body carrying one can certainly fail validation.
 *
 * `received` is therefore never forwarded — and neither is Zod's own `message` for the
 * issue kinds that embed the value in their prose. `invalid_enum_value` renders as
 * `... received 'super-secret-token'`, so for those kinds the message is replaced with one
 * built only from what *we* declared. The allowed options are ours to disclose; the
 * submitted value is not.
 *
 * The outer `message` is generic rather than Zod's default, which stringifies the whole
 * issue array into a wall of JSON.
 */

/**
 * Issue kinds whose `message` interpolates the value the client sent. Everything else in
 * Zod describes the *expectation* ("Expected string, received number" names the type, not
 * the value) and is safe to pass through verbatim.
 */
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

function normalize(error: unknown): unknown {
  if (!(error instanceof ZodError)) return error;

  return new ValidationError('That request body is not valid.', {
    details: {
      issues: error.issues.map((issue) => ({
        path: issue.path.join('.'),
        code: issue.code,
        message: safeMessage(issue),
      })),
    },
    cause: error,
  });
}

export const errorHandler: ErrorRequestHandler = (caught, req, res, next) => {
  const error = normalize(caught);

  if (res.headersSent) {
    // Express cannot recover once a response has started streaming.
    next(error);
    return;
  }

  const requestId = req.id as string | undefined;
  const status = statusFor(error);
  const logger = getLogger();

  // A 4xx is usually the client's problem; a 5xx is ours. Log them accordingly so the
  // error stream stays meaningful.
  const payload = {
    requestId,
    status,
    code: isAppError(error) ? error.code : 'INTERNAL_ERROR',
    err: error,
  };

  if (status >= 500) {
    logger.error(payload, 'Request failed');
  } else {
    logger.warn(payload, 'Request rejected');
  }

  if (error instanceof Object && 'retryAfterSeconds' in error && error.retryAfterSeconds) {
    res.setHeader('Retry-After', String(error.retryAfterSeconds));
  }

  res.status(status).json(toErrorBody(error, requestId));
};
