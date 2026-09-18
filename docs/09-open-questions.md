# 09 — Open questions

> Decisions that are **not** settled. Each blocks or shapes real work. Resolve, then
> record as an ADR and update the affected doc.

## Blocking phase 1

### Q1 — Rise & Shore publishing platforms — **RESOLVED**

Rise & Shore posts to **nine** platforms today: X, Facebook, Instagram, Threads, LinkedIn,
TikTok, YouTube Shorts, Reddit, and Pinterest ([11](./11-source-material.md)).

This does **not** expand v1 scope. The four v1 targets stay as scoped, and Rise & Shore
keeps running its existing system for the rest until Buzzalicious catches up. But it does
reframe "migration": Buzzalicious is initially a *subset* of what Rise & Shore already has,
so the pitch for moving over must be templates, trends, and the outcome loop — not
coverage.

LinkedIn is now the obvious first P1 addition — both apps already have working
implementations to port.

### Q2 — State of existing scheduling code — **RESOLVED**

Both are **production systems actively posting.** Full audit and port map in
[11 — Source material](./11-source-material.md).

Headline: `tax-agent/apps/worker/src/services/social-publisher.ts` covers all four v1
platforms and is rated "port largely as-is." W6 is substantially a port-and-generalize job.
Credential migration is a copy, not a re-authorization ([ADR-0009](./adr/0009-byo-platform-credentials.md)).

### Q3 — X API tier *(reshaped by ADR-0009)*

Under BYO credentials the cost sits with the **client**, who brings their own X app and
tier — no longer a Buzzalicious fixed cost for phase 1.

What remains open: **tier detection and degradation.** Posting limits and metrics
availability differ by tier, so we must surface which tier a client credential is on and
degrade the feedback loop honestly when metrics aren't available. A separate, smaller
question is what tier the Buzzalicious read-only trend app needs.

**Blocks:** W6 pre-flight, W7 metrics expectations. **Owner:** Sara + eng. **Needed by:** M4.

### Q4 — Hosting provider — **RESOLVED: Heroku**

[ADR-0003](./adr/0003-stack-express-vite.md) settles the stack; Heroku hosts it.

Implications to handle in W0:

- **Heroku Postgres**, so pg-boss ([ADR-0004](./adr/0004-pg-boss-job-queue.md)) needs no
  extra infrastructure — it runs in the same database. Check the connection limit on the
  chosen plan: pg-boss holds connections, and the hobby tier's 20-connection ceiling is
  easy to exhaust alongside a web dyno pool.
- **Ephemeral filesystem.** Nothing renders to local disk and survives. Every rendition
  goes straight to object storage, which the plan already assumes.
- **Dyno sleep on free/eco tiers will silently break scheduled publishing.** A worker dyno
  must stay awake. This is a real correctness issue, not a performance one.
- Config vars hold the encryption key ([Q14](#q14--key-management-for-client-app-secrets)).
- `Procfile` with separate `web` and `worker` process types.
- Heroku Scheduler is available but pg-boss cron is preferred — one mechanism, not two.

Object storage still needs picking: R2 (as planned) or S3. R2's zero egress fees matter
because Meta and TikTok fetch media by URL on every publish.

### Q5 — Instagram link strategy — **RESOLVED: link-in-bio page**

Instagram feed captions don't render clickable links, so the short-link outcome spine is
weakest exactly where it matters most.

**Decision:** Buzzalicious offers a hosted **link-in-bio page per brand**, modeled on the
one Tax Dedux already runs (`tax-agent/apps/social-links/`, see
[11](./11-source-material.md)).

The existing page is a static React app with links hardcoded in a `DESTINATIONS` constant
and first-party journey tracking. **Port the UX, rebuild the data layer:** links must be
per-brand, database-driven, editable without a deploy, and instrumented with the same
`ShortLink` / `LinkClick` primitives as everything else
([06](./06-outcome-and-feedback-loop.md)).

The subtlety worth designing for: an Instagram post can't carry a post-specific link, so
attribution is **indirect** — a click on the bio page can only be probabilistically tied to
the post that drove it. Options include rotating the featured link to match the most recent
post, or time-window attribution. Instagram click data will always be weaker than X or
Facebook; the model should treat it as such rather than pretending otherwise.

**Remaining:** attribution approach. **Owner:** eng. **Needed by:** M5.

### Q6 — TikTok Creative Center automated access

The trend engine wants it as a collector. The data is publicly visible; whether automated
access is permitted under ToS is not established.

Resolve before writing the collector — retrofitting a removal is wasted work, and ToS
violations can threaten the publishing accounts.

**Blocks:** W9 step 7. **Owner:** Sara.

### Q14 — Key management for client app secrets — **RESOLVED: Heroku config var**

The encryption key lives in a **Heroku config var** for v1, not a managed KMS. Appropriate
while the only tenants are Sara's own brands, and it avoids an AWS dependency alongside
Heroku.

Two things must be true so the KMS upgrade stays cheap when external clients arrive:

- **Ciphertext carries a version prefix**, so keys can be rotated and the wrapping scheme
  swapped incrementally rather than in one migration.
- **All encryption goes through one module** with a `KeyProvider` seam. Swapping config-var
  for KMS should be one implementation, not a search across the codebase.

Accepted limitation: anyone with Heroku admin access can read the key, and there is no
independent audit trail of decryption. That is fine for internal use and **not** fine for
an external client who asks who can read their app secret — revisit at that point, not
before.

### Q15 — Tenancy model — **RESOLVED: workspace per client**

Each client is a `Workspace`; trends and templates are shared platform-wide.
See [ADR-0010](./adr/0010-workspace-per-client.md).

### Q16 — Legal framing for holding client app secrets — **DEFERRED**

Not required for v1, since the only tenants are internal. Security controls in
[10](./10-credentials-and-security.md) are still built now — they're cheap to build in and
expensive to retrofit.

**Required before the first external client:** platform ToS confirmation per platform, a
data processing agreement, a privacy policy, and documented retention/deletion terms.

**Trigger, not a date:** the moment a workspace is created for someone who isn't Sara.

## Shaping, not blocking

### Q7 — Design system / UI kit

The old CSS is being deleted. Options: Tailwind + shadcn/ui (fast, modern, highly
agent-friendly), a component library like Mantine, or hand-rolled CSS modules.

"Joy is a feature" is an anchoring principle, so this is a product decision as much as a
technical one — a generic admin-panel look actively works against the positioning.

Recommendation: **Tailwind + shadcn/ui**, for velocity and because subsequent agent
sessions produce far more consistent UI against a known component vocabulary.

**Affects:** W5. **Owner:** Sara.

### Q8 — Business category taxonomy source

Build by hand (~8 parents, ~60 leaves) or adapt an existing taxonomy (Google Business
profile categories, NAICS)?

Hand-built is tractable and tuned to small business. An existing taxonomy is more complete
but much noisier — NAICS has thousands of codes irrelevant here.

Recommendation: **hand-build**, informed by Google Business categories.

**Affects:** W2 seed data.

### Q9 — Emoji rendering in Satori

Satori needs an explicit strategy — an emoji font buffer or a `graphemeImages` mapping.
Small business captions are full of emoji, so this will surface immediately.

Decide during W4 step 2, not after templates are authored.

**Affects:** W4.

### Q10 — Product name

The spec notes the name is TBD. Working name stays **Buzzalicious** for now.

A rename later touches the repo name, deploy config, OAuth app registrations, and any
short-link domain. Cheapest before OAuth apps are registered with Meta and X — so if a
rename is likely, decide before M4.

**Owner:** Sara.

### Q11 — Multi-brand UI in v1

`Brand` is first-class in the schema ([ADR-0008](./adr/0008-brand-first-class.md)), but
the PRD lists multi-brand UI as P1. Since Rise & Shore and TaxDedux both need to run on
the platform, a brand switcher may be M3 work rather than P1.

Recommendation: ship a minimal brand switcher in M3. The schema already supports it and
the two dogfood accounts need it.

### Q12 — Outcome score weights

[06](./06-outcome-and-feedback-loop.md) proposes clicks 0.45 / saves 0.25 / shares 0.20 /
engagement 0.10. These are informed guesses expressing the product thesis, not measured
values.

Keep them in config. Revisit after ~50 published posts across the dogfood brands.

### Q13 — Pricing model

Not required for phase 1, but it shapes what usage must be metered. Competitors meter
posts or AI credits. Satori rendering is nearly free, which is a genuine cost advantage —
possibly the basis for unlimited-posts positioning against Predis.ai's post limits.

Worth deciding before building any billing, so metering hooks land in the right places.

### Q17 — Is AI image generation in v1 scope?

Surfaced by the audit ([11](./11-source-material.md)). Tax Dedux generates post images with
Gemini/OpenAI; Rise & Shore composes them with `sharp`. Neither uses templates.

Templates remain the product thesis — deterministic, brand-locked, multi-rendition output
is exactly what AI generation *can't* reliably give. But AI generation covers what templates
handle badly: photographic scenes, novel imagery, anything not reducible to text in a
layout. Tax Dedux's implementation is rated "port largely as-is."

The risk in adding it to v1 isn't technical, it's focus: a good-enough AI image button could
quietly become the path users take, and the template engine — the actual differentiator —
would never get the usage needed to prove it out.

Leaning: **not in v1.** Revisit once templates have real usage data.

### Q18 — Timezone handling for scheduling — **RESOLVED: learn it**

The system makes an informed first guess at a brand's best posting times and frequency,
then iterates on outcome data. Design in
[06 — Send-time and cadence learning](./06-outcome-and-feedback-loop.md#send-time-and-cadence-learning).

Schema consequences land in W2: `Brand.timezone` as an IANA zone, and `Post.scheduledAt`
stored alongside `scheduledLocal` / `scheduledTz` so recurring intent survives DST.
`scheduleSource` distinguishes user-chosen from system-suggested times — without it the
loop trains on its own suggestions.

**Remaining:** none blocking. Slot granularity and the exploration rate are tunable
constants, not decisions.

### Q21 — Video support — **RESOLVED: image and text in v1**

v1 ships `IMAGE` and `TEXT` posts. **Video is its own development track**, not a v1
stretch goal.

`MediaType` is declared with `VIDEO` present but unimplemented, and `Rendition` carries
`mimeType` and `durationMs`, so no code path hardcodes "always a PNG."

The more immediately useful half: **text-only posts have no rendition at all.** The
composer, publish pipeline, and export must tolerate zero renditions from day one — which
is exactly what makes plain X and Threads posts work in v1, and it's a case that's easy to
break if every path assumes an image exists.

### Q19 — Font licensing for Satori

Satori requires font files embedded server-side. Many fonts — including much of Google
Fonts — are fine for this, but not all, and "we shipped a font we didn't have rights to" is
a real legal exposure that is cheap to avoid and expensive to unwind.

W4 must pick a curated set with verified licenses. Also settle emoji ([Q9](#q9--emoji-rendering-in-satori)),
which is a separate licensing question.

### Q20 — AI provider and spend controls

Both existing apps call LLMs with no per-tenant spend cap visible. With multiple workspaces
generating content, an unbounded loop or an enthusiastic client is a direct financial
liability.

Decide: which provider and model tier, per-workspace budgets, what happens at the cap
(queue, degrade, refuse), and whether generation cost is metered for future billing
([Q13](#q13--pricing-model)). The existing `AiGeneration` telemetry model gives somewhere to
record it.

### Q21 — *(resolved above)*

### Q22 — Backups and restore drill

Not previously documented. Heroku Postgres has automated backups, but **an untested backup
is a hypothesis.**

Holding client credentials raises the stakes: a restore that loses the encryption key is
unrecoverable data, and a key rotation that outruns the backup window means old backups can
no longer be decrypted. Do a real restore drill before the first external client, and
document where the encryption key is backed up — separately from the database.

### Q23 — Template authoring workflow

W2 seeds 8–12 templates and [05](./05-template-engine.md) defines the JSON layout format,
but nothing says **how a template actually gets made.** Hand-written JSON by a developer is
fine for the first dozen and a hard ceiling after that.

This determines whether the template library can grow without engineering time — which is
the difference between templates being an asset and being a bottleneck. Not v1 blocking,
but it should shape the layout format now: a format that's pleasant to hand-write is not
necessarily one a visual editor can round-trip.

## Resolved during planning (2026-09-17)

For traceability — full reasoning in the linked ADRs.

| Question | Resolution |
|----------|-----------|
| Rewrite vs. refactor | Clean foundation reset ([0001](./adr/0001-clean-foundation-reset.md)) |
| What is a "template" technically | HTML/CSS → Satori → PNG ([0002](./adr/0002-satori-template-rendering.md)) |
| Next.js vs. Express + Vite | Express + Vite ([0003](./adr/0003-stack-express-vite.md)) |
| Job queue infrastructure | pg-boss on Postgres ([0004](./adr/0004-pg-boss-job-queue.md)) |
| v1 platform targets | IG, Facebook, Threads, X ([0005](./adr/0005-v1-platform-targets.md)) |
| Outcome tracking approach | First-party short links, P0 ([0006](./adr/0006-first-party-link-tracking.md)) |
| Trend data build vs. integrate | Build in-house ([0007](./adr/0007-in-house-trend-engine.md)) |
| Multi-brand timing | `Brand` first-class in v1 schema ([0008](./adr/0008-brand-first-class.md)) |
| Whose platform credentials | Dual mode; `DIRECT_TOKEN` + `CLIENT_APP` ([0009](./adr/0009-byo-platform-credentials.md)) |
| Tenancy model | Workspace per client; trends + templates shared ([0010](./adr/0010-workspace-per-client.md)) |
| Hosting | Heroku ([Q4](#q4--hosting-provider--resolved-heroku)) |
| Encryption key custody | Heroku config var for v1, KMS-ready ([Q14](#q14--key-management-for-client-app-secrets--resolved-heroku-config-var)) |
| Instagram link strategy | Hosted link-in-bio page per brand ([Q5](#q5--instagram-link-strategy--resolved-link-in-bio-page)) |
| Scheduling times | Learned per brand, DST-safe intent stored ([Q18](#q18--timezone-handling-for-scheduling--resolved-learn-it)) |
| Media types in v1 | Image and text; video is its own track ([Q21](#q21--video-support--resolved-image-and-text-in-v1)) |
| State of existing apps | Both in production; port map in [11](./11-source-material.md) |
| Existing production data | None worth preserving; destructive reset approved |
