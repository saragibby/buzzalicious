# `modules/insight/`

**Owner:** W7 (metrics, outcome score, insights read model) · **Status:** built

## Responsibility

Pulling performance metrics back from the platforms after publication, storing them as
time series, and aggregating them into the numbers a user actually looks at.

## Boundaries

- Reads platform APIs through resolved credentials, the same way `modules/publish/` does.
  Credential resolution is not duplicated here.
- Metric collection is scheduled work in the worker. Fetching on page load makes every
  dashboard as slow and as unreliable as the slowest platform API.
- Platforms restate recent numbers for a day or two. Collection must be idempotent and
  able to correct an already-stored value.

## Two rules that shape everything here

**Never mutate a metric total.** Each poll writes a new `PostMetric` row; the series is
the product, not a cache of a current value. Correcting a restated number means writing
another snapshot, never updating an old one. `targetOutcomes` therefore reads the LATEST
snapshot per target and never sums them — summing a cumulative series double-counts every
earlier poll.

Idempotency is enforced by the database, not by the handler remembering: `PostMetric` has
`@@unique([postTargetId, capturedAt])`, and `capturedAt` is set to the **checkpoint** time
the poll was scheduled for rather than `now()`. A re-run of the same checkpoint therefore
collides and is a no-op. This is also why collection is a sweep over due targets rather
than a delayed job per checkpoint: pg-boss retention is finite, and a job lost during an
outage would leave a permanent hole that reads as a real zero.

**A zero is a lie.** Metric availability varies sharply by platform and by account type —
an Instagram personal account exposes almost nothing, and X impressions depend on the API
tier. Every metric column on `PostMetric` is nullable and `null` means *not available*,
distinct from a real `0`. Coercing an absent metric to `0` teaches W8's recommender that
a post failed when in truth it was never measured. The UI hides unavailable metrics
rather than rendering `0`, and the outcome score normalises by the coverage it actually
achieved instead of assuming missing components were zero.

## Deviation: aggregation on read

The scaffold specified aggregation on write. `insight.service.ts` aggregates **on read**
instead, and this is a deliberate, flagged deviation rather than an oversight.

The reasoning: the expensive shape the original rule guards against is recomputing months
of raw time series per request. What the read model actually touches is the latest
snapshot per target plus that brand's click rollups — bounded by the number of published
targets a brand has, not by elapsed time or poll frequency. Materialising it would add a
second copy that can silently disagree with the snapshots, for no benefit at v1 volumes.

This stops being true once a brand accumulates enough targets that the per-request scan is
noticeable. The migration path is a materialised rollup written by the poll handler, with
the read model as the reference implementation to check it against.
