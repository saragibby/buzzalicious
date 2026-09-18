/**
 * When a published post gets its metrics read, and how a re-read stays harmless.
 *
 * ## Snapshots, never edits
 *
 * Each poll writes a **new** `PostMetric` row. Nothing here ever updates one. The history
 * is the product: "this post got 40 likes" is worth far less than "this post got 40 likes
 * in the first hour and nothing after", and the second only exists if every reading is
 * kept. An `update` would also silently destroy the evidence that a platform restated a
 * number, which is the thing we most want to know about a platform.
 *
 * ## Idempotency without mutation
 *
 * pg-boss delivers at least once, so a handler *will* occasionally run twice for the same
 * target — a worker dyno cycling mid-poll is ordinary. The reconciliation is that
 * `capturedAt` is the **checkpoint's** timestamp rather than `now()`, so a redelivery
 * computes the same value and collides with the existing `@@unique([postTargetId,
 * capturedAt])` row instead of writing a near-duplicate a few seconds later.
 *
 * That is what `modules/insight/README.md` means by idempotent, and it is not in tension
 * with "never mutate a total": running the *same* checkpoint twice must not produce two
 * rows, while a platform restating a number at a *later* checkpoint must produce a new
 * snapshot rather than an edit to the old one.
 */

/**
 * Hours after publication at which a snapshot is taken.
 *
 * 1h and 24h catch the burst, where nearly all engagement happens and where the shape of
 * the curve distinguishes a post that travelled from one that was merely seen. The weekly
 * readings out to 30 days catch the long tail — saves and link clicks keep accruing on
 * evergreen content for weeks, which is exactly the outcome this product claims to
 * measure and vanity engagement does not.
 */
export const CHECKPOINT_HOURS = [1, 24, 168, 336, 504, 720] as const;

export type CheckpointHour = (typeof CHECKPOINT_HOURS)[number];

const HOUR_MS = 60 * 60 * 1000;

/** The exact instant a checkpoint's snapshot is stamped with. */
export function checkpointAt(publishedAt: Date, hour: number): Date {
  return new Date(publishedAt.getTime() + hour * HOUR_MS);
}

/**
 * Which checkpoints are due and not yet captured.
 *
 * Returns every missed checkpoint rather than only the most recent one. A worker that was
 * down for two days would otherwise skip the 24h reading permanently, leaving a gap that
 * looks identical to "this post earned nothing overnight" — a false zero, and the
 * recommender cannot tell the difference.
 *
 * `captured` is compared by timestamp rather than by count, so a partially-filled history
 * fills its own holes instead of assuming the first N checkpoints were done.
 */
export function dueCheckpoints(
  publishedAt: Date,
  now: Date,
  captured: readonly Date[],
): { hour: number; capturedAt: Date }[] {
  const seen = new Set(captured.map((date) => date.getTime()));

  return CHECKPOINT_HOURS.map((hour) => ({ hour, capturedAt: checkpointAt(publishedAt, hour) }))
    .filter((checkpoint) => checkpoint.capturedAt.getTime() <= now.getTime())
    .filter((checkpoint) => !seen.has(checkpoint.capturedAt.getTime()));
}

/** Has this post finished its measurement window entirely? */
export function pollingComplete(publishedAt: Date, now: Date, captured: readonly Date[]): boolean {
  const last = CHECKPOINT_HOURS[CHECKPOINT_HOURS.length - 1]!;
  if (checkpointAt(publishedAt, last).getTime() > now.getTime()) return false;
  return dueCheckpoints(publishedAt, now, captured).length === 0;
}

/**
 * Hours since publication, for `PostMetricRaw.hoursSincePublish`.
 *
 * Recorded so two snapshots can be compared like-for-like. Comparing a 23-hour reading
 * with a 25-hour one as though both were "day one" is the kind of error that survives
 * review because both numbers are individually correct.
 */
export function hoursSincePublish(publishedAt: Date, capturedAt: Date): number {
  return (capturedAt.getTime() - publishedAt.getTime()) / HOUR_MS;
}
