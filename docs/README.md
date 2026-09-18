# Buzzalicious — planning & architecture docs

> **Status:** planning complete, implementation not started.
> **Last updated:** 2026-09-17

This directory is the single source of truth for the Buzzalicious platform reset. The
product spec lives in a [Google Doc][spec]; these docs translate it into architecture,
a data model, and an executable phase-1 plan.

[spec]: https://docs.google.com/document/d/1T-bHH5_KSHjIPfKssy5-HdeO76QIfRGxVKHrYh52J18/edit

## Read this first

If you are an agent or engineer picking up work here, read in this order:

| # | Doc | What it answers |
|---|-----|-----------------|
| 00 | [Product vision](./00-product-vision.md) | What we're building, for whom, and why it wins |
| 01 | [Architecture](./01-architecture.md) | System shape, stack, and why each piece was chosen |
| 02 | [Data model](./02-data-model.md) | The new domain model and Prisma schema design |
| 03 | [Teardown plan](./03-teardown.md) | What in the current repo dies, what gets ported |
| 04 | [Phase 1 roadmap](./04-phase-1-roadmap.md) | Workstreams, dependency graph, sequencing |
| 05 | [Template engine](./05-template-engine.md) | How a template becomes a platform-native image |
| 06 | [Outcome & feedback loop](./06-outcome-and-feedback-loop.md) | Analytics spine and recommendation logic |
| 07 | [Trend engine](./07-trend-engine.md) | In-house trend detection design |
| 08 | [Platform integrations](./08-platform-integrations.md) | Meta/X publishing and the adapter interface |
| 09 | [Open questions](./09-open-questions.md) | Unresolved decisions, with owners |
| 10 | [Credentials & security](./10-credentials-and-security.md) | How client platform credentials are held and used |
| 11 | [Source material](./11-source-material.md) | What to port from Rise & Shore and Tax Dedux |
| 12 | [Testing](./12-testing.md) | How to run and write tests, including DB-backed ones |

Decision records live in [`adr/`](./adr/). Agent-ready task briefs live in
[`tasks/`](./tasks/). Knowledge harvested from the deleted prototype — OAuth sequencing,
platform quirks, redirect handling — lives in [`reference/`](./reference/README.md) and is
clearly marked as dead code.

## The one-paragraph version

Buzzalicious is a content platform for small business owners and marketers. The v1 wedge
is **template- and trend-driven quick content creation**. Two things make it different
from Predis.ai, SocialBee, and the rest of a crowded field: **industry-specific
relevance** (templates ranked against a real business-category taxonomy, not just brand
colors) and an **outcome-based feedback loop** (optimizing toward clicks, saves, and
leads rather than raw engagement). Rise & Shore and TaxDedux are the first two accounts
and the dogfooding surface.

## Decisions already locked

These were settled during planning on 2026-09-17 and are recorded as ADRs. Do not
relitigate them without updating the ADR.

| Decision | Choice | ADR |
|----------|--------|-----|
| Teardown scope | Clean foundation reset; port AI abstraction + publisher clients only | [0001](./adr/0001-clean-foundation-reset.md) |
| Template rendering | HTML/CSS → Satori → resvg → PNG, server-side | [0002](./adr/0002-satori-template-rendering.md) |
| Application stack | Express API + Vite React SPA, single deployable | [0003](./adr/0003-stack-express-vite.md) |
| Background jobs | pg-boss on the existing Postgres (no Redis) | [0004](./adr/0004-pg-boss-job-queue.md) |
| v1 publish targets | Instagram, Facebook, Threads, X | [0005](./adr/0005-v1-platform-targets.md) |
| Analytics spine | First-party short-link redirector, P0 | [0006](./adr/0006-first-party-link-tracking.md) |
| Trend data | Build in-house collectors + scoring engine | [0007](./adr/0007-in-house-trend-engine.md) |
| Multi-brand | `Brand` is first-class in the v1 schema | [0008](./adr/0008-brand-first-class.md) |
| Platform credentials | Dual mode; clients bring their own app credentials first | [0009](./adr/0009-byo-platform-credentials.md) |
| Tenancy | Workspace per client; trends + templates shared | [0010](./adr/0010-workspace-per-client.md) |

## Working agreements

- **No production data exists.** The current prototype has no users worth preserving, so
  migrations may be destructive and the schema may be reset from scratch.
- **Nothing here is built yet.** Every doc describes intended state. If you implement
  part of it, update the doc in the same change.
- **Success metrics are deliberately unset.** The spec is explicit: do not invent numeric
  targets before there is a baseline from real users.
