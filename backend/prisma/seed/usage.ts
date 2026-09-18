import { Prisma, UsageMetric } from '@prisma/client';
import type { Db } from '../../src/platform/db';
import { emitUsage } from '../../src/modules/usage/usage.service';
import { getAiBudgetStatus } from '../../src/modules/usage/budget';
import { rebuildWorkspacePeriod } from '../../src/modules/usage/rollup';
import { periodStartFor } from '../../src/modules/usage/period';
import {
  PLATFORM_WORKSPACE_ID,
  PLATFORM_WORKSPACE_NAME,
  PLATFORM_WORKSPACE_SLUG,
} from '../../src/modules/usage/platform-workspace';
import { createRng, jitter, randomInt } from './deterministic';
import { brandId, workspaceId, WORKSPACES } from './workspaces';

/**
 * Seeded usage history: twelve months, per workspace, written through `emitUsage`.
 *
 * Written through the real emit path rather than inserted directly, for two reasons. It
 * exercises idempotency on every re-run — the seed converges because the keys repeat, not
 * because of an `upsert` — and it means the seeded rollups are produced by the same code
 * the product uses, so a bug in the rollup arithmetic shows up in development data instead
 * of waiting for production.
 *
 * The two tenants are deliberately **shaped differently**, because a seed where both look
 * alike lets a whole class of bug through:
 *
 *  - **Rise & Shore** is publish-heavy and AI-light. Lots of posts, lots of renders, small
 *    AI spend. This is the profile of a customer the fuse should never inconvenience.
 *  - **TaxDedux** is AI-heavy and, in the current month, **over its ceiling** — it carries a
 *    deliberately low per-workspace override so the exhausted state is visible in the admin
 *    view and in the UI without anyone having to spend real money to see it.
 *
 * The reserved `platform` workspace carries platform-global trend classification, which no
 * client should be charged for.
 */

interface MonthlyProfile {
  /** AI calls per month, before jitter. */
  aiCalls: number;
  /** Tokens per AI call, before jitter. */
  tokensPerCall: number;
  /** USD per 1,000 tokens, blended. A seed figure, not a rate card. */
  usdPerThousandTokens: string;
  postsPerMonth: number;
  rendersPerMonth: number;
  /** Collection/curation runs over the global feed. Platform-global work. */
  trendRefreshesPerMonth: number;
}

const PROFILES: Record<string, MonthlyProfile> = {
  'rise-and-shore': {
    aiCalls: 18,
    tokensPerCall: 1_400,
    usdPerThousandTokens: '0.0009',
    postsPerMonth: 22,
    rendersPerMonth: 30,
    trendRefreshesPerMonth: 0,
  },
  taxdedux: {
    aiCalls: 45,
    tokensPerCall: 3_200,
    usdPerThousandTokens: '0.012',
    postsPerMonth: 9,
    rendersPerMonth: 11,
    trendRefreshesPerMonth: 0,
  },
};

/**
 * TaxDedux's override, chosen so its seeded spend lands *over* it.
 *
 * A low ceiling on a seeded tenant, not a low default: the default has to stay the real
 * one, or development stops resembling production in exactly the way that matters.
 */
const TAXDEDUX_CEILING_USD = '0.50';

const MONTHS_OF_HISTORY = 12;

/** Midday on a given day of a month offset back from `now`. Stable across machines. */
function monthOffset(now: Date, monthsAgo: number, day: number): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo, day, 12, 0, 0, 0));
}

function costFor(tokens: number, usdPerThousand: string): Prisma.Decimal {
  return new Prisma.Decimal(tokens).dividedBy(1_000).times(usdPerThousand).toDecimalPlaces(6);
}

export interface SeedUsageResult {
  events: number;
  workspaces: number;
}

/**
 * The reserved workspace that carries platform-global AI work.
 *
 * Also inserted by migration `0002_usage_metering`, because production needs it and never
 * runs the seed. Upserted here so a database built by `prisma db push` — which skips
 * migrations — is not missing the one row trend classification cannot run without.
 */
async function seedPlatformWorkspace(db: Db, now: Date): Promise<void> {
  await db.workspace.upsert({
    where: { id: PLATFORM_WORKSPACE_ID },
    create: {
      id: PLATFORM_WORKSPACE_ID,
      slug: PLATFORM_WORKSPACE_SLUG,
      name: PLATFORM_WORKSPACE_NAME,
      createdAt: monthOffset(now, MONTHS_OF_HISTORY, 1),
    },
    update: { slug: PLATFORM_WORKSPACE_SLUG, name: PLATFORM_WORKSPACE_NAME },
  });
}

async function seedWorkspaceUsage(
  db: Db,
  slug: string,
  wsId: string,
  bId: string | null,
  profile: MonthlyProfile,
  now: Date,
): Promise<number> {
  const rng = createRng(`usage:${slug}`);
  let events = 0;

  for (let monthsAgo = MONTHS_OF_HISTORY - 1; monthsAgo >= 0; monthsAgo -= 1) {
    // The current month is partial: a full month's worth of usage dated "this month" would
    // make every seeded chart lie about the month in progress.
    const partial = monthsAgo === 0 ? 0.6 : 1;
    const scale = (value: number) => Math.max(1, Math.round(jitter(rng, value) * partial));

    const aiCalls = scale(profile.aiCalls);
    for (let i = 0; i < aiCalls; i += 1) {
      const tokens = jitter(rng, profile.tokensPerCall, 0.45);
      const occurredAt = monthOffset(now, monthsAgo, randomInt(rng, 1, 26));

      const { recorded } = await emitUsage(db, {
        workspaceId: wsId,
        brandId: bId,
        metric: UsageMetric.AI_TOKENS,
        quantity: tokens,
        providerCostUsd: costFor(tokens, profile.usdPerThousandTokens),
        idempotencyKey: `seed:ai:${slug}:${monthsAgo}:${i}`,
        occurredAt,
        metadata: { note: 'seeded usage history', purpose: 'caption' },
      });
      if (recorded) events += 1;
    }

    if (bId) {
      const posts = scale(profile.postsPerMonth);
      for (let i = 0; i < posts; i += 1) {
        const { recorded } = await emitUsage(db, {
          workspaceId: wsId,
          brandId: bId,
          metric: UsageMetric.POST_PUBLISHED,
          quantity: 1,
          idempotencyKey: `seed:publish:${slug}:${monthsAgo}:${i}`,
          occurredAt: monthOffset(now, monthsAgo, randomInt(rng, 1, 26)),
          metadata: { note: 'seeded usage history' },
        });
        if (recorded) events += 1;
      }

      const renders = scale(profile.rendersPerMonth);
      for (let i = 0; i < renders; i += 1) {
        const { recorded } = await emitUsage(db, {
          workspaceId: wsId,
          brandId: bId,
          metric: UsageMetric.RENDITION_RENDERED,
          quantity: 1,
          idempotencyKey: `seed:render:${slug}:${monthsAgo}:${i}`,
          occurredAt: monthOffset(now, monthsAgo, randomInt(rng, 1, 26)),
          metadata: { note: 'seeded usage history' },
        });
        if (recorded) events += 1;
      }
    }

    // Trend refreshes are platform-global: one event per curation run over the shared
    // feed, charged to the platform workspace rather than to whoever happened to look at
    // the feed afterwards.
    for (let i = 0; i < profile.trendRefreshesPerMonth; i += 1) {
      const { recorded } = await emitUsage(db, {
        workspaceId: wsId,
        brandId: bId,
        metric: UsageMetric.TREND_REFRESH,
        quantity: 1,
        idempotencyKey: `seed:trend-refresh:${slug}:${monthsAgo}:${i}`,
        occurredAt: monthOffset(now, monthsAgo, 3 + i * 7),
        metadata: { note: 'seeded usage history' },
      });
      if (recorded) events += 1;
    }
  }

  return events;
}

export async function seedUsage(db: Db, now: Date = new Date()): Promise<SeedUsageResult> {
  await seedPlatformWorkspace(db, now);

  let events = 0;
  let workspaces = 0;

  for (const spec of WORKSPACES) {
    const profile = PROFILES[spec.slug];
    if (!profile) throw new Error(`No seeded usage profile for workspace "${spec.slug}"`);

    const wsId = workspaceId(spec.slug);
    events += await seedWorkspaceUsage(db, spec.slug, wsId, brandId(spec.brand.slug), profile, now);
    workspaces += 1;
  }

  // Platform-global trend classification. Modest and steady: one curation pass a week,
  // charged to nobody in particular.
  events += await seedWorkspaceUsage(
    db,
    PLATFORM_WORKSPACE_SLUG,
    PLATFORM_WORKSPACE_ID,
    null,
    {
      aiCalls: 24,
      tokensPerCall: 3_200,
      usdPerThousandTokens: '0.0011',
      postsPerMonth: 0,
      rendersPerMonth: 0,
      trendRefreshesPerMonth: 4,
    },
    now,
  );
  workspaces += 1;

  await db.workspace.update({
    where: { id: workspaceId('taxdedux') },
    data: { aiMonthlyCeilingUsd: new Prisma.Decimal(TAXDEDUX_CEILING_USD) },
  });

  /**
   * Rebuild the current period from the events as a self-check.
   *
   * The seed just wrote a few thousand events through the incremental path. If the
   * incremental rollup and a rebuild from the ledger disagree, that is a billing bug, and
   * the cheapest possible moment to find it is here — on every developer's machine, on
   * every seed run, rather than in a monthly reconciliation nobody has written yet.
   */
  const periodStart = periodStartFor(now);
  for (const wsId of [...WORKSPACES.map((spec) => workspaceId(spec.slug)), PLATFORM_WORKSPACE_ID]) {
    await rebuildWorkspacePeriod(db, wsId, periodStart);
  }

  /**
   * And assert the state the seed exists to demonstrate.
   *
   * "TaxDedux is over its ceiling" is the whole point of that tenant's profile, and it is
   * the kind of property that quietly stops being true when someone tunes a number. A seed
   * that silently stops demonstrating the exhausted state leaves the admin view looking
   * empty and correct.
   */
  const status = await getAiBudgetStatus(db, workspaceId('taxdedux'), now);
  if (!status.exhausted) {
    throw new Error(
      `Seeded TaxDedux usage is meant to be over its AI ceiling, but spent ` +
        `$${status.spentUsd.toFixed(6)} against a $${status.ceilingUsd.toFixed(2)} ceiling. ` +
        'Adjust the profile or TAXDEDUX_CEILING_USD in prisma/seed/usage.ts.',
    );
  }

  return { events, workspaces };
}
