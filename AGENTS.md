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
4. **Tests are part of done**, not a follow-up.
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
npm run type-check   # both workspaces
npm test             # Vitest (added in W0)
```

> Note: `lint` currently fails — no ESLint config file exists. W0 fixes this.

## Current state

Nothing from the plan is implemented yet. Phase 1 starts with W0 (foundation) and W1
(teardown), which must merge before any other workstream begins.

See [`docs/04-phase-1-roadmap.md`](./docs/04-phase-1-roadmap.md) for the dependency graph
and milestones, and [`docs/09-open-questions.md`](./docs/09-open-questions.md) for what's
still unresolved.
