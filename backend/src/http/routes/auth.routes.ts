import { Router } from 'express';
import type { PassportStatic } from 'passport';
import { getConfig } from '../../platform/config';
import { authLimiter } from '../../platform/rate-limit';
import { requireAuth } from '../middleware/require-auth';

/**
 * Sign-in, sign-out, and "who am I".
 *
 * Redirect rule, learned the hard way (docs/reference/platform-quirks.md): **always
 * redirect to an absolute URL built from config, and never branch the target on
 * NODE_ENV.** The prototype added an environment branch here and reverted it six minutes
 * later; an absolute URL behaves identically in both topologies.
 */
export function createAuthRouter(passport: PassportStatic): Router {
  const router = Router();
  const config = getConfig();

  router.use(authLimiter);

  router.get('/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

  router.get(
    '/google/callback',
    passport.authenticate('google', { failureRedirect: `${config.webUrl}/login?error=denied` }),
    (_req, res) => {
      res.redirect(config.webUrl);
    },
  );

  router.post('/logout', (req, res, next) => {
    req.logout((error) => {
      if (error) {
        next(error);
        return;
      }
      // Destroy the session row too, rather than leaving an orphan in Postgres.
      req.session.destroy(() => {
        res.clearCookie('buzz.sid');
        res.json({ ok: true });
      });
    });
  });

  router.get('/me', requireAuth, (req, res) => {
    const user = req.user as {
      id: string;
      email: string;
      name: string | null;
      picture: string | null;
    };

    // Explicit projection, not the whole row. The prototype returned `req.user` verbatim,
    // which on the old schema meant returning every OAuth token it held.
    res.json({
      id: user.id,
      email: user.email,
      name: user.name,
      picture: user.picture,
    });
  });

  return router;
}
