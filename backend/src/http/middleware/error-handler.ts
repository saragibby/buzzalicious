import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
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
 * `issues` is safe to expose: it names the offending paths and why they failed, which is
 * exactly what the client needs to fix the call, and it carries only what the client
 * already sent. `message` is deliberately generic rather than Zod's default, which
 * stringifies the whole issue array into a wall of JSON.
 */
function normalize(error: unknown): unknown {
  if (!(error instanceof ZodError)) return error;

  return new ValidationError('That request body is not valid.', {
    details: {
      issues: error.issues.map((issue) => ({
        path: issue.path.join('.'),
        code: issue.code,
        message: issue.message,
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
