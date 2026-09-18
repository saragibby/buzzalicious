# W10 — Usage metering spine & AI spend fuse

**Depends on:** W2, W3 · **Blocks:** W6 (soft — see below) · **Parallel with:** W4, W5

**Read first:** [ADR-0011](../adr/0011-usage-metering-spine.md),
[Q20](../09-open-questions.md#q20--ai-provider-and-spend-controls--resolved-meter-now-cap-as-a-fuse),
[Q13](../09-open-questions.md#q13--pricing-model)

> ## ⚠️ This brief owns `schema.prisma`
> The ground rule in [README](./README.md) is that **W2 owns `schema.prisma`**. W2 is
> merged and complete, so W10 takes ownership for this migration. While W10 is open, **no
> other session may edit `schema.prisma`.** Confirm with the coordinating session before
> starting if another schema-touching workstream is in flight.

> **Sequence before W6.** Not a hard dependency — W6 compiles fine without this — but if
> W6 ships publishing first, every emit call is a retrofit through code that already has
> retry semantics. Landing W10 first means `POST_PUBLISHED` is emitted correctly the first
> time.

## Goal

An append-only usage meter for the whole platform, and a per-workspace AI cost ceiling
enforced against it. Billing-grade **data**, deliberately crude **enforcement**.

Not in scope: plans, tiers, prices, invoices, overage, proration, or any UI for them.
Those need [Q13](../09-open-questions.md#q13--pricing-model).

## Build order

1. **Schema.** `UsageEvent`, `UsagePeriodRollup`, `UsageMetric` enum, and an AI ceiling
   column on `Workspace`. One migration. Follow W2's conventions — snake_case table names
   via `@@map`, camelCase columns.
2. **Emit API.** One function, hard to call wrongly. It must be safe to call from inside a
   transaction and safe to call twice with the same key.
3. **Rollups.** Incremental update on emit, plus a `rebuild` path that recomputes a period
   from raw events.
4. **The fuse.** Check-before / record-after around AI calls, `BudgetExceededError`, and
   the `classifyWithLlm` rethrow fix.
5. **Backfill the two live call sites** — `voice.service.ts` (W3) and
   `mapping.service.ts` (W9) — to write `AiGeneration` *and* emit usage.
6. **Provider usage capture.** OpenAI already reads `prompt_tokens` and discards it; Gemini
   captures nothing. Both must return token counts and a provider cost.
7. **Admin read-only view** of current-period usage per workspace. Minimal — a table is
   fine. This is how you'll sanity-check the meter before trusting it for pricing.

## Data model notes

**`UsageEvent` is append-only.** No updates, no deletes. If something is recorded wrongly,
record a compensating event. This is the table you will one day bill from, and a mutable
billing ledger is not a ledger.

- `idempotencyKey` is unique and **attempt-independent**. `publish:{postTargetId}`, not
  `publish:{postTargetId}:{attempt}`. A post published after three retries is one billable
  post. Emitting must be safe for a caller that does not know it is a retry.
- `quantity` is an integer in the metric's own unit. `providerCostUsd` is `Decimal`, never
  `Float`, and records what the vendor charged **us** — not what a customer would be
  charged. Keep them separate or per-tier margin is invisible later.
- `workspaceId` is required; `brandId` is optional. Workspace is the client and therefore
  the billing entity ([ADR-0010](../adr/0010-workspace-per-client.md)).
- Link the source record (`AiGeneration`, `PostTarget`, `Rendition`) so any charge can be
  traced back to the thing that caused it. "Why is this invoice $340" must be answerable.

**`UsagePeriodRollup` is derived.** It exists so a cap check is one indexed read instead of
an aggregate over the ledger. It must be reconstructible from events at any time — see the
acceptance criteria.

**`AiGeneration` stays telemetry.** Do not repurpose it as the counter. Its `estimatedCost`
is a `Float` and must never feed billing arithmetic; leave the column alone and treat
`UsageEvent.providerCostUsd` as authoritative.

## The fuse

- Ceiling is per workspace, defaulting from config, overridable per workspace.
- Check the rollup **before** the call; record actuals **after**.
- A single call may overshoot the ceiling. Accepted — `maxTokens` bounds it. Do not build
  pre-flight token estimation.
- At the cap: refuse generation with `BudgetExceededError`. **Never block publishing of an
  already-scheduled post.** The cap governs generation, not delivery.

### The one thing that must not be got wrong

`trend/mapping/mapping.service.ts#classifyWithLlm` catches every error and degrades to a
log line, by design — [07](../07-trend-engine.md) requires a failing source to degrade the
feed rather than break a curation run. That is right for an outage and wrong for a budget
cap: without a change, hitting the ceiling produces a quietly worse feed and no signal
whatsoever, forever.

**`BudgetExceededError` must be rethrown, not swallowed.** W10 is authorised to make this
one edit inside W9's module. Keep the degradation behaviour for every other error.

Exhaustion must be distinguishable from failure in logs, in the API response, and in the
admin view. A cap that engages invisibly is worse than no cap, because you will debug the
symptom for a week.

## Files you own

- `backend/prisma/schema.prisma` *(exclusive — see the warning above)* and its migration
- `backend/src/modules/usage/**` — the new module
- `backend/src/modules/ai/**` — provider usage capture, the fuse wrapper
- `backend/src/platform/config.ts` — ceiling defaults
- `backend/prisma/seed/**` — seed some usage history (see below)
- Narrow, authorised edits: `modules/brand/voice.service.ts`,
  `modules/trend/mapping/mapping.service.ts` — emit calls and the rethrow, nothing else

## Seed

Seed usage history for both workspaces across the same 12-month window W2 established, so
the admin view and any future pricing analysis have something real to run against. Make the
two workspaces **materially different** in shape — one AI-heavy, one publish-heavy — since
identical tenants hide exactly the bugs a meter has.

Seed at least one workspace **over** its ceiling so the refusal path is reachable in
development without waiting for real spend.

## Acceptance criteria

- [ ] `UsageEvent`, `UsagePeriodRollup`, `UsageMetric` exist; one migration; `migrate diff`
      clean
- [ ] Emitting the same `idempotencyKey` twice records **one** event and does not corrupt
      the rollup — tested explicitly, since this is what retries will do in production
- [ ] **Rebuilding a period's rollup from raw events reproduces the incrementally
      maintained totals exactly** — a drifted rollup is a billing error, so this is a test,
      not a convention
- [ ] `AiGeneration` rows are written by both live call sites, with token counts populated
- [ ] OpenAI token usage is persisted rather than discarded; Gemini captures usage at all
- [ ] Monetary columns are `Decimal`; no `Float` anywhere in billing arithmetic
- [ ] Exceeding the ceiling raises `BudgetExceededError` and refuses generation
- [ ] `classifyWithLlm` **rethrows** `BudgetExceededError` while still degrading on other
      errors — one test for each half
- [ ] A scheduled post still publishes when its workspace is over the AI ceiling
- [ ] Admin view shows current-period usage and cost per workspace
- [ ] Seed produces two materially different usage profiles, one over its ceiling
- [ ] `docs/09-open-questions.md` Q20 updated to resolved, linking ADR-0011
- [ ] Q13 updated to record which metrics are now available to price from
- [ ] All gates green: `lint`, `format:check`, `type-check`, `test`, `build`

## Notes for whoever picks this up

- `db.ts` exports `type Db`, not `PrismaClient` — `$extends` changes the client type, and
  anything typed `PrismaClient` silently loses the encryption extension.
- Tenancy comes from W3: services take `ScopedDb`, never `Db` and never `PrismaClient`.
  Usage reads must be workspace-scoped like everything else.
- Emit inside the same transaction as the thing being metered where you can. An event
  recorded for work that rolled back is a charge for nothing.
- Don't invent prices. No tier values, no dollar figures beyond a conservative default
  ceiling — Q13 is open and this brief does not resolve it.
