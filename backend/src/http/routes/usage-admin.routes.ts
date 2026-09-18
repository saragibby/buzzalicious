import { Router } from 'express';
import { getPrisma } from '../../platform/db';
import { ValidationError } from '../../platform/errors';
import { requireAuth } from '../middleware/require-auth';
import { assertPlatformAdmin } from '../../modules/usage/usage.access';
import { getUsagePeriodSummary } from '../../modules/usage/usage.read';
import { parsePeriodKey, periodKeyFor } from '../../modules/usage/period';
import { handle } from './trend.routes';

/**
 * Platform usage, read-only.
 *
 * ADR-0011 asks for "somewhere to look" rather than a billing UI, and this is deliberately
 * the smaller thing: one GET, no mutations. The moment this can adjust a ceiling or void an
 * event it needs an audit trail and an approval path, and that is a decision for whoever
 * answers Q13 — not something to acquire by accident because an endpoint was convenient.
 *
 * Cross-tenant by definition, so it runs on the unscoped client behind
 * `PLATFORM_ADMIN_EMAILS`, which is its own list and not `TREND_ADMIN_EMAILS`: curating
 * content and reading every client's spend are different grants.
 */
export function createUsageAdminRouter(): Router {
  const router = Router();

  router.use(requireAuth, (req, _res, next) => {
    try {
      assertPlatformAdmin(req.user?.email);
      next();
    } catch (error) {
      next(error);
    }
  });

  router.get(
    '/',
    handle(async (req, res) => {
      const raw = req.query.period;
      if (raw !== undefined && typeof raw !== 'string') {
        throw new ValidationError('Period must be a single YYYY-MM value');
      }

      const reference = raw === undefined ? new Date() : parsePeriodKey(raw);
      if (reference === null) {
        throw new ValidationError(`Invalid period "${raw}". Expected YYYY-MM.`);
      }

      const summary = await getUsagePeriodSummary(getPrisma(), reference);

      res.json({
        period: periodKeyFor(reference),
        ...summary,
        // Surfaced separately so the view can lead with it. "Who ran out" is the question
        // this page exists to answer, and making the reader scan for it defeats the point.
        exhausted: summary.workspaces
          .filter((w) => w.exhausted)
          .map((w) => ({
            workspaceId: w.workspaceId,
            workspaceName: w.workspaceName,
            aiSpendUsd: w.aiSpendUsd,
            aiCeilingUsd: w.aiCeilingUsd,
            isPlatformWorkspace: w.isPlatformWorkspace,
          })),
      });
    }),
  );

  return router;
}
