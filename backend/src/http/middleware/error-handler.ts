import type { ErrorRequestHandler, RequestHandler } from 'express';
import { getLogger } from '../../platform/logger';
import { NotFoundError, isAppError, statusFor, toErrorBody } from '../../platform/errors';

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

export const errorHandler: ErrorRequestHandler = (error, req, res, next) => {
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
