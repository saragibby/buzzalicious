# ADR-0004 — pg-boss for background jobs

**Date:** 2026-09-17 · **Status:** Accepted

## Context

The platform is substantially a background-job system: scheduled publishing, per-platform
publish attempts with retry, metrics polling at 1h/24h/7d after publish, token refresh
sweeps, trend collection crons, and rendering.

The prototype uses `SchedulerService.startScheduler()` — a 60-second `setInterval` that
queries due posts and publishes them inline. It has no locking (two instances would
double-post), no retry, no backoff, no dead-lettering, and hardcoded two-platform
branching.

## Options

1. **BullMQ + Redis** — the common Node choice.
2. **pg-boss** — queues on PostgreSQL.
3. **Provider-managed queue** (SQS, Cloud Tasks).
4. Keep in-process intervals.

## Decision

**pg-boss**, using the PostgreSQL instance the application already requires. It manages its
own schema, isolated from the domain tables.

## Rationale

- **No new infrastructure or bill.** Redis would be an additional managed service and
  connection string for a system with two dogfood accounts.
- **Sufficient feature set:** durable queues, delayed jobs, cron scheduling, retries with
  exponential backoff, concurrency control, dead-letter queues, and job-level uniqueness.
- **Transactional enqueue.** Because jobs live in the same database, enqueueing can join a
  domain transaction — a post and its publish job commit atomically. Redis cannot do this,
  and it directly prevents the "post saved but never published" class of bug.
- Provider-managed queues add vendor lock-in and local-development friction.

## Consequences

- Job throughput is bounded by Postgres. Far beyond phase 1 needs; revisit only if job
  volume starts affecting query performance.
- Queue tables share the database's connection pool — size it accordingly.
- Job handlers must be idempotent. Publishing especially: a retry must never double-post,
  so external post IDs are checked before re-attempting.
- Migrating to Redis later is contained, since handlers are plain functions behind a thin
  registration layer.
