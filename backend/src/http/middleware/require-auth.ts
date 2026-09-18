import type { RequestHandler } from 'express';
import { AuthError } from '../../platform/errors';

/**
 * Session guard.
 *
 * This is deliberately thin. It answers "is there a session?" and nothing else.
 * Authorization — is this user a member of this workspace, may they act on this brand —
 * is W3's, and belongs in `modules/identity/` where it can be tested without Express.
 * Rewriting the prototype's boolean check into an ad-hoc permission system here would
 * put policy in the HTTP layer, which is exactly the layering mistake M1 is correcting.
 */
export const requireAuth: RequestHandler = (req, _res, next) => {
  if (req.isAuthenticated?.()) {
    next();
    return;
  }
  next(new AuthError());
};
