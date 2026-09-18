# ADR-0007 — Build the trend engine in-house

**Date:** 2026-09-17 · **Status:** Accepted

## Context

P0 requires trend data acquisition, and the spec explicitly leaves build-vs-integrate
unsettled, asking for a cost, legal-risk, and speed comparison. Trend-relevance is half the
product's differentiation — templates and trends ranked by business-category relevance.

## Options

1. **Manual/curated trends only** for v1.
2. **Integrate a third-party trend API.**
3. **Build in-house collection, scoring, and determination.**

## Decision

**Option 3**, with manual curation retained as a first-class collector rather than a
placeholder.

Architecture: pluggable `TrendCollector` implementations feeding an append-only
`TrendSignal` store, a scoring engine computing velocity/momentum/lifecycle, and a layered
category mapper.

## Rationale

- **The needed product is not a general trend feed.** It is "what's trending for a business
  like mine, that I could post this week." That reframing means modest coverage with high
  category relevance beats broad commodity coverage — a cheaper target that no existing
  vendor serves.
- **The category mapping and scoring layer is the asset.** Buying trend data buys a
  feature; the relevance layer on top is the defensible part, and it can't be bought.
- **It compounds with the feedback loop.** Once brands post against trends, our own outcome
  data by category becomes the strongest relevance signal — a moat no competitor can
  replicate without our data.
- **Saturation penalty is a deliberate differentiator.** Generic trend tools rank by
  popularity; by the time a trend is everywhere, a small business posting it is late. Our
  engine favors emerging trends.

## Consequences

- **Largest scope risk in phase 1.** v0 is explicitly bounded: manual collector + one
  automated collector + scoring + category mapping + feed. Nothing more.
- Manual curation must be built first — it validates schema, scoring, and UI with zero API
  dependency, and produces labeled data for tuning category mapping.
- Signals are append-only so scoring can be re-run over history as the algorithm changes.
- Rate limits require rotating watchlists rather than broad discovery (IG hashtag search is
  particularly constrained).
- **ToS risk must be resolved before any collector ships** ([Q6](../09-open-questions.md)).
  Use official APIs; store derived signals, not copied content. A violation could threaten
  the accounts we publish from — a far worse outcome than a thin trend feed.
