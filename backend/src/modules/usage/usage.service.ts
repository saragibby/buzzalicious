import { randomUUID } from 'node:crypto';
import { Prisma, UsageMetric } from '@prisma/client';
import { ValidationError } from '../../platform/errors';
import { periodEndFor, periodStartFor } from './period';

/**
 * The meter. One function, deliberately hard to call wrongly.
 *
 * ADR-0011: `UsageEvent` is append-only and is the table this platform will one day bill
 * from. Everything here exists to make two properties true by construction rather than by
 * convention — because both of them become unfixable once there is history.
 *
 * **1. Emitting twice with the same key records one event.** W6 puts publishing behind
 * pg-boss, and a retried job must not double-count. The key is caller-supplied and
 * *attempt-independent* (`publish:{postTargetId}`), so a caller may emit without knowing
 * whether it is a retry.
 *
 * **2. The rollup cannot drift from the ledger.** It advances only when a row was actually
 * inserted, by an amount read from the same input, inside the caller's transaction.
 */

/**
 * The minimum a client must offer to record usage.
 *
 * Structural on purpose: it is satisfied by the application client, by a `ScopedDb`, and —
 * the point of the exercise — by a `$transaction` callback client, so an event can be
 * written in the same transaction as the work it meters. An event recorded for work that
 * rolled back is a charge for nothing.
 */
export interface UsageWriter {
  usageEvent: {
    createMany(args: {
      data: Prisma.UsageEventCreateManyInput[];
      skipDuplicates?: boolean;
    }): Promise<{ count: number }>;
  };
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
}

export interface EmitUsageInput {
  workspaceId: string;
  brandId?: string | null;
  metric: UsageMetric;
  /**
   * Integer, in the metric's own unit. May be negative: the only way to correct an
   * append-only ledger is a compensating event, so the meter has to be able to express
   * one. It is never money — that is `providerCostUsd`.
   */
  quantity: number;
  /** What the vendor charged us. `Decimal` or a decimal string; never a number. */
  providerCostUsd?: Prisma.Decimal | string | null;
  /** Attempt-independent natural key. See the note on `assertAttemptIndependent`. */
  idempotencyKey: string;
  occurredAt?: Date;
  aiGenerationId?: string | null;
  postTargetId?: string | null;
  renditionId?: string | null;
  metadata?: Prisma.InputJsonValue | null;
}

export interface EmitUsageResult {
  /** False when the key had already been recorded — a retry, not a second charge. */
  recorded: boolean;
  eventId: string;
  periodStart: Date;
}

/**
 * Keys that encode an attempt number are the documented way to get double billing.
 *
 * Narrow by design: it rejects `…:attempt-2` / `…retry3`, which is the mistake ADR-0011
 * names, and says nothing about keys that merely contain the word. A guard that fired on
 * anything vaguely retry-shaped would get worked around, and a worked-around guard is
 * worse than none.
 */
function assertAttemptIndependent(key: string): void {
  if (/(attempt|retry)[\s:_-]?\d+$/i.test(key)) {
    throw new ValidationError(
      `Usage idempotency key "${key}" looks attempt-scoped. Keys must be ` +
        `attempt-independent — "publish:{postTargetId}", never ` +
        `"publish:{postTargetId}:attempt-2" — or a post published after three retries ` +
        `is billed three times.`,
    );
  }
}

function toDecimal(value: Prisma.Decimal | string | null | undefined): Prisma.Decimal {
  if (value === null || value === undefined) return new Prisma.Decimal(0);
  return value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value);
}

/**
 * Record one usage event and advance its period rollup.
 *
 * Safe to call twice with the same key, and safe to call inside a transaction.
 */
export async function emitUsage(
  writer: UsageWriter,
  input: EmitUsageInput,
): Promise<EmitUsageResult> {
  if (!Number.isInteger(input.quantity)) {
    throw new ValidationError(
      `Usage quantity must be an integer in the metric's own unit; got ${input.quantity}.`,
    );
  }
  if (!input.idempotencyKey.trim()) {
    throw new ValidationError('Usage events require an idempotency key.');
  }
  assertAttemptIndependent(input.idempotencyKey);

  const occurredAt = input.occurredAt ?? new Date();
  const periodStart = periodStartFor(occurredAt);
  const periodEnd = periodEndFor(occurredAt);
  const cost = toDecimal(input.providerCostUsd);
  const eventId = randomUUID();

  /**
   * `createMany({ skipDuplicates: true })`, not `create` in a try/catch.
   *
   * It compiles to `ON CONFLICT DO NOTHING` and reports whether a row was inserted, in one
   * statement. Catching `P2002` instead would be worse in the case this function exists
   * for: inside a transaction, a unique violation aborts the whole transaction in
   * Postgres, so the "harmless duplicate" would take the metered work down with it.
   */
  const { count } = await writer.usageEvent.createMany({
    data: [
      {
        id: eventId,
        workspaceId: input.workspaceId,
        brandId: input.brandId ?? null,
        metric: input.metric,
        quantity: input.quantity,
        providerCostUsd: input.providerCostUsd === undefined ? null : cost,
        idempotencyKey: input.idempotencyKey,
        occurredAt,
        periodStart,
        aiGenerationId: input.aiGenerationId ?? null,
        postTargetId: input.postTargetId ?? null,
        renditionId: input.renditionId ?? null,
        ...(input.metadata === null || input.metadata === undefined
          ? {}
          : { metadata: input.metadata }),
      },
    ],
    skipDuplicates: true,
  });

  if (count === 1) {
    await applyRollupDelta(writer, {
      workspaceId: input.workspaceId,
      metric: input.metric,
      periodStart,
      periodEnd,
      quantity: input.quantity,
      providerCostUsd: cost,
      eventCount: 1,
    });
  }

  return { recorded: count === 1, eventId, periodStart };
}

export interface RollupDelta {
  workspaceId: string;
  metric: UsageMetric;
  periodStart: Date;
  periodEnd: Date;
  quantity: number;
  providerCostUsd: Prisma.Decimal;
  eventCount: number;
}

/**
 * Add a delta to one rollup row, creating it if it does not exist.
 *
 * Raw `INSERT … ON CONFLICT DO UPDATE` rather than `prisma.upsert`, because Prisma's upsert
 * is read-then-write: two concurrent emits both read the same total and the second
 * overwrites the first's increment. A silently lost increment in a billing counter is
 * exactly the failure this whole module is built to prevent, and it only shows up under
 * the concurrency that production has and a test rarely does.
 *
 * **Timestamps are bound as UTC text, not as `Date`.** `periodStart` is
 * `timestamp without time zone`, and a raw-bound `Date` is serialized in the *process's*
 * local zone — so on a machine in New York the rollup landed at `2031-04-30 20:00` while
 * the ledger rows Prisma wrote sat at `2031-05-01 00:00`, and every subsequent lookup
 * missed. The two paths silently disagreed about which month an event belonged to,
 * invisibly on a UTC host such as CI and reproducibly everywhere else.
 */
export async function applyRollupDelta(writer: UsageWriter, delta: RollupDelta): Promise<void> {
  const periodStart = delta.periodStart.toISOString();
  const periodEnd = delta.periodEnd.toISOString();

  await writer.$executeRaw`
    INSERT INTO "usage_period_rollups" (
      "id", "workspaceId", "metric", "periodStart", "periodEnd",
      "quantity", "providerCostUsd", "eventCount", "updatedAt"
    )
    VALUES (
      ${randomUUID()}, ${delta.workspaceId}, ${delta.metric}::"UsageMetric",
      ${periodStart}::timestamptz AT TIME ZONE 'UTC',
      ${periodEnd}::timestamptz AT TIME ZONE 'UTC',
      ${delta.quantity}::bigint, ${delta.providerCostUsd.toString()}::numeric,
      ${delta.eventCount}, NOW()
    )
    ON CONFLICT ("workspaceId", "metric", "periodStart") DO UPDATE SET
      "quantity" = "usage_period_rollups"."quantity" + EXCLUDED."quantity",
      "providerCostUsd" = "usage_period_rollups"."providerCostUsd" + EXCLUDED."providerCostUsd",
      "eventCount" = "usage_period_rollups"."eventCount" + EXCLUDED."eventCount",
      "updatedAt" = NOW()
  `;
}
