# ADR-0008 — `Brand` is first-class in the v1 schema

**Date:** 2026-09-17 · **Status:** Accepted

## Context

The PRD lists "support for multiple brand profiles under one account" as **P1**, not P0.
But Rise & Shore and TaxDedux are both expected to migrate onto the platform, so two
brands exist from day one of dogfooding.

The prototype has no brand concept at all: OAuth tokens are columns on `User`, so a person
can connect exactly one account per platform.

## Decision

Model `Workspace → Brand` as the tenancy backbone in the initial schema. Every user-owned
row — social accounts, assets, posts, short links, metrics — hangs off a `brandId`.
`Workspace` is the billing/membership boundary; in v1 one is auto-created per user and the
UI may hide it.

The v1 **UI** may ship single-brand. The **schema** does not.

## Rationale

- **Multi-brand is a schema concern, not a UI concern.** Retrofitting a tenant boundary
  after posts, assets, and metrics exist is one of the most expensive migrations a product
  can perform, and it touches every query.
- The two dogfood accounts need it immediately regardless of P1 labeling.
- `Workspace` costs almost nothing now and is required for agency mode (v2). Adding it
  later means the same painful backfill.
- Per-brand social accounts are the only way to express "TaxDedux's Instagram" versus
  "Rise & Shore's Instagram" — a hard blocker for the dogfooding plan.

## Consequences

- Every request-path query filters on `brandId` or `workspaceId`. A query that can't be
  scoped is a design smell.
- Authorization middleware resolves brand scope, not just authentication.
- A brand switcher is likely M3 work rather than P1 ([Q11](../09-open-questions.md)).
- Feedback-loop scoring is naturally per-brand, which is correct — Rise & Shore and
  TaxDedux should get genuinely different recommendations, and that's the demo that proves
  the loop works.
