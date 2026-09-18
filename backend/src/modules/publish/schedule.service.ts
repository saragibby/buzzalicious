import type { PostTarget } from '@prisma/client';
import type { Db } from '../../platform/db';
import type { ScopedDb } from '../../platform/tenancy';
import { ValidationError } from '../../platform/errors';
import { assertCaptionsFit } from './caption-gate';

/**
 * Scheduling.
 *
 * The durability rule from docs/08 is the whole design: a scheduled post survives a
 * process restart. So the schedule lives in `PostTarget.scheduledFor` — a row — and the
 * job queue is only a mechanism for noticing that a row has come due. The prototype kept
 * timers in memory, which meant every deploy silently dropped everything scheduled, and
 * nothing anywhere recorded that it had happened.
 *
 * A consequence worth stating: the sweep is the source of truth, not the queue. If the
 * queue loses a job the sweep picks the target up on its next pass; if the queue delivers
 * twice, `externalPostId` makes the second delivery a no-op. Neither failure needs an
 * operator.
 */

export interface ScheduleInput {
  targetIds: string[];
  scheduledFor: Date;
}

const MAX_SCHEDULE_HORIZON_DAYS = 365;

export async function scheduleTargets(
  db: ScopedDb,
  input: ScheduleInput,
  now: Date = new Date(),
): Promise<number> {
  if (input.scheduledFor.getTime() <= now.getTime()) {
    throw new ValidationError('A scheduled time must be in the future.');
  }
  const horizon = new Date(now.getTime() + MAX_SCHEDULE_HORIZON_DAYS * 24 * 60 * 60 * 1000);
  if (input.scheduledFor.getTime() > horizon.getTime()) {
    throw new ValidationError('A post cannot be scheduled more than a year ahead.');
  }

  // Before anything is marked SCHEDULED. An over-length caption used to be accepted here
  // and rejected by the adapter when the job ran — long after the user had moved on, and
  // at a moment nobody is watching. Scheduling is the commitment; this is where the text
  // has to be answerable for.
  await assertCaptionsFit(db, input.targetIds);

  const { count } = await db.postTarget.updateMany({
    // Only targets that have not gone anywhere yet. Rescheduling something already
    // published would leave a live post with a future date attached to it.
    where: { id: { in: input.targetIds }, status: { in: ['DRAFT', 'SCHEDULED', 'FAILED'] } },
    data: {
      status: 'SCHEDULED',
      scheduledFor: input.scheduledFor,
      nextAttemptAt: null,
      lastError: null,
      errorClass: null,
    },
  });

  return count;
}

export async function cancelTargets(db: ScopedDb, targetIds: string[]): Promise<number> {
  const { count } = await db.postTarget.updateMany({
    where: { id: { in: targetIds }, status: { in: ['DRAFT', 'SCHEDULED', 'BLOCKED'] } },
    data: { status: 'CANCELLED', nextAttemptAt: null },
  });
  return count;
}

/**
 * Targets that are due to be attempted now.
 *
 * `nextAttemptAt` and `scheduledFor` are both honoured, and a backed-off retry is due at
 * `nextAttemptAt` even though its `scheduledFor` passed long ago — which is why the
 * condition is a disjunction rather than a single column. Collapsing them was the obvious
 * simplification and it would make every retry fire immediately.
 */
export async function findDueTargets(
  db: Db,
  now: Date = new Date(),
  limit = 100,
): Promise<PostTarget[]> {
  return db.postTarget.findMany({
    where: {
      status: 'SCHEDULED',
      externalPostId: null,
      OR: [
        { nextAttemptAt: { lte: now } },
        { AND: [{ nextAttemptAt: null }, { scheduledFor: { lte: now } }] },
      ],
    },
    orderBy: [{ scheduledFor: 'asc' }],
    take: limit,
  });
}
