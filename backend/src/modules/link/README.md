# `modules/link/`

**Owner:** W7 · **Status:** built

## Responsibility

The first-party analytics spine (ADR-0006). Short links, the public redirector's domain
logic, click ingest with bot flagging, `{{link}}` injection at publish time, and click
rollups.

## Boundaries

- **The redirector is on the audience's critical path**, not ours. A slow or failing
  click write must never delay or break a redirect — the person clicking is a brand's
  customer, and they did not ask to participate in our analytics.
- **Raw IPs never enter this module's storage or logs.** `ip-hash.ts` is the only place an
  address is touched, and it returns a salted digest plus a country; the address is not
  returned, stored, or logged anywhere.
- **Clicks are flagged, never dropped.** A bot click is a row with `isBot: true` and a
  `botReason`. Dropping would make the filter permanently un-retunable, which is the whole
  reason ADR-0006 specifies flagging.
- Slug resolution runs through the **unscoped** client. A redirect arrives from an
  anonymous member of the public with no session and no tenant; that is genuine system
  work, and the resolved row's own `brandId` is what re-establishes the tenant afterwards.
- Injection knows about `PLATFORM_SPECS` but not about any adapter's HTTP. It produces a
  caption; `modules/publish/` decides what to do with it.

## The one invariant

**One `ShortLink` per `(post, platform)`.** That is the entire mechanism for per-platform
attribution — identical content on Instagram and X is indistinguishable without it. It is
enforced by a unique constraint rather than by application care, because publish retries
and the scheduling sweep can both run the same target and a duplicate row splits a post's
click stream in half, under-reporting in the direction that looks like a disappointing
post rather than a bug.
