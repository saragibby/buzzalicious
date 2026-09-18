import rateLimit, { type RateLimitRequestHandler } from 'express-rate-limit';
import type { Request, Response } from 'express';
import { getConfig } from './config';
import { RateLimitError, toErrorBody } from './errors';

/**
 * Per-IP abuse protection. The prototype had none.
 *
 * Only `authLimiter` is mounted in M1. `shortLinkLimiter` and `aiLimiter` are configured
 * and tested here so that W6 and W7 mount them rather than inventing limits under
 * deadline — the architecture doc lists all three as foundation concerns.
 *
 * Note on Heroku: every request arrives from the router, so `trust proxy` must be set for
 * `req.ip` to be the client rather than the proxy. Without it, one limiter bucket would
 * cover every user. The bootstrap sets it; this is where it would hurt if it did not.
 */

interface LimiterOptions {
  windowMs: number;
  limit: number;
  message: string;
}

function createLimiter({ windowMs, limit, message }: LimiterOptions): RateLimitRequestHandler {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // Disable entirely under test so suites do not trip over each other.
    skip: () => getConfig().isTest,
    handler: (req: Request, res: Response) => {
      const retryAfterSeconds = Math.ceil(windowMs / 1000);
      const error = new RateLimitError(message, retryAfterSeconds);
      res
        .status(error.status)
        .setHeader('Retry-After', String(retryAfterSeconds))
        .json(toErrorBody(error, req.id as string | undefined));
    },
  });
}

/** Sign-in and OAuth callbacks. Tight — these are the credential-stuffing surface. */
export const authLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  message: 'Too many authentication attempts. Please wait a few minutes and try again.',
});

/**
 * First-party short links (W7). Generous: these are real end users clicking through from
 * a published post, and a false positive is a broken link in the wild.
 */
export const shortLinkLimiter = createLimiter({
  windowMs: 60 * 1000,
  limit: 300,
  message: 'Too many requests.',
});

/** AI generation (W4/W5). Each call costs money, so this is per-account in spirit. */
export const aiLimiter = createLimiter({
  windowMs: 60 * 1000,
  limit: 20,
  message: 'You are generating content too quickly. Please wait a moment.',
});
