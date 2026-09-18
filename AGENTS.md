# AGENTS.md

Guidance for AI agents and engineers working in this repository.

## Read this first

**The repo is mid-reset.** The code currently on `main` implements the *old* product — a
prompt→AI→post tool. It is being replaced. Do not treat existing code as a pattern to
follow.

The plan lives in [`docs/`](./docs/). Start at [`docs/README.md`](./docs/README.md).

If you have been handed a workstream (W0–W9), your brief is in
[`docs/tasks/`](./docs/tasks/). Read it and the docs it lists under **Read first** before
writing code.

## What we're building

Buzzalicious is a content platform for small business owners and marketers. The v1 wedge
is template- and trend-driven quick content creation, differentiated by **industry-specific
relevance** and an **outcome-based feedback loop** (clicks, saves, leads — not raw
engagement).

Full context: [`docs/00-product-vision.md`](./docs/00-product-vision.md).

## Locked decisions

Recorded as ADRs in [`docs/adr/`](./docs/adr/). **Do not relitigate without updating the
ADR.**

- Clean foundation reset; the old schema and app structure are being replaced
- Templates render HTML/CSS → Satori → resvg → PNG, server-side
- Express API + Vite React SPA, single deployable
- pg-boss on Postgres for jobs — no Redis
- v1 publishing: Instagram, Facebook, Threads, X
- First-party short-link tracking is P0
- In-house trend engine
- `Brand` is first-class in the schema
- **Clients bring their own platform app credentials** (`DIRECT_TOKEN` for day-one
  migration, `CLIENT_APP` for durable OAuth) — every `PlatformAdapter` method takes a
  resolved credential, never reads env
- **Each client is a `Workspace`**; trends and templates are shared platform-wide
- **Hosting is Heroku** — ephemeral filesystem, worker dyno must not sleep

## Existing production code to port

Rise & Shore (`../sc-rental-monitor`) and Tax Dedux (`../tax-agent`) are **live systems
already posting to all four v1 platforms.** Read
[`docs/11-source-material.md`](./docs/11-source-material.md) before building any platform
integration — much of W6 is a port, not a rewrite.

**Never modify those repos from a Buzzalicious session**, and never copy a credential value
out of them.

## Working rules

1. **Stay inside your workstream's `Files you own`.** If you need to change a file another
   workstream owns, stop and flag it.
2. **`backend/prisma/schema.prisma` is owned by W2 only.** Never edit it from two sessions.
3. **Update the relevant doc in the same PR as the code.** The docs are the contract
   between workstreams. A deviation is fine; a silent deviation is not.
4. **Tests are part of done**, not a follow-up. Read
   [`docs/12-testing.md`](./docs/12-testing.md) before writing them — in particular *the
   four ways a test passes for the wrong reason*, which is the dominant defect class on
   this project and was found repeatedly in work that was already green.
5. **Never commit secrets.** Add new env vars to `.env.example` with a description and no
   value. Client platform app secrets live encrypted in the database and are **never**
   logged, returned by an API, or placed in a job payload — see
   [`docs/10-credentials-and-security.md`](./docs/10-credentials-and-security.md).
6. **Don't invent success-metric targets.** The spec is explicit: establish a baseline from
   real users first.
7. **Verify platform API details against current official docs.** The integration docs
   deliberately avoid pinning volatile specifics like pricing tiers and permission names.

## Anchoring principles

Use these as tiebreakers when a design choice is close:

- **One pipeline, not a shelf of switches.** Every feature must remove a tool someone
  currently uses.
- **Analytics are core, not optional.** Every published post gets tracked and fed back into
  what's recommended next.
- **Native quality per platform.** A TikTok export is not a resized LinkedIn post.
- **Fast enough to protect the loop.** Idea → published is itself a core metric.
- **Joy is a feature.** Personality and easter eggs, not sterile enterprise tooling.
- **Ship the wedge before the whole vision.**

## Repo layout (target state)

```
backend/src/
  http/           # Express wiring only — routers, middleware, request/response mapping
  modules/        # One folder per bounded context; business logic lives here
  jobs/           # pg-boss registration, handlers, cron definitions
  platform/       # config, logger, db, storage, crypto, errors
frontend/src/
  routes/         # React Router route components
  components/
  lib/            # typed API client, query hooks
docs/             # plans, architecture, ADRs, task briefs
```

**Layering rule:** `http/` may import from `modules/`. `modules/` must never import from
`http/`. Modules talk to each other through exported service functions, never by reaching
into another module's Prisma queries.

## Commands

```bash
npm run dev          # frontend + backend
npm run build        # both workspaces
npm run lint         # both workspaces
npm run format       # Prettier, writing
npm run type-check   # both workspaces
npm test             # Vitest, both workspaces
```

All four of `lint`, `type-check`, `test` and `build` must pass before anything merges. CI
runs them on every pull request. `npm test` passes on a clean clone with no database and
no credentials — see [`docs/12-testing.md`](./docs/12-testing.md).

## Current state

**Phase 1 is complete. All eleven workstreams (W0–W10) have merged.** The suite is
**1236 tests across 99 files**, and all four gates — `lint`, `type-check`, `test`, `build`
— pass on `main`.

What exists: the platform layer; the schema and four migrations (`0001_init` through
`0004_outcome_attribution`); brands, templates and rendering; publishing to all four v1
platforms with client-supplied credentials; the trend engine; the outcome spine (tracked
links, click ingest, metric snapshots, outcome scoring, insights); and the feedback loop
(per-brand normalisation, shrinkage, recommendations, exploration, send-time and cadence).

The M6 exit condition is met and pinned by `backend/tests/db/recommend.test.ts`: Rise &
Shore, Tax Dedux and a cold-start brand in the same category get genuinely different
recommendations.

**Before changing the scoring or recommendation code, read the three documented biases in
[`docs/06`](./docs/06-outcome-and-feedback-loop.md).** They share one root cause and are
recorded as *known bias, floor in place, correction deferred* — not as solved. The Borda
correction is written down and deliberately out of v1.

See [`docs/04-phase-1-roadmap.md`](./docs/04-phase-1-roadmap.md) for the dependency graph
and milestones, and [`docs/09-open-questions.md`](./docs/09-open-questions.md) for what's
still unresolved.
