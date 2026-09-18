# ADR-0010 — Clients are workspace tenants; trends and templates are shared

**Date:** 2026-09-17 · **Status:** Accepted
**Refines:** [ADR-0008](./0008-brand-first-class.md)

## Context

[ADR-0008](./0008-brand-first-class.md) established `Workspace → Brand` but left the
question open: are Rise & Shore and TaxDedux two **brands inside Sara's workspace**, or two
**separate workspaces**?

The original spec implied brands under one account. The
[BYO credentials](./0009-byo-platform-credentials.md) framing calls them *clients* — each
with their own platform apps, their own verification, and their own data.

Left unresolved, this blocks W2 seed data and W3 access control, and it is one of the most
expensive things to change after posts and metrics exist.

## Decision

**Each client is a `Workspace`.** Rise & Shore and TaxDedux are separate tenants with
separate experiences: separate brands, credentials, social accounts, posts, assets, short
links, and metrics. A user in one sees nothing of the other.

**Trends and templates are platform-global**, shared across all workspaces:

| Entity | Scope |
|--------|-------|
| `Brand`, `SocialAccount`, `PlatformCredential`, `Asset`, `Post`, `PostTarget`, `Rendition`, `ShortLink`, `LinkClick`, `PostMetric` | Workspace |
| `Template`, `TemplateCategoryTag`, `Trend`, `TrendSignal`, `TrendCategoryScore`, `BusinessCategory` | Global |

`Brand` remains first-class *within* a workspace — a single client may run several brands.

Outcome data is the subtle case. `PostMetric` and `LinkClick` rows are **workspace-owned
and never cross-visible**, but the aggregated template/trend performance scores they feed
are **global**. A client sees only their own numbers; everyone benefits from the pooled
signal.

## Rationale

- **The tenant boundary matches the commercial reality.** These are clients, not projects.
  Billing, membership, offboarding, and credential ownership all key off the workspace.
- **Clean offboarding.** "Delete everything of ours" becomes `DELETE FROM workspaces` and
  cascades, rather than a filtered delete across every table. This is the test that made
  the decision obvious.
- **Credential isolation follows for free.** A client's app secrets belong to exactly one
  workspace, which is also what the per-workspace encryption key in
  [10](../10-credentials-and-security.md) assumes.
- **Sharing trends and templates is the product.** A trend library that only sees one
  client's data is worth far less than one that pools signal across all of them. Template
  performance scoring has the same property — this is the compounding advantage, and
  partitioning it per tenant would destroy it.
- **The template library becomes an asset, not a cost.** Authoring 8–12 seed templates is
  expensive once and free thereafter.

## Consequences

- **Every workspace-scoped query must be scoped, and that must be enforced, not
  remembered.** A missing `workspaceId` filter is a cross-tenant data leak. Prefer a
  mechanism that fails closed — a scoped Prisma client extension or a `requireWorkspace`
  middleware that every route uses — over developer discipline.
- Authorization is two-level: workspace membership, then brand access within it.
- **Aggregation jobs cross the tenant boundary by design.** Template and trend scoring read
  every workspace's outcomes. Isolate them behind an explicit, auditable service so this is
  a deliberate, reviewable exception rather than an accident.
- A shared template needs no `workspaceId`; a *custom* client template eventually will.
  Model `Template.workspaceId` as nullable from the start — null means global — so
  client-specific templates are additive later.
- **Small-N leakage risk.** Aggregate scores derived from very few posts could expose
  something about one client. Apply a minimum-N threshold before a score is published to
  other workspaces.
- Sara needs access to multiple workspaces, so a super-admin or multi-workspace membership
  path is required for her own use.
- Seed data creates two workspaces, not one workspace with two brands.

## Alternatives considered

**Two brands in one workspace.** Simpler, and what the spec implied. Rejected because it
makes client offboarding a filtered delete, puts both clients' credentials under one
encryption key, and mismodels the commercial relationship from day one.

**Full isolation including templates.** Rejected because it forfeits the pooled-signal
advantage that makes the trend and template engines worth building.
