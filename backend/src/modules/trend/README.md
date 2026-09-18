# `modules/trend/`

**Owner:** W9 · **Status:** v0 implemented (build-order steps 1–6)

## Responsibility

Answering, for one brand, *"what is trending for a business like mine that I could post
about this week — and what would I actually post?"*

A trend that arrives without a usable idea attached is noise. Every item this module
surfaces carries a concrete suggested angle and a plain-language explanation of why it
fits that brand. A feed entry with no angle is dropped rather than shown.

## What is here

| File | Role |
| --- | --- |
| `scoring.ts` | Pure scoring: velocity, acceleration, saturation penalty, age decay → momentum + lifecycle. No DB, no clock. |
| `scoring.service.ts` | Applies `scoring.ts` across stored signal history. Supports `dryRun`. |
| `trend.repository.ts` | All DB access, typed `Db`. |
| `mapping/rules.ts` | Layer 1 category mapping: deterministic keyword rules. Free, offline, explainable. |
| `mapping/mapping.service.ts` | Layered mapping with per-trend caching and low-confidence review flagging. |
| `feed.service.ts` | The per-brand scoped view: filter, rank, explain, attach angle and templates. |
| `pairing.ts` | Trend → template pairing via shared category tags. |
| `collectors/manual.collector.ts` | The weekly human curation pass. |
| `trend.access.ts` | Brand-access and trend-admin guards. |

## Boundaries

- **Trends are global.** Per ADR-0010 `Trend`, `TrendSignal`, `TrendCategoryScore` and
  `BusinessCategory` carry no `workspaceId` — the pooling advantage depends on sharing
  them. The per-brand feed is a scoped **view** computed from the brand's category, not a
  per-tenant table. Category mapping is therefore cached **per trend, not per brand**:
  one classification serves every customer.
- **Signals are append-only.** The repository exposes no update or delete path for
  `TrendSignal` by construction. This is what lets scoring be re-run over full history
  when the algorithm changes, which it will.
- **Scoring is pure.** `scoring.ts` never reads the clock or the database; `now` is always
  a parameter. Re-running it over unchanged history must produce an unchanged result.
- **Velocity, not volume.** A trend that is already everywhere is ranked *down*. By the
  time a trend saturates, posting it makes a small business look late and identical to
  everyone else. This is the product thesis, not a tuning detail.
- Collectors are **read-only** against external sources and must degrade to returning
  nothing. A trend source being down is a quiet gap in suggestions, never a failed page.
- Low-confidence category mappings are **flagged for review, never silently assigned**,
  and are withheld from feeds until a human confirms them. A confidently wrong mapping
  erodes trust faster than a thin feed.

## Not here yet

- **Automated collectors (build-order step 7).** Deliberately not started: they need
  external API access that is not yet approved, and open question **Q6 (TikTok ToS)** is
  unresolved. TikTok is not referenced anywhere in this module, including the rules
  vocabulary. Scraping risks terminating the very accounts the platform publishes from.
- **Scheduled rescoring.** pg-boss is deferred to W6, so recompute is invoked from the
  curation UI rather than on a cron. See `docs/07-trend-engine.md`.
- **Outcome feedback into ranking (step 9).** Depends on W7 analytics.

## Storage deviation to unwind

`TrendCategoryScore` has no confidence/method/review columns and there is nowhere to store
a curated angle, so v0 namespaces both under `Trend.raw.curation` and
`Trend.raw.categoryMapping`. `schema.prisma` is W2-owned; a `Trend.curation Json?` column
plus mapping metadata columns are requested as follow-ups. All reading and writing of that
namespace goes through `trend.schemas.ts`, so the migration touches one file.

Because two concerns share one JSON column, writes go through
`trend.repository.ts#mergeRaw`, which re-reads inside a transaction. Writing `raw` directly
from a stale in-memory `Trend` silently discards the other concern's data.
