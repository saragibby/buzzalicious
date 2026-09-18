import type { Platform } from '@prisma/client';
import { ValidationError } from '../../platform/errors';
import type { ScopedDb } from '../../platform/tenancy';
import {
  PLATFORM_SPECS,
  isSupportedPlatform,
  measureCaption,
  type SupportedPlatform,
} from '../template/platform-spec';

/**
 * The schedule-time caption gate.
 *
 * ## Why here and not in `runPreflight()`
 *
 * docs/08 says to catch an over-length caption "at pre-flight". `runPreflight()` cannot be
 * that place: it is credential-level, it answers "what is this app approved to do", and it
 * never sees a caption. The moment a user *commits* to publishing text is
 * `scheduleTargets()`, so that is where the text has to be checked.
 *
 * Before this, the only gate lived inside `publish()`. An over-length caption was
 * therefore accepted at schedule time and failed when the job ran — which is the middle of
 * the night, to a status nobody is watching, after the slot has passed.
 *
 * ## Counted the platform's way, once
 *
 * Every count goes through the shared `measureCaption`. A `.length` comparison here would
 * recreate the bug this whole area exists to close: a 314-character caption carrying a
 * link weighs 233 to X, so `.length` rejects a post X would happily have taken, and the
 * composer — which counts correctly — would have promised the user it fit.
 *
 * ## The base/override distinction is load-bearing
 *
 * W5's semantics, which this must not flatten: `PostTarget.caption` of `null` means
 * "inherit the base copy", and `''` means "the user deliberately cleared this platform's
 * caption". Falling back to the base on `''` would resurrect copy someone removed on
 * purpose and then publish it.
 */

export interface CaptionMeasurement {
  readonly platform: SupportedPlatform;
  readonly used: number;
  readonly limit: number;
  readonly over: boolean;
  /** False when the limit is our conservative stand-in rather than a documented one. */
  readonly limitVerified: boolean;
}

/**
 * The caption a target will actually publish.
 *
 * `null` inherits; `''` does not. Kept as a named function rather than an inline `??` at
 * each call site precisely because the two look interchangeable and are not.
 */
export function effectiveCaption(override: string | null, base: string | null): string {
  if (override !== null) return override;
  return base ?? '';
}

export function measureFor(platform: SupportedPlatform, caption: string): CaptionMeasurement {
  const count = measureCaption(platform, caption);
  return {
    platform,
    used: count.used,
    limit: count.limit,
    over: count.over,
    limitVerified: PLATFORM_SPECS[platform].captionLimitVerified,
  };
}

/**
 * The message the user sees.
 *
 * Where the limit is unverified, this says so and says whose limit it is. Facebook
 * publishes no official `message` limit, so ours is a deliberately conservative
 * stand-in — and presenting our own guess as Facebook's rule would be asserting a fact we
 * do not have. The runbook records how to raise it.
 */
export function describeOverLength(measurement: CaptionMeasurement): string {
  const spec = PLATFORM_SPECS[measurement.platform];
  const counted =
    spec.captionCountUnit === 'utf8-bytes'
      ? 'bytes'
      : spec.captionCountUnit === 'x-weighted'
        ? 'characters as X weights them, where every link counts as 23'
        : 'characters';

  const base =
    `That caption is ${measurement.used} ${counted} for ${spec.label}, ` +
    `and the limit is ${measurement.limit}.`;

  return measurement.limitVerified
    ? base
    : `${base} ${spec.label} publishes no official limit, so we use a conservative one.`;
}

/**
 * Reject any target whose effective caption will not fit.
 *
 * Reads through the scoped client, so a caller cannot schedule another tenant's targets by
 * naming their ids — the gate sees only what the scope can.
 */
export async function assertCaptionsFit(db: ScopedDb, targetIds: string[]): Promise<void> {
  if (targetIds.length === 0) return;

  const targets = await db.postTarget.findMany({
    where: { id: { in: targetIds } },
    select: {
      id: true,
      platform: true,
      caption: true,
      post: { select: { baseCopy: true } },
    },
  });

  for (const target of targets) {
    if (!isSupportedPlatform(target.platform)) continue;

    const caption = effectiveCaption(target.caption, target.post.baseCopy);
    const measurement = measureFor(target.platform, caption);

    if (measurement.over) {
      throw new ValidationError(describeOverLength(measurement));
    }
  }
}

export type { Platform };
