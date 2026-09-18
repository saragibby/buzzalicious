import type { Platform, ScheduleSource } from '@prisma/client';
import { outcomeScore } from '../../src/modules/insight/outcome';
import type { TargetOutcome } from '../../src/modules/insight/insight.service';

/**
 * A `TargetOutcome` builder for W8's scoring tests.
 *
 * Lives under `tests/` rather than in `src/modules/recommend/` so it cannot be imported by
 * shipped code. Defaults are chosen so that a fixture only has to state the thing it is
 * actually testing: `impressions` is 1000 everywhere, so a count of 10 is a rate of 0.01
 * and a median can be read off by eye, and `scheduleSource` is `USER` so a test about
 * outcome never has to think about contamination.
 */
export interface TargetSpec {
  platform?: Platform;
  brandId?: string;
  archetype?: string | null;
  postId?: string;
  scheduleSource?: ScheduleSource;
  scheduleSlot?: string | null;
  scheduledLocal?: string | null;
  scheduledTz?: string | null;
  publishedAt?: Date | null;
  linkClicks?: number | null;
  saves?: number | null;
  shares?: number | null;
  likes?: number | null;
  comments?: number | null;
  impressions?: number | null;
}

let seq = 0;

/** Reset the id counter so a test that asserts on ids is not order-dependent. */
export function resetTargetSeq(): void {
  seq = 0;
}

export function makeTarget(spec: TargetSpec = {}): TargetOutcome {
  seq += 1;
  const metrics = {
    linkClicks: spec.linkClicks === undefined ? 10 : spec.linkClicks,
    saves: spec.saves === undefined ? null : spec.saves,
    shares: spec.shares === undefined ? null : spec.shares,
    likes: spec.likes === undefined ? null : spec.likes,
    comments: spec.comments === undefined ? null : spec.comments,
  };

  return {
    postTargetId: `target-${seq}`,
    postId: spec.postId ?? `post-${seq}`,
    postTitle: null,
    platform: spec.platform ?? 'X',
    publishedAt:
      spec.publishedAt === undefined ? new Date('2026-01-01T12:00:00Z') : spec.publishedAt,
    templateId: 'template-1',
    templateName: 'Template',
    trendId: null,
    brandId: spec.brandId ?? 'brand-1',
    archetype: spec.archetype === undefined ? 'BEFORE_AFTER' : spec.archetype,
    scheduleSource: spec.scheduleSource ?? 'USER',
    scheduleSlot: spec.scheduleSlot ?? null,
    scheduledLocal: spec.scheduledLocal ?? null,
    scheduledTz: spec.scheduledTz ?? null,
    ...metrics,
    impressions: spec.impressions === undefined ? 1000 : spec.impressions,
    reach: null,
    videoViews: null,
    capturedAt: new Date('2026-01-02T12:00:00Z'),
    outcome: outcomeScore(metrics),
  };
}

/** `count` identical targets. For building a median with a known sample behind it. */
export function makeTargets(count: number, spec: TargetSpec = {}): TargetOutcome[] {
  return Array.from({ length: count }, () => makeTarget(spec));
}
