# ADR-0006 — First-party short links as the analytics spine (P0)

**Date:** 2026-09-17 · **Status:** Accepted

## Context

The product's central differentiator is outcome-based rather than engagement-based
feedback: small business owners care about clicks, saves, and leads more than views. P0
requires per-post tracking of reach, saves, link clicks, and native engagement.

Every one of those metrics except link clicks depends on platform APIs — which are gated
behind Meta app review, rate-limited, tier-dependent on X, and subject to policy change.
Building the feedback loop on borrowed data means it can't be built until approval lands.

## Options

1. **UTM parameters only**, relying on the user's own Google Analytics.
2. **First-party short-link redirector** owned by the platform.
3. Defer outcome tracking entirely until platform metrics are available.

## Decision

**Option 2, at P0.** A `/s/:slug` redirector issuing **one short link per
`(post, platform)`**, injected into captions at publish time, with bot-filtered click
ingestion.

## Rationale

- **It removes the approval dependency from the differentiator.** Clicks, referrer,
  device, geography, and time-to-click are available on day one with no third-party
  permission.
- **Per-platform attribution is otherwise impossible.** Identical content posted to
  Instagram and X is indistinguishable in a shared UTM stream; separate short links make
  the two click streams distinguishable.
- **It is better product.** "38 people clicked through to your booking page" is more
  meaningful to a small business owner than "1,200 impressions."
- UTMs require the user to own and correctly configure analytics on a site they control —
  many won't, and we'd never see the data.
- Privacy-preserving by construction: salted IP hashes, no cross-site cookies, no
  third-party pixels — a marketable property.

## Consequences

- **Bot filtering is mandatory, not a refinement.** Platform link-preview crawlers fire on
  every publish; unfiltered they would teach the recommender the wrong thing. Clicks are
  flagged (`isBot`) rather than dropped so filters can be retuned retroactively.
- Raw IPs are never stored — salted hash plus derived country only.
- Instagram's non-clickable feed captions weaken this exactly where it matters
  ([Q5](../09-open-questions.md)).
- A short-link domain becomes a (cheap) later upgrade; the route works immediately.
- Redirector latency is now user-facing for the brand's audience — keep it fast and
  highly available.
