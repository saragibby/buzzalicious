# ADR-0011 — Usage metering spine, with AI spend as a fuse

**Date:** 2026-09-18 · **Status:** Accepted
**Resolves:** [Q20](../09-open-questions.md#q20--ai-provider-and-spend-controls--resolved-meter-now-cap-as-a-fuse) (spend controls)
**Informs, does not resolve:** [Q13](../09-open-questions.md#q13--pricing-model)

## Context

Paid tiers and subscriptions are a stated destination for this platform. Pricing itself is
not decided ([Q13](../09-open-questions.md#q13--pricing-model)), but the decision that
cannot wait is **when metering starts**, because metered history is append-only and cannot
be reconstructed after the fact.

The current state is worse than "not built." It is *nearly* built and inert:

- `AiGeneration` exists in the schema with `promptTokens`, `completionTokens`, and
  `estimatedCost` columns — and **has zero write sites.** No row has ever been created.
- `openai.provider.ts` reads `response.usage?.prompt_tokens` into its return type, where it
  is then discarded.
- `gemini.provider.ts` does not capture usage at all; it only sets `maxOutputTokens`.
- There is no subscription, plan, entitlement, or usage model anywhere in the 22-model
  schema.

Meanwhile two AI call sites are already live on `main`:

| Call site | Shipped by | Shape | Bounded by |
|---|---|---|---|
| `brand/voice.service.ts` | W3 | One call per user action | A human clicking |
| `trend/mapping/mapping.service.ts` | W9 | **One call per trend**, per curation run | Nothing |

The second is the financial exposure. It is automated, it scales with trends × brands, and
`classifyWithLlm` deliberately swallows failures to a log line so that an unreachable model
degrades the feed instead of breaking a curation run. That is correct behaviour for a
provider outage and **actively dangerous for a budget cap**: spend exhaustion would look
identical to a flaky provider, indefinitely.

## Decision

Build **one append-only usage meter for the whole platform now**, and enforce AI spend
against it as a circuit breaker. Defer pricing, plans, and entitlements.

### Three layers, kept separable

| Layer | Status | Rebuildable? | Why the split |
|---|---|---|---|
| **Meter** — `UsageEvent`, append-only | Build now | **No** — this is the source of truth | Cannot be backfilled. Every day without it is a day you cannot price from. |
| **Rollup** — period totals per workspace + metric | Build now | Yes, from events | Makes cap checks and dashboards cheap. Derived, so it can always be recomputed. |
| **Entitlement** — tier limits, plans, billing | **Deferred** | n/a | Needs [Q13](../09-open-questions.md#q13--pricing-model). Only the seam is reserved. |

### The meter is not AI-specific

`AiGeneration` stays exactly what it is: **domain telemetry** for debugging prompts and
responses. It is the wrong shape for billing — it has no workspace, no idempotency key, and
its `estimatedCost` is a `Float`.

Billing quantities live in `UsageEvent`, keyed by workspace and metric, with the
`AiGeneration` row referenced as the source record rather than acting as the counter. The
same table meters posts published, renditions, connected accounts, and trend refreshes, so
that metering a new dimension later is a new enum value and one emit call — not a new
subsystem.

### Two properties that must be designed in, not added later

**1. Idempotency.** W6 introduces pg-boss, and a retried job must not double-count. Every
event carries a caller-supplied natural key with a unique constraint, and the key must be
*attempt-independent*: `publish:{postTargetId}`, never `publish:{postTargetId}:{attempt}`.
A post published after three retries is one billable post. Emitting is therefore
idempotent by construction, and callers may emit without knowing whether they are a retry.

**2. Cost and price are different numbers.** `providerCostUsd` records what the vendor
charged *us*. `quantity` records billable units in the metric's own unit. Collapsing them
makes per-tier margin invisible at exactly the moment tiers are being set. Money is
`Decimal`, never `Float` — `AiGeneration.estimatedCost` remains `Float` and is telemetry
only, never an input to billing arithmetic.

### AI enforcement: a fuse, not an invoice

Per-workspace monthly AI cost ceiling, defaulting from config and overridable per
workspace. Check the rollup before a call; record actuals after. A single call may overshoot
the ceiling — bounded by `maxTokens` — and that is accepted rather than solved with
pre-flight estimation.

At the cap:

- **Refuse new generation** with a distinct `BudgetExceededError`.
- **Never break already-scheduled publishing.** A post that is queued goes out. The cap
  governs generation, not delivery.
- **The error must not be swallowed by degradation handlers.** `classifyWithLlm` currently
  catches everything; it must rethrow `BudgetExceededError` so exhaustion surfaces as
  exhaustion. This is the single most important line in this ADR — get it wrong and the
  cap works perfectly while nobody can tell it engaged.

## Rationale

**Why meter before pricing.** The alternative is to start metering when tiers launch, which
means setting tier limits with no usage distribution to set them from. Guessing tier limits
is how you end up with a free tier that loses money on its heaviest users and a paid tier
nobody needs. The meter is a day of work now and irrecoverable later.

**Why a fuse rather than an accounting system.** Billing-grade enforcement needs Q13
answered: proration, overage, what a "credit" is, what happens mid-cycle on an upgrade.
None of that is decided, and none of it is needed to stop a runaway loop. Recording
billing-grade *data* while enforcing a crude limit gets the irreversible half right and
leaves the reversible half open.

**Why AI is the metric that matters.** [Q13](../09-open-questions.md#q13--pricing-model)
already observes that Satori rendering is nearly free, and floats unlimited-posts
positioning against Predis.ai's post limits. If that positioning holds, AI is the only
genuinely scarce per-tenant resource — so meter everything, price on AI, and note that the
AI cap and the future subscription tier are then *the same mechanism*. That is a strong
argument for building the meter once, properly, rather than shipping an AI-only counter and
rebuilding it when posts and renditions need metering.

## Consequences

- One schema migration adding `UsageEvent`, `UsagePeriodRollup`, and a `UsageMetric` enum,
  plus an AI ceiling on `Workspace`. See the serialization note in
  [W10](../tasks/W10-usage-metering.md).
- Every AI call site gains a check-before / record-after pair. Two exist today; W5 and W6
  will add more, so the emit API must be trivial to call correctly.
- W6 publishing emits `POST_PUBLISHED` from day one rather than being retrofitted — which
  is why W10 sequences before W6.
- Rollups are derived and must be provably reconstructible from events. A drifted rollup
  is a billing error, so "rebuild from events equals incremental totals" is a test, not a
  convention.
- `AiGeneration` finally gets written, which incidentally makes prompt debugging possible.

## Alternatives considered

**Meter into `AiGeneration` and generalize later.** Rejected. It has no workspace column,
no idempotency key, and a `Float` cost. Generalizing it later means a data migration of the
one table whose history you cannot afford to corrupt.

**Full entitlement system now.** Rejected. Requires Q13, and the reversible half of the
problem does not need to be decided under time pressure created by the irreversible half.

**Pre-flight cost estimation to enforce the cap exactly.** Rejected for v1. Token counts
are not reliably knowable before a call, and `maxTokens` already bounds the overshoot to a
rounding error against a monthly ceiling.

**No cap, monitor and alert only.** Rejected. The dangerous call site is automated and its
failures are silent by design; an alert assumes someone is watching at 3am.
