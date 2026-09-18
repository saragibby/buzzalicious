# ADR-0001 — Clean foundation reset

**Date:** 2026-09-17 · **Status:** Accepted

## Context

The existing prototype is a prompt→AI→post tool: free-prompt generation, X/LinkedIn
posting, Canva OAuth, an in-process `setInterval` scheduler, and an "Analytics" view that
reports AI token cost rather than post performance.

The new direction is a template- and trend-driven content platform with brand kits,
category relevance, and an outcome feedback loop. The existing schema actively fights it:
OAuth tokens are columns on `User` (so one account per platform per person, with no way to
express "TaxDedux's Instagram"), `Template` is a `{name, purpose}` stub, and post history
lives inside `GenerationRequest` with parallel boolean/ID column pairs per network.

No production data and no real users exist.

## Options

1. **Incremental refactor** — keep the app running, evolve feature by feature.
2. **Clean foundation reset** — new schema and app structure in the same repo; port only
   what's genuinely reusable.
3. **True greenfield** — new repo, keep nothing.

## Decision

**Option 2.** New Prisma schema and module structure. Port the AI provider abstraction
(`services/ai/*`) and the X publisher client. Park LinkedIn for P1. Delete Canva, the
free-prompt generator, the cost-metrics "Analytics" view, and the `setInterval` scheduler.

Keep the repo, git history, and the Buzzalicious name.

## Rationale

- With no data to preserve, the usual argument for incremental refactor disappears.
- The domain model change is total — `Brand`, `Template`, `Post`/`PostTarget`, `Trend`,
  and metrics have no counterpart in the current schema. Incremental migration would mean
  maintaining two models simultaneously for no benefit.
- Greenfield discards genuinely valuable prior art: working OAuth flows, a clean AI
  provider interface, deployment lessons visible in git history.
- Keeping git history preserves the integration knowledge that was expensive to acquire.

## Consequences

- Dev and prod databases are dropped and recreated; all 14 migrations collapse to one.
- A harvest step must precede deletion ([03](../03-teardown.md)), capturing OAuth
  sequences and platform quirks into `docs/reference/`.
- The app will be non-functional between teardown and M1 completion — acceptable given no
  users.
- The AI abstraction needs extending (structured output, a `purpose` concept) rather than
  being ported verbatim.
