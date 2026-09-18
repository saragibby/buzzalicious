# W7 — Outcome spine

**Depends on:** W2, W6 (steps 5–9 only) · **Blocks:** W8

**Read first:** [06 — Outcome & feedback loop](../06-outcome-and-feedback-loop.md), [ADR-0006](../adr/0006-first-party-link-tracking.md)

## Goal

Every published post has click data within minutes and platform metrics within a day.

**Steps 1–4 have no platform-API dependency and can ship during M3.**

## Build order

1. `/s/:slug` redirector + `LinkClick` ingest. 7-char base62 slugs, collision-checked,
   **302 not 301** (301s get cached and repeat clicks disappear).
2. **Bot filtering** — see below. Not a refinement; mandatory.
3. `{{link}}` injection at publish time, **one short link per `(post, platform)`**. This
   is the entire mechanism for per-platform attribution.
4. Click rollup queries — by post, platform, template, trend, time.
5. Metrics polling jobs at 1h / 24h / 7d, then weekly to 30 days. **Write a new
   `PostMetric` snapshot each time; never mutate a total.**
6. Outcome score computation with weights in config ([06](../06-outcome-and-feedback-loop.md)).
7. Insights UI: post list, post detail with metric timeline, template performance,
   "what's working" summary.

## Bot filtering

Every platform fetches a link preview the instant a post goes live. Unfiltered, those
arrive as clicks — often several before a human sees the post. **The entire feedback loop
rests on click data, so unfiltered bot traffic would actively teach the recommender the
wrong thing.**

1. User-agent matching (`facebookexternalhit`, `Twitterbot`, `LinkedInBot`, `Slackbot`,
   headless signatures)
2. Discard `HEAD` requests and requests not accepting HTML
3. Suppress clicks within seconds of publish from datacenter ranges
4. Deduplicate by `(ipHash, shortLinkId)` in a short window

**Flag (`isBot`), don't drop** — so filters can be retuned against real data later.

## Privacy

- **Never store raw IPs.** Salted SHA-256, salt rotated periodically.
- Derive country at ingest, then discard the IP.
- No cross-site cookies, no third-party pixels.

## Acceptance criteria

- [ ] Redirector resolves correctly and records a click; p95 latency < 100ms
- [ ] Known crawler user-agents are flagged `isBot` (test with real UA strings)
- [ ] Publishing injects a distinct short link per platform
- [ ] Metrics polls write snapshots; repeated polls don't overwrite history
- [ ] Outcome score computes with null-tolerant inputs
- [ ] Insights UI renders from seeded sample data
- [ ] No raw IP appears anywhere in the database or logs

## Notes

Null-tolerance matters: metric availability varies sharply by platform and account type.
Hide unavailable metrics rather than displaying zeros — a zero is a lie.

The redirector is on the brand's audience's critical path. Keep it fast and available.
