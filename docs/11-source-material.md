# 11 — Source material: what to port from Rise & Shore and TaxDedux

> **Status:** proposed.
> Resolves [Q2](./09-open-questions.md) — both apps are in production and posting.

Both existing apps live as siblings of this repo:

| Product | Repo | Stack |
|---------|------|-------|
| Tax Dedux | `../tax-agent` | TypeScript monorepo, `apps/` + `packages/`, BullMQ |
| Rise & Shore | `../sc-rental-monitor` | JavaScript, Express + React, node-cron |

**These are working systems, not prototypes.** Every platform integration in them has
published real posts. That is worth far more than the `buzzalicious` prototype being torn
down in [03](./03-teardown.md), and it changes the shape of phase 1: W6 is substantially a
**port and generalize** job rather than a from-scratch build.

> [!IMPORTANT]
> Read the source before writing the equivalent. The value here is in the accumulated
> workarounds — container polling, token quirks, media-hosting requirements — which are
> invisible in API documentation and expensive to rediscover.

## What each already does

| Capability | Tax Dedux | Rise & Shore |
|------------|-----------|--------------|
| X / Twitter | ✅ | ✅ |
| Facebook | ✅ | ✅ |
| Instagram | ✅ | ✅ (incl. carousels) |
| Threads | ✅ | ✅ |
| LinkedIn | ✅ | ✅ |
| TikTok | — | ✅ (video, PULL_FROM_URL) |
| YouTube Shorts | — | ✅ (resumable upload) |
| Reddit, Pinterest | — | ✅ |
| Reads platform metrics | — | ✅ (X, FB, IG) |
| Click tracking | ✅ (funnel journeys) | ✅ (`outbound_clicks` + UTM) |
| Link-in-bio page | ✅ | — |
| AI image generation | ✅ (Gemini / OpenAI) | — |
| Branded image composition | — | ✅ (`sharp`) |
| Scheduling | BullMQ repeat jobs | node-cron, 5-min tick |

**All four v1 target platforms are covered by both apps.**

## Port map

### Port largely as-is

| Source | Target | Notes |
|--------|--------|-------|
| `tax-agent/apps/worker/src/services/social-publisher.ts` | W6 adapters | The single most valuable file. Covers all four v1 platforms plus LinkedIn. Split per platform behind `PlatformAdapter` and thread `ResolvedCredential` through in place of env reads. |
| `tax-agent/apps/worker/src/services/social-image-host.ts` | W0 storage | Meta and TikTok fetch media **by URL**, so public hosting is a hard requirement, not a convenience. |
| `sc-rental-monitor/server/social/branded-image.js` | W4 reference | `sharp` composition — see the Satori tension below. |
| `tax-agent/packages/ai/src/social-images.ts` | W4 / W5 | AI image generation with provider fallback. |
| `tax-agent/apps/social-links/src/App.tsx` | W7 link page | Strong UX reference. Links are **hardcoded**; Buzzalicious needs them database-driven and per-brand. |

### Port the approach, rewrite the code

| Source | Target | Why rewrite |
|--------|--------|-------------|
| `tax-agent/packages/ai/src/social-content.ts` | W5 generation | Excellent prompt engineering — banned openers, emoji policy, per-platform length rules, LinkedIn voice overrides. All of it is hardcoded Tax Dedux voice; Buzzalicious needs it driven by the brand `voiceGuide`. **The structure is the asset, the content is not.** |
| `sc-rental-monitor/server/agents/social-poster.js` | W5 generation | Same pattern: `BRAND_VOICE`, `SOCIAL_COMPOSITION_GUIDANCE`, `REDDIT_COMMUNITY_RULES`. Good evidence for what a `voiceGuide` schema must express. |
| `sc-rental-monitor` metrics readers in `server/social/index.js` | W7 | Working X/FB/IG metric reads. Rewrite against the append-only time-series model in [06](./06-outcome-and-feedback-loop.md). |
| `sc-rental-monitor` click tracking (`/api/clicks`, `outbound_clicks`, UTM helpers) | W7 short links | Proves the approach. Buzzalicious needs bot filtering and per-post attribution it doesn't have. |
| `tax-agent/apps/social-links/src/lib/journey.ts`, `apps/api/src/routes/public-funnel.ts` | W7 | Journey/attribution model worth studying before designing ours. |
| Schedulers in both repos | W6 | Neither maps onto pg-boss; read for the failure modes they handle. |

### Reference only

- `sc-rental-monitor/server/social/index.js` — broad platform coverage but deeply coupled
  to Rise & Shore. Mine it for endpoint shapes and edge cases, especially TikTok/YouTube.
- `sc-rental-monitor/server/routes/cron.js` — operationally coupled to its host.

## Two things this changes in the plan

### 1. Credentials are pasted tokens today, not OAuth

Neither app runs an OAuth flow. Both read long-lived tokens from environment variables:

```
TWITTER_API_KEY / TWITTER_API_SECRET / TWITTER_ACCESS_TOKEN / TWITTER_ACCESS_SECRET
FACEBOOK_PAGE_ID / FACEBOOK_PAGE_ACCESS_TOKEN
INSTAGRAM_ACCESS_TOKEN / INSTAGRAM_ACCOUNT_ID
THREADS_ACCESS_TOKEN / THREADS_USER_ID
LINKEDIN_ACCESS_TOKEN / LINKEDIN_AUTHOR_ID
```

This is why `DIRECT_TOKEN` mode exists in
[ADR-0009](./adr/0009-byo-platform-credentials.md): both brands migrate immediately, with
no OAuth work. It is a bootstrap mode with a known expiry problem, not a destination.

**Migration is a copy, not a re-authorization** — a genuine acceleration for M4.

### 2. Neither app uses templates for imagery

Tax Dedux generates images with an AI model. Rise & Shore composes branded cards with
`sharp`. **Neither uses anything like Satori.**

This does not overturn [ADR-0002](./adr/0002-satori-template-rendering.md) — templates are
the product thesis, and neither existing approach gives the deterministic, brand-locked,
multi-rendition output the spec requires. But it does mean:

- There is **no existing template rendering code to port.** W4 is genuinely from scratch.
- `branded-image.js` is real evidence about composition, text fitting, and output specs,
  even though the engine differs.
- **AI image generation is a proven complementary path** the plan currently ignores. It
  covers cases templates handle badly — photographic backdrops, novel scenes. Worth an
  explicit decision on whether it's in v1 scope. See [Q17](./09-open-questions.md).

## Suggested order

1. Read `social-publisher.ts` end to end before designing the `PlatformAdapter` interface.
   Let the real integrations shape the abstraction, not the reverse.
2. Extract the per-platform quirks into notes on [08](./08-platform-integrations.md) —
   container polling, token types, media hosting.
3. Inventory both brands' live credentials and map them onto `DIRECT_TOKEN` seed data.
4. Read both voice-guide implementations before finalizing the `voiceGuide` Zod schema in
   W2. They are the best available evidence for what the schema must express.
5. Read the click-tracking implementations before designing W7's short-link service.

## Caution

- These are **live production systems.** Never modify them from a Buzzalicious session.
- Their credentials are real. Never copy a secret value into this repo, a doc, or a log.
- API versions differ between them (Graph `v18.0` vs `v21.0`). Verify current versions
  rather than inheriting either.
