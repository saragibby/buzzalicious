# `modules/trend/`

**Owner:** W7 · **Status:** scaffold

## Responsibility

Collecting what is currently getting attention in a brand's niche, and storing it in a
shape the recommender can use. Implements `TrendCollector` from
[docs/01-architecture.md](../../../../docs/01-architecture.md) — one implementation per
source, so adding a source never changes a caller.

## Boundaries

- Collectors are **read-only** against external sources and must degrade to returning
  nothing. A trend source being down is a quiet gap in suggestions, never a failed page.
- Collection runs on a schedule in the worker, never on a request.
- Interpretation is `modules/recommend/`'s job. This module records observations; it does
  not decide what a brand should do about them.
- Every external call needs a timeout and a per-source rate limit. These APIs are
  third-party and hostile to being polled.
