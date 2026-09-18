# ADR-0003 — Express API + Vite SPA, single deployable

**Date:** 2026-09-17 · **Status:** Accepted

## Context

The foundation reset is an opportunity to change stacks. The workload is: CPU-bound image
rendering, substantial recurring background work (scheduled publishing, metrics polling,
trend collection), and an authenticated tool UI with no SEO requirement. Cost-effectiveness
was an explicit requirement.

## Options

1. **Keep Express + Vite React SPA** (current stack).
2. **Consolidate into Next.js**, likely on Vercel.
3. Express plus an SPA rebuilt on React Router and a component library.

## Decision

**Option 1, plus option 3's frontend improvements.** Express + TypeScript API serving a
Vite-built React SPA from a single deployable, with React Router and TanStack Query added.
The pg-boss worker starts in-process behind a `WORKER_ENABLED` flag and splits into its
own process when volume requires.

## Rationale

- **Serverless fights this workload.** Execution ceilings conflict with batch rendering;
  Vercel Cron is too thin for trend collection and metrics polling, so a worker host would
  be needed anyway — paying for two platforms instead of one.
- **No SSR benefit.** The product is an authenticated tool. A future marketing site should
  be a separate static site, cheaper than either option.
- **Zero migration cost.** Express and Prisma are already in place and understood.
- **Cost floor.** One small instance plus Postgres, no per-invocation pricing, no idle
  spend.
- The current frontend's real weaknesses — tab-state navigation instead of routing, no
  server-state cache — are additive fixes, not reasons to change frameworks.

## Consequences

- Hosting provider still open ([Q4](../09-open-questions.md)); Render and Fly.io are the
  candidates, with Neon for Postgres.
- Manual responsibility for things a framework would provide: routing conventions, data
  fetching patterns, build config.
- The web/worker split must be designed for from the start (jobs durable in Postgres,
  no in-memory state) even though both run in one process initially.
- A design system decision is still needed ([Q7](../09-open-questions.md)).
