import type { ErrorRequestHandler, RequestHandler } from 'express';
import { getLogger } from '../../platform/logger';
import {
  NotFoundError,
  isAppError,
  normalizeError,
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

export const errorHandler: ErrorRequestHandler = (error: unknown, req, res, next) => {
  if (res.headersSent) {
    // Express cannot recover once a response has started streaming.
    next(error);
    return;
  }

  // A ZodError from a route's `Schema.parse` is a client mistake, not ours. Normalising
  // here — the one place every error passes through — is what keeps a mistyped field a
  // 400 instead of a 500 across all of the routes that validate.
  const normalized = normalizeError(error);

  const requestId = req.id as string | undefined;
  const status = statusFor(normalized);
  const logger = getLogger();

  // A 4xx is usually the client's problem; a 5xx is ours. Log them accordingly so the
  // error stream stays meaningful.
  const payload = {
    requestId,
    status,
    code: isAppError(normalized) ? normalized.code : 'INTERNAL_ERROR',
    err: normalized,
  };

  if (status >= 500) {
    logger.error(payload, 'Request failed');
  } else {
    logger.warn(payload, 'Request rejected');
  }

  if (
    normalized instanceof Object &&
    'retryAfterSeconds' in normalized &&
    normalized.retryAfterSeconds
  ) {
    res.setHeader('Retry-After', String(normalized.retryAfterSeconds));
  }

  res.status(status).json(toErrorBody(normalized, requestId));
};
