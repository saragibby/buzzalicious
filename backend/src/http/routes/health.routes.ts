import { Router } from 'express';
import { getPrisma } from '../../platform/db';

/**
 * Liveness and readiness.
 *
 * `/api/health` is cheap and never touches the database — Heroku's router and any uptime
 * check hit it constantly, and a health endpoint that fails when Postgres is slow turns
 * a degradation into an outage.
 *
 * `/api/health/ready` does check the database, for deploy verification.
 */
export function createHealthRouter(): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json({ status: 'ok' });
  });

  router.get('/ready', (_req, res, next) => {
    void (async () => {
      try {
        await getPrisma().$queryRaw`SELECT 1`;
        res.json({ status: 'ready', database: 'ok' });
      } catch (error) {
        next(error);
      }
    })();
  });

  return router;
}
