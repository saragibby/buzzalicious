# `modules/insight/`

**Owner:** W8 · **Status:** scaffold

## Responsibility

Pulling performance metrics back from the platforms after publication, storing them as
time series, and aggregating them into the numbers a user actually looks at.

## Boundaries

- Reads platform APIs through resolved credentials, the same way `modules/publish/` does.
  Credential resolution is not duplicated here.
- Metric collection is scheduled work in the worker. Fetching on page load makes every
  dashboard as slow and as unreliable as the slowest platform API.
- Aggregation happens on write, not on read. A dashboard that recomputes months of raw
  metrics per request stops working at exactly the point the product starts succeeding.
- Platforms restate recent numbers for a day or two. Collection must be idempotent and
  able to correct an already-stored value.
