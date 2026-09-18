import { Prisma, UsageMetric } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedId } from '../../prisma/seed/deterministic';
import { workspaceId } from '../../prisma/seed/workspaces';
import { disconnectPrisma, getPrisma, type Db } from '../../src/platform/db';
import { withTenantScope } from '../../src/platform/tenancy';
import { ValidationError } from '../../src/platform/errors';
import { emitUsage } from '../../src/modules/usage/usage.service';
import { computePeriodFromEvents, rebuildWorkspacePeriod } from '../../src/modules/usage/rollup';
import { assertAiBudgetAvailable, getAiBudgetStatus } from '../../src/modules/usage/budget';
import { BudgetExceededError } from '../../src/modules/usage/usage.errors';
import { periodStartFor } from '../../src/modules/usage/period';
import {
  PLATFORM_WORKSPACE_ID,
  PLATFORM_WORKSPACE_SLUG,
} from '../../src/modules/usage/platform-workspace';
import { hasTestDatabase } from '../env';

/**
 * The usage meter, against a real database.
 *
 * Two of the properties asserted here are trivially satisfiable by a vacuous test —
 * "emitting twice recorded one event" passes if emitting never records anything, and
 * "rebuild equals the incremental total" passes if both are zero. So every one of those
 * assertions is paired with a **control** that must move the same number:
 *
 *  - the idempotency test emits a *different* key and asserts the rollup advances;
 *  - the agreement test asserts a non-zero event count before comparing;
 *  - the rebuild test first corrupts the rollup and asserts the comparison *fails*, so the
 *    subsequent pass proves the repair rather than the absence of a check.
 *
 * Each test uses its own throwaway workspace and its own period, so nothing here depends
 * on seed contents or on file execution order — Vitest orders files by size, not name.
 */

const PERIOD = new Date('2031-05-09T10:00:00.000Z');
const PERIOD_START = periodStartFor(PERIOD);

interface Fixture {
  workspaceId: string;
}

describe.skipIf(!hasTestDatabase)('usage metering', () => {
  let db: Db;
  const created: string[] = [];

  async function makeWorkspace(name: string, ceilingUsd?: string): Promise<Fixture> {
    const id = seedId('test-workspace', `usage/${name}`);
    await db.workspace.upsert({
      where: { id },
      create: {
        id,
        slug: `usage-test-${name}`,
        name: `Usage test ${name}`,
        ...(ceilingUsd ? { aiMonthlyCeilingUsd: new Prisma.Decimal(ceilingUsd) } : {}),
      },
      update: {
        aiMonthlyCeilingUsd: ceilingUsd ? new Prisma.Decimal(ceilingUsd) : null,
      },
    });

    // Re-runnable: a previous run of this file leaves events behind, and a ledger that
    // accumulates across runs would make every total here depend on how often the suite
    // has been run on this database.
    await db.usageEvent.deleteMany({ where: { workspaceId: id } });
    await db.usagePeriodRollup.deleteMany({ where: { workspaceId: id } });

    created.push(id);
    return { workspaceId: id };
  }

  async function rollup(
    id: string,
    metric: UsageMetric = UsageMetric.AI_TOKENS,
  ): Promise<{ quantity: bigint; providerCostUsd: Prisma.Decimal; eventCount: number } | null> {
    return db.usagePeriodRollup.findUnique({
      where: {
        workspaceId_metric_periodStart: { workspaceId: id, metric, periodStart: PERIOD_START },
      },
      select: { quantity: true, providerCostUsd: true, eventCount: true },
    });
  }

  beforeAll(() => {
    db = getPrisma();
  });

  afterAll(async () => {
    await db.usageEvent.deleteMany({ where: { workspaceId: { in: created } } });
    await db.usagePeriodRollup.deleteMany({ where: { workspaceId: { in: created } } });
    await db.workspace.deleteMany({ where: { id: { in: created } } });
    await disconnectPrisma();
  });

  describe('idempotency', () => {
    it('records one event and one increment for a repeated key, and still advances for a new one', async () => {
      const { workspaceId: ws } = await makeWorkspace('idempotency');

      const first = await emitUsage(db, {
        workspaceId: ws,
        metric: UsageMetric.AI_TOKENS,
        quantity: 1_500,
        providerCostUsd: '0.001200',
        idempotencyKey: 'publish:fixed-key',
        occurredAt: PERIOD,
      });
      const replay = await emitUsage(db, {
        workspaceId: ws,
        metric: UsageMetric.AI_TOKENS,
        quantity: 1_500,
        providerCostUsd: '0.001200',
        idempotencyKey: 'publish:fixed-key',
        occurredAt: PERIOD,
      });

      expect(first.recorded).toBe(true);
      expect(replay.recorded).toBe(false);

      expect(await db.usageEvent.count({ where: { workspaceId: ws } })).toBe(1);

      const afterReplay = await rollup(ws);
      expect(afterReplay?.quantity).toBe(1_500n);
      expect(afterReplay?.providerCostUsd.toString()).toBe('0.0012');
      expect(afterReplay?.eventCount).toBe(1);

      /**
       * The control.
       *
       * Everything above passes just as happily if `emitUsage` is broken and records
       * nothing at all. This proves the numbers it is asserting *can* move: a second,
       * genuinely different unit of work must produce a second event and a second
       * increment.
       */
      const distinct = await emitUsage(db, {
        workspaceId: ws,
        metric: UsageMetric.AI_TOKENS,
        quantity: 1_500,
        providerCostUsd: '0.001200',
        idempotencyKey: 'publish:different-key',
        occurredAt: PERIOD,
      });

      expect(distinct.recorded).toBe(true);
      expect(await db.usageEvent.count({ where: { workspaceId: ws } })).toBe(2);

      const afterDistinct = await rollup(ws);
      expect(afterDistinct?.quantity).toBe(3_000n);
      expect(afterDistinct?.providerCostUsd.toString()).toBe('0.0024');
      expect(afterDistinct?.eventCount).toBe(2);
    });

    it('does not lose an increment when the same metric is emitted concurrently', async () => {
      const { workspaceId: ws } = await makeWorkspace('concurrent');

      // Read-then-write upsert loses increments here; `INSERT … ON CONFLICT DO UPDATE`
      // does not. This is the case the raw SQL in `applyRollupDelta` exists for.
      await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          emitUsage(db, {
            workspaceId: ws,
            metric: UsageMetric.AI_TOKENS,
            quantity: 100,
            providerCostUsd: '0.000500',
            idempotencyKey: `concurrent:${i}`,
            occurredAt: PERIOD,
          }),
        ),
      );

      const row = await rollup(ws);
      expect(row?.quantity).toBe(800n);
      expect(row?.eventCount).toBe(8);
      expect(row?.providerCostUsd.toString()).toBe('0.004');
    });

    it('stores the rollup period at the same instant as the events under it', async () => {
      const { workspaceId: ws } = await makeWorkspace('period-binding');

      await emitUsage(db, {
        workspaceId: ws,
        metric: UsageMetric.AI_TOKENS,
        quantity: 10,
        providerCostUsd: '0.01',
        idempotencyKey: 'binding:1',
        occurredAt: PERIOD,
      });

      /**
       * A regression test for a real bug found writing this file.
       *
       * The rollup is written by raw SQL and the events by Prisma. `periodStart` is
       * `timestamp without time zone`, and a raw-bound `Date` is serialized in the
       * process's local zone — so on a machine in New York the rollup landed four hours
       * before the events it summarised, and every lookup by period missed. It is
       * invisible on a UTC host, which means CI would have been green while every
       * developer's machine was silently wrong about which month spend belonged to.
       *
       * Asserting against a literal UTC instant rather than against `periodStartFor`
       * matters: comparing the two code paths to each other passes if both are shifted.
       */
      const event = await db.usageEvent.findFirstOrThrow({
        where: { workspaceId: ws },
        select: { periodStart: true },
      });
      const stored = await rollup(ws);

      expect(event.periodStart.toISOString()).toBe('2031-05-01T00:00:00.000Z');
      expect(stored).not.toBeNull();

      const [raw] = await db.$queryRaw<{ periodStart: Date; periodEnd: Date }[]>`
        SELECT "periodStart", "periodEnd" FROM "usage_period_rollups"
        WHERE "workspaceId" = ${ws}
      `;
      expect(raw?.periodStart.toISOString()).toBe('2031-05-01T00:00:00.000Z');
      expect(raw?.periodEnd.toISOString()).toBe('2031-06-01T00:00:00.000Z');
    });

    it('rejects an attempt-scoped key, and accepts the attempt-independent form', async () => {
      const { workspaceId: ws } = await makeWorkspace('attempt-keys');

      await expect(
        emitUsage(db, {
          workspaceId: ws,
          metric: UsageMetric.POST_PUBLISHED,
          quantity: 1,
          idempotencyKey: 'publish:target-1:attempt-2',
          occurredAt: PERIOD,
        }),
      ).rejects.toBeInstanceOf(ValidationError);

      // The control: the guard must not reject the key callers are supposed to use.
      await expect(
        emitUsage(db, {
          workspaceId: ws,
          metric: UsageMetric.POST_PUBLISHED,
          quantity: 1,
          idempotencyKey: 'publish:target-1',
          occurredAt: PERIOD,
        }),
      ).resolves.toMatchObject({ recorded: true });
    });

    it('records nothing when the surrounding transaction rolls back', async () => {
      const { workspaceId: ws } = await makeWorkspace('rollback');

      await expect(
        db.$transaction(async (tx) => {
          await emitUsage(tx, {
            workspaceId: ws,
            metric: UsageMetric.AI_TOKENS,
            quantity: 999,
            providerCostUsd: '0.5',
            idempotencyKey: 'rollback:work',
            occurredAt: PERIOD,
          });
          throw new Error('the metered work failed after the event was written');
        }),
      ).rejects.toThrow('the metered work failed');

      expect(await db.usageEvent.count({ where: { workspaceId: ws } })).toBe(0);
      expect(await rollup(ws)).toBeNull();

      // The control: the same emit outside a failing transaction does record, so the
      // assertion above is about the rollback and not about emit being inert.
      await emitUsage(db, {
        workspaceId: ws,
        metric: UsageMetric.AI_TOKENS,
        quantity: 999,
        providerCostUsd: '0.5',
        idempotencyKey: 'rollback:work',
        occurredAt: PERIOD,
      });
      expect(await db.usageEvent.count({ where: { workspaceId: ws } })).toBe(1);
    });
  });

  describe('rollup agreement', () => {
    it('matches a rebuild from the ledger, and the rebuild repairs deliberate drift', async () => {
      const { workspaceId: ws } = await makeWorkspace('agreement');

      let expectedTokens = 0n;
      let expectedCost = new Prisma.Decimal(0);
      for (let i = 0; i < 12; i += 1) {
        const quantity = 100 + i * 7;
        const cost = new Prisma.Decimal('0.000031').times(i + 1);
        expectedTokens += BigInt(quantity);
        expectedCost = expectedCost.plus(cost);

        await emitUsage(db, {
          workspaceId: ws,
          metric: UsageMetric.AI_TOKENS,
          quantity,
          providerCostUsd: cost,
          idempotencyKey: `agree:${i}`,
          occurredAt: new Date(PERIOD.getTime() + i * 3_600_000),
        });
      }

      // A compensating event. The ledger is append-only, so a correction is negative
      // quantity rather than an UPDATE — and both paths have to agree about it.
      await emitUsage(db, {
        workspaceId: ws,
        metric: UsageMetric.AI_TOKENS,
        quantity: -150,
        providerCostUsd: '-0.000200',
        idempotencyKey: 'agree:correction',
        occurredAt: PERIOD,
      });
      expectedTokens -= 150n;
      expectedCost = expectedCost.minus('0.000200');

      const stored = await rollup(ws);
      // Non-vacuous: 13 events, not zero. Without this the comparison below would pass on
      // an empty ledger, which is the exact failure mode this file is written against.
      expect(stored?.eventCount).toBe(13);
      expect(stored?.quantity).toBe(expectedTokens);
      expect(stored?.providerCostUsd.equals(expectedCost)).toBe(true);

      const computed = await computePeriodFromEvents(db, ws, PERIOD);
      const computedAi = computed.find((row) => row.metric === UsageMetric.AI_TOKENS);
      expect(computedAi?.quantity).toBe(expectedTokens);
      expect(computedAi?.providerCostUsd.equals(expectedCost)).toBe(true);
      expect(computedAi?.eventCount).toBe(13);

      /**
       * Now break it on purpose.
       *
       * This is what makes the rebuild assertion mean something. A test that rebuilds an
       * already-correct rollup and finds it correct passes for a `rebuild` that is a
       * no-op. Corrupting the stored row first proves both that the comparison can fail
       * and that the repair is what fixes it.
       */
      await db.$executeRaw`
        UPDATE "usage_period_rollups"
        SET "quantity" = "quantity" * 7 + 13,
            "providerCostUsd" = "providerCostUsd" + 4.2,
            "eventCount" = 999
        WHERE "workspaceId" = ${ws}
          AND "metric" = 'AI_TOKENS'::"UsageMetric"
          AND "periodStart" = ${PERIOD_START.toISOString()}::timestamptz AT TIME ZONE 'UTC'
      `;

      const drifted = await rollup(ws);
      expect(drifted?.quantity).not.toBe(expectedTokens);
      expect(drifted?.providerCostUsd.equals(expectedCost)).toBe(false);
      expect(drifted?.eventCount).toBe(999);

      await rebuildWorkspacePeriod(db, ws, PERIOD);

      const repaired = await rollup(ws);
      expect(repaired?.quantity).toBe(expectedTokens);
      expect(repaired?.providerCostUsd.equals(expectedCost)).toBe(true);
      expect(repaired?.eventCount).toBe(13);

      // And the rebuild must not have touched the ledger it read from.
      expect(await db.usageEvent.count({ where: { workspaceId: ws } })).toBe(13);
    });

    it('zeroes a rollup whose events no longer exist rather than leaving a stale total', async () => {
      const { workspaceId: ws } = await makeWorkspace('orphan');

      await emitUsage(db, {
        workspaceId: ws,
        metric: UsageMetric.RENDITION_RENDERED,
        quantity: 5,
        idempotencyKey: 'orphan:1',
        occurredAt: PERIOD,
      });

      // Not something the app does — the ledger is append-only — but a rollup with no
      // events under it is the state a bad restore or a manual fix leaves behind, and the
      // repair tool has to be able to get out of it.
      await db.usageEvent.deleteMany({ where: { workspaceId: ws } });
      await rebuildWorkspacePeriod(db, ws, PERIOD);

      const row = await rollup(ws, UsageMetric.RENDITION_RENDERED);
      expect(row?.quantity).toBe(0n);
      expect(row?.eventCount).toBe(0);
      expect(row?.providerCostUsd.toString()).toBe('0');
    });
  });

  describe('the AI spend fuse', () => {
    it('refuses generation over the ceiling and allows it under', async () => {
      const { workspaceId: ws } = await makeWorkspace('fuse', '1.00');

      // Under the ceiling: must resolve, and must report the spend it read.
      await emitUsage(db, {
        workspaceId: ws,
        metric: UsageMetric.AI_TOKENS,
        quantity: 1_000,
        providerCostUsd: '0.400000',
        idempotencyKey: 'fuse:under',
        occurredAt: PERIOD,
      });

      const under = await assertAiBudgetAvailable(db, ws, PERIOD);
      expect(under.exhausted).toBe(false);
      expect(under.spentUsd.toString()).toBe('0.4');
      expect(under.remainingUsd.toString()).toBe('0.6');

      // Over it: must throw, and must throw the *specific* error, because "exhausted" has
      // to be distinguishable from "the provider failed".
      await emitUsage(db, {
        workspaceId: ws,
        metric: UsageMetric.AI_TOKENS,
        quantity: 2_000,
        providerCostUsd: '0.700000',
        idempotencyKey: 'fuse:over',
        occurredAt: PERIOD,
      });

      const error = await assertAiBudgetAvailable(db, ws, PERIOD).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BudgetExceededError);
      expect((error as BudgetExceededError).status).toBe(402);
      expect((error as BudgetExceededError).code).toBe('BUDGET_EXCEEDED');
      expect((error as BudgetExceededError).spentUsd.toString()).toBe('1.1');
      expect((error as BudgetExceededError).ceilingUsd.toString()).toBe('1');
    });

    it('treats an unset ceiling as the configured default, not as unlimited', async () => {
      const { workspaceId: ws } = await makeWorkspace('default-ceiling');

      const status = await getAiBudgetStatus(db, ws, PERIOD);
      // AI_MONTHLY_CEILING_USD's default. The failure this guards is a null column
      // resolving to Infinity, which is the kind of default discovered from an invoice.
      expect(status.ceilingUsd.toString()).toBe('25');
      expect(status.exhausted).toBe(false);

      await emitUsage(db, {
        workspaceId: ws,
        metric: UsageMetric.AI_TOKENS,
        quantity: 1,
        providerCostUsd: '25.000001',
        idempotencyKey: 'default:over',
        occurredAt: PERIOD,
      });

      await expect(assertAiBudgetAvailable(db, ws, PERIOD)).rejects.toBeInstanceOf(
        BudgetExceededError,
      );
    });

    it('counts only the current period against the ceiling', async () => {
      const { workspaceId: ws } = await makeWorkspace('period-boundary', '1.00');

      // Last month's spend, well over the ceiling.
      await emitUsage(db, {
        workspaceId: ws,
        metric: UsageMetric.AI_TOKENS,
        quantity: 10,
        providerCostUsd: '9.000000',
        idempotencyKey: 'boundary:previous',
        occurredAt: new Date('2031-04-28T00:00:00.000Z'),
      });

      // A monthly ceiling that never resets is a ceiling that eventually stops everyone.
      await expect(assertAiBudgetAvailable(db, ws, PERIOD)).resolves.toMatchObject({
        exhausted: false,
      });
      await expect(
        assertAiBudgetAvailable(db, ws, new Date('2031-04-29T00:00:00.000Z')),
      ).rejects.toBeInstanceOf(BudgetExceededError);
    });

    it('does not stop a publish for an exhausted workspace', async () => {
      const { workspaceId: ws } = await makeWorkspace('publish-over-ceiling', '0.01');

      await emitUsage(db, {
        workspaceId: ws,
        metric: UsageMetric.AI_TOKENS,
        quantity: 5_000,
        providerCostUsd: '5.000000',
        idempotencyKey: 'exhausted:ai',
        occurredAt: PERIOD,
      });
      await expect(assertAiBudgetAvailable(db, ws, PERIOD)).rejects.toBeInstanceOf(
        BudgetExceededError,
      );

      /**
       * The cap governs generation, not delivery.
       *
       * W6 does not exist yet, so this asserts the seam rather than an end-to-end publish:
       * metering a `POST_PUBLISHED` for an exhausted workspace must succeed, and
       * `emitUsage` must not consult the budget. If a future change makes emit
       * budget-aware, this test fails — which is the point.
       */
      const published = await emitUsage(db, {
        workspaceId: ws,
        metric: UsageMetric.POST_PUBLISHED,
        quantity: 1,
        idempotencyKey: 'publish:target-over-ceiling',
        occurredAt: PERIOD,
      });

      expect(published.recorded).toBe(true);
      expect((await rollup(ws, UsageMetric.POST_PUBLISHED))?.quantity).toBe(1n);
    });
  });

  describe('tenancy', () => {
    it('hides one workspace’s usage from another workspace’s scoped client', async () => {
      const mine = await makeWorkspace('tenancy-mine');
      const theirs = await makeWorkspace('tenancy-theirs');

      for (const ws of [mine.workspaceId, theirs.workspaceId]) {
        await emitUsage(db, {
          workspaceId: ws,
          metric: UsageMetric.AI_TOKENS,
          quantity: 10,
          providerCostUsd: '0.01',
          idempotencyKey: `tenancy:${ws}`,
          occurredAt: PERIOD,
        });
      }

      const scoped = withTenantScope(db, { kind: 'workspace', workspaceId: mine.workspaceId });

      const events = await scoped.usageEvent.findMany({ select: { workspaceId: true } });
      expect(events.length).toBeGreaterThan(0);
      expect(events.every((e) => e.workspaceId === mine.workspaceId)).toBe(true);

      const rollups = await scoped.usagePeriodRollup.findMany({ select: { workspaceId: true } });
      expect(rollups.length).toBeGreaterThan(0);
      expect(rollups.every((r) => r.workspaceId === mine.workspaceId)).toBe(true);
    });
  });

  describe('schema guarantees', () => {
    it('stores money as numeric, never as a float', async () => {
      const columns = await db.$queryRaw<{ table_name: string; data_type: string }[]>`
        SELECT table_name, data_type
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND (
            (table_name = 'usage_events' AND column_name = 'providerCostUsd')
            OR (table_name = 'usage_period_rollups' AND column_name = 'providerCostUsd')
            OR (table_name = 'workspaces' AND column_name = 'aiMonthlyCeilingUsd')
          )
      `;

      expect(columns).toHaveLength(3);
      for (const column of columns) {
        expect(column.data_type, column.table_name).toBe('numeric');
      }
    });

    it('keeps the ledger row when the AI generation it cites is deleted', async () => {
      const { workspaceId: ws } = await makeWorkspace('fk-setnull');
      const brand = await db.brand.findFirstOrThrow({ select: { id: true } });

      const generation = await db.aiGeneration.create({
        data: {
          brandId: brand.id,
          purpose: 'voice_guide_draft',
          provider: 'openai',
          model: 'gpt-4o-mini',
          prompt: 'test',
          response: '{}',
        },
        select: { id: true },
      });

      await emitUsage(db, {
        workspaceId: ws,
        metric: UsageMetric.AI_TOKENS,
        quantity: 42,
        providerCostUsd: '0.0001',
        idempotencyKey: `ai:${generation.id}`,
        occurredAt: PERIOD,
        aiGenerationId: generation.id,
      });

      await db.aiGeneration.delete({ where: { id: generation.id } });

      // The charge outlives the telemetry. Cascade here would let a cleanup job quietly
      // delete billing history.
      const event = await db.usageEvent.findFirstOrThrow({ where: { workspaceId: ws } });
      expect(event.aiGenerationId).toBeNull();
      expect(event.quantity).toBe(42);
    });

    it('has the reserved platform workspace, at the id the code expects', async () => {
      const workspace = await db.workspace.findUnique({
        where: { slug: PLATFORM_WORKSPACE_SLUG },
        select: { id: true },
      });

      // Created by migration 0002 rather than by the seed, because production never runs
      // the seed and trend classification cannot be metered without it.
      expect(workspace?.id).toBe(PLATFORM_WORKSPACE_ID);
      // And the constant has to agree with the seed's derivation, or the seed would create
      // a second one.
      expect(PLATFORM_WORKSPACE_ID).toBe(seedId('workspace', PLATFORM_WORKSPACE_SLUG));
      expect(workspace?.id).not.toBe(workspaceId('rise-and-shore'));
    });
  });
});
