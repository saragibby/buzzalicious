# `modules/usage/`

**Owner:** W10 · **Status:** spine implemented (ADR-0011)

## Responsibility

Two things, and deliberately not a third:

1. **Know what the platform consumed**, per workspace, in a form that could support billing
   later without a migration or a backfill.
2. **Stop a runaway AI loop from spending unbounded money**, crudely, today.

It is **not** a billing system. There is no plan, no invoice, no proration, no credit and
no overage — all of those need Q13 (pricing) answered, and none of them are needed to stop
a retry storm. Getting the *measurement* right now is what keeps that decision cheap.

## What is here

| File | Role |
| --- | --- |
| `usage.service.ts` | `emitUsage` — the one way anything records usage. Idempotent, transaction-safe. |
| `rollup.ts` | Rebuild the derived rollup from the ledger. The repair tool, and the thing the agreement test asserts. |
| `budget.ts` | The fuse: resolve a ceiling, read current spend, refuse a generation over it. |
| `usage.errors.ts` | `BudgetExceededError` (402) — exhaustion, distinguishable from failure. |
| `period.ts` | UTC calendar-month period math. No local time, ever. |
| `platform-workspace.ts` | The reserved `platform` workspace that carries platform-global AI work. |
| `usage.read.ts` | Read-only summaries for the admin view. Reads the rollup, never the ledger. |
| `usage.access.ts` | `PLATFORM_ADMIN_EMAILS` gate, fail-closed. |
| `usage.schemas.ts` | `UsageEvent.metadata` shape; `YYYY-MM` period keys. |

## Boundaries

- **`UsageEvent` is append-only.** Nothing here updates or deletes one, and nothing should.
  A ledger you can edit is not evidence. Corrections are **compensating events** with a
  negative `quantity` — which is why `quantity` is signed.
- **The rollup is derived and disposable.** `UsagePeriodRollup` exists so a cap check is one
  indexed read instead of an aggregate over the whole ledger. If the two ever disagree, the
  events win and `rebuildWorkspacePeriod` repairs the rollup.
- **Money is `Decimal`, end to end.** `providerCostUsd` is `Decimal(12,6)`; the configured
  ceiling is parsed and carried as a *string* so a float never enters the arithmetic.
  `AiGeneration.estimatedCost` is a `Float` and is telemetry only — it must never be read
  into billing arithmetic.
- **The cap governs generation, not delivery.** Nothing in the publish path calls
  `assertAiBudgetAvailable`. A post that is already scheduled goes out even when its
  workspace is exhausted; refusing to deliver work a user already committed to is a
  different and much worse product decision than refusing to start new work.
- **Idempotency keys are attempt-independent.** `publish:{postTargetId}`, never
  `publish:{postTargetId}:attempt-2`. W6 puts publishing behind pg-boss and a retried job
  must not double-count. `emitUsage` rejects keys that end in an attempt number.
- **Vendor cost, not price.** `modules/ai/pricing.ts` records what a call cost *us*. An
  unpriced model returns `null` and under-reports visibly rather than charging a guessed
  rate.
- **A brand-scoped read sees a smaller total than a workspace-scoped one, on purpose.**
  `UsageEvent.brandId` is nullable, because platform-global work — trend classification,
  billed to the reserved `platform` workspace — belongs to no brand. The tenancy rule for
  `UsageEvent` is `{ brandId }`, so those null-brand rows are invisible under a brand scope.
  That is correct: a brand's usage is the usage attributable to *that brand*. Do not
  "fix" it by loosening the rule to reach the workspace — the workspace-level number is
  what `UsagePeriodRollup` and the budget check already read, and the ceiling is enforced
  per workspace, never per brand.

  Note the related trap. `UsagePeriodRollup` has no `brandId`, so its brand rule reaches
  the workspace *through* the brand relation. An empty fragment there is **not a deny, it
  is no filter** — it ANDs to nothing and hands a brand-scoped client every workspace's
  spend. That exact bug was written and caught during W10; it is pinned by
  `hides another workspace’s rollups from a brand-scoped client` in `tests/db/usage.test.ts`,
  which asserts on *which* workspaces come back rather than on how many.

## Emitting

```ts
await emitUsage(tx, {
  workspaceId,
  brandId,
  metric: UsageMetric.POST_PUBLISHED,
  quantity: 1,
  idempotencyKey: `publish:${postTargetId}`,
  postTargetId,
});
```

Pass the transaction client when the metered work is itself transactional — an event
recorded for work that rolled back is a charge for nothing. Calling twice with the same key
records one event and advances the rollup once.

AI callers do not call `emitUsage` directly. They go through
`modules/ai/metered.ts`, which checks the budget, makes the call, and writes the
`AiGeneration` row and the `AI_TOKENS` event in one transaction.

## Adding a metric

1. Add the value to `UsageMetric` in `schema.prisma` and migrate.
2. Emit it from the one place that knows the work happened, with an attempt-independent key.
3. If it should count against the AI ceiling, add it to `AI_METRICS` in `budget.ts`.
4. Document it in `docs/09-open-questions.md` Q13, which tracks what is being measured
   ahead of what will be charged for.
