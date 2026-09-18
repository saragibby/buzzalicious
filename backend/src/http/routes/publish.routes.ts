import { Router } from 'express';
import { z } from 'zod';
import { getPrisma } from '../../platform/db';
import { NotFoundError, ValidationError } from '../../platform/errors';
import { requireAuth } from '../middleware/require-auth';
import { requireBrand, brandOf } from '../middleware/require-scope';
import { cancelTargets, scheduleTargets } from '../../modules/publish/schedule.service';
import { publishTarget } from '../../modules/publish/publish.service';
import { listConnections } from '../../modules/publish/connection.service';
import { enqueuePublish } from '../../jobs';
import { handle } from './trend.routes';

/**
 * Scheduling and publishing, per brand.
 *
 * `POST /publish` enqueues rather than publishes inline. A platform call can take tens of
 * seconds — Meta's container flow is two round trips plus a poll — and holding a web dyno
 * open for it means Heroku's 30-second router timeout returns a 503 to a user whose post
 * is, in fact, going out. Enqueuing makes the outcome observable on the target row instead
 * of tied to the lifetime of an HTTP request.
 */
export function createPublishRouter(): Router {
  const router = Router({ mergeParams: true });

  router.use(requireAuth);

  const TargetIdsSchema = z.object({
    targetIds: z.array(z.string().uuid()).min(1, 'Select at least one destination.'),
  });

  const ScheduleSchema = TargetIdsSchema.extend({
    scheduledFor: z.coerce.date(),
  });

  /** Confirm every named target belongs to the scoped brand before acting on it. */
  async function assertOwned(
    db: ReturnType<typeof brandOf>['db'],
    targetIds: string[],
  ): Promise<void> {
    // The scoped client filters `PostTarget` by brand, so a target belonging to another
    // brand simply is not found. Counting and comparing turns that into an explicit 404
    // rather than a silently partial `updateMany`.
    const found = await db.postTarget.findMany({
      where: { id: { in: targetIds } },
      select: { id: true },
    });
    if (found.length !== targetIds.length) {
      throw new NotFoundError('Post target');
    }
  }

  router.post(
    '/schedule',
    requireBrand('brandId', { minimumRole: 'MEMBER' }),
    handle(async (req, res) => {
      const { db } = brandOf(req);
      const input = ScheduleSchema.parse(req.body);
      if (Number.isNaN(input.scheduledFor.getTime())) {
        throw new ValidationError('Invalid scheduled time.');
      }

      await assertOwned(db, input.targetIds);
      const scheduled = await scheduleTargets(db, {
        targetIds: input.targetIds,
        scheduledFor: input.scheduledFor,
      });

      res.json({ scheduled });
    }),
  );

  router.post(
    '/cancel',
    requireBrand('brandId', { minimumRole: 'MEMBER' }),
    handle(async (req, res) => {
      const { db } = brandOf(req);
      const { targetIds } = TargetIdsSchema.parse(req.body);
      await assertOwned(db, targetIds);
      res.json({ cancelled: await cancelTargets(db, targetIds) });
    }),
  );

  router.post(
    '/publish',
    requireBrand('brandId', { minimumRole: 'MEMBER' }),
    handle(async (req, res) => {
      const { db } = brandOf(req);
      const { targetIds } = TargetIdsSchema.parse(req.body);
      await assertOwned(db, targetIds);

      // Mark them scheduled-now first, so the sweep is a safety net if the enqueue itself
      // is lost. A queue send that fails after a 202 would otherwise strand the post in a
      // state nothing ever retries.
      await db.postTarget.updateMany({
        where: { id: { in: targetIds }, status: { in: ['DRAFT', 'SCHEDULED', 'FAILED'] } },
        data: {
          status: 'SCHEDULED',
          scheduledFor: new Date(),
          nextAttemptAt: null,
          lastError: null,
          errorClass: null,
        },
      });

      for (const targetId of targetIds) {
        await enqueuePublish(targetId);
      }

      res.status(202).json({ queued: targetIds.length });
    }),
  );

  router.post(
    '/publish-now/:targetId',
    requireBrand('brandId', { minimumRole: 'ADMIN' }),
    handle(async (req, res) => {
      const { db } = brandOf(req);
      const targetId = req.params.targetId!;
      await assertOwned(db, [targetId]);

      // Synchronous, single target, ADMIN only. This exists for support and for the
      // "it failed, try it again while I watch" case, where the whole value is seeing the
      // platform's actual answer rather than a queued acknowledgement.
      const outcome = await publishTarget(getPrisma(), {
        targetId,
        actor: `user:${req.user!.id}`,
      });

      res.json({ outcome });
    }),
  );

  // Appended at the end of the route block: W5 is editing this file's neighbours in
  // parallel, and appending rather than inserting keeps the merge conflict trivial.
  router.get(
    '/accounts',
    requireBrand('brandId', { minimumRole: 'MEMBER' }),
    handle(async (req, res) => {
      const { db } = brandOf(req);
      res.json({ accounts: await listConnections(db) });
    }),
  );

  return router;
}
