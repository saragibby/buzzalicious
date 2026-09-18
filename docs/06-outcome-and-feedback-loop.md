# 06 — Outcome tracking & the feedback loop

> **Status:** proposed.
> **Decision:** first-party short-link tracking is P0.
> See [ADR-0006](./adr/0006-first-party-link-tracking.md).

This is the differentiator. Every competitor optimizes toward engagement; the PRD commits
to optimizing toward **outcomes a small business actually cares about — clicks, saves,
leads.**

## The core insight

Platform metrics are *borrowed* — gated behind app review, rate limits, changing policies,
and in X's case a paid tier. Outcome metrics can be **owned**.

A first-party short-link redirector gives us, on day one and with no third-party
dependency:

- click counts per post **and per platform**
- referrer, device, geography, and time-to-click
- a durable identity we can extend into conversion tracking later

This inverts the usual dependency. Instead of *"we can't show analytics until Meta
approves us,"* we ship a working create → publish → measure loop immediately and treat
platform-native metrics as **enrichment** on top of a first-party spine.

It is also strictly better product: a small business owner comparing "1,200 impressions"
against "38 people clicked through to your booking page" cares about the second number.

```mermaid
flowchart TB
    P["Post published"] --> SL["Unique short link<br/>per platform"]
    SL --> C["Click ingest<br/>bot-filtered"]
    P --> PM["Platform metrics poll<br/>1h / 24h / 7d"]
    C --> R["Rollups<br/>by template · trend · persona"]
    PM --> R
    R --> FB["Feedback loop v0<br/>template scoring"]
    FB --> REC["Composer recommendations"]
    REC -.->|user picks a template| P
```

## Short-link service

### Behavior

- Slug: 7 chars, base62, collision-checked. Short enough not to eat X's character budget.
- Served from the main app at `/s/:slug`. A dedicated short domain is a later, cheap
  upgrade — the route is what matters now.
- **One short link per `(post, platform)`**, not per post. This is the entire mechanism
  for per-platform attribution: identical content on Instagram vs. X produces two
  distinguishable click streams.
- `302` redirect, not `301` — permanent redirects get cached by browsers and we stop
  seeing repeat clicks.
- Injected into captions automatically at publish time, replacing a `{{link}}` marker in
  the composed copy.

### Bot filtering is not optional

Every platform fetches a link preview the instant a post goes live. Unfiltered, those hits
arrive as clicks — often several per post, before a single human sees it. Since the entire
feedback loop is built on click data, **unfiltered bot traffic would actively teach the
recommender the wrong thing.**

Layered defense:

1. User-agent matching against a known crawler list (`facebookexternalhit`, `Twitterbot`,
   `LinkedInBot`, `Slackbot`, headless signatures)
2. Discard `HEAD` requests and requests that don't accept HTML
3. Suppress clicks arriving within a few seconds of publish from datacenter ranges
4. Deduplicate by `(ipHash, shortLinkId)` inside a short window

Flag rather than drop (`LinkClick.isBot`) so the filter can be tuned retroactively against
real data.

### Privacy

- **Never store raw IPs.** Salted SHA-256, with the salt rotated periodically.
- Derive country from IP at ingest, then discard the IP entirely.
- No cross-site cookies, no third-party pixels. This is genuinely privacy-preserving
  analytics and worth saying out loud in marketing.

## Platform metrics ingestion

Complements, not replaces, the first-party spine.

| When | Why |
|------|-----|
| 1 hour after publish | Early velocity — the strongest predictor of eventual reach |
| 24 hours | The standard comparison point |
| 7 days | Near-final totals |
| Weekly for 30 days | Long-tail, especially saves on Instagram |

Each poll writes a new `PostMetric` snapshot rather than mutating a total. Snapshots are
what allow "compare all posts at their 24h mark" — a mutable counter makes that
permanently impossible.

**Availability varies by platform.** Instagram exposes saves and reach through Insights;
X's metrics depend on API tier; Threads' API is newer and thinner. Null-tolerant metric
columns and a UI that hides unavailable metrics rather than showing zeros.

## Outcome scoring

Raw metrics aren't comparable across platforms — an Instagram like and an X like are not
the same event. Normalize into a single per-post **outcome score**:

```
outcomeScore = w_click  * normalize(linkClicks / reach)
             + w_save   * normalize(saves / reach)
             + w_share  * normalize(shares / reach)
             + w_engage * normalize((likes + comments) / reach)
```

Starting weights, expressing the product thesis that clicks and saves indicate intent
while likes indicate scrolling:

| Signal | Weight |
|--------|--------|
| Link clicks | 0.45 |
| Saves | 0.25 |
| Shares | 0.20 |
| Likes + comments | 0.10 |

Weights live in config, not code, so they can be tuned as real data arrives. Normalize
**per platform** against that brand's own rolling median, so a brand with 200 followers
and one with 20,000 are scored on their own baseline.

When `reach` is unavailable, fall back to per-brand rolling-median normalization of raw
counts.

## Feedback loop v0

The PRD's P0: *"surface the user's best-performing template types, and bias future
defaults toward them."* The PRD also demands the cold-start case: *"As a brand-new user
with no performance history yet, I want useful recommendations from day one."*

Those two requirements together rule out a naive "rank by average score" — a brand with
one lucky post would get a confidently wrong recommendation.

### Shrinkage toward category priors

For brand *b* and template archetype *a*:

```
score(b, a) = ( n(b,a) · observed(b,a) + k · prior(category(b), a) ) / ( n(b,a) + k )
```

- `n(b,a)` — posts this brand published with archetype *a*
- `observed(b,a)` — mean outcome score for those posts
- `prior(c,a)` — archetype performance across all brands in category *c*, falling back to
  the hand-seeded `BusinessCategory.priors` when aggregate data is thin
- `k` — smoothing constant, start at **5**

The behavior this produces is exactly what the PRD describes:

| Situation | Result |
|-----------|--------|
| New brand, `n = 0` | Score equals the category prior — useful day-one recommendations |
| 2 posts | Still mostly prior; one fluke can't dominate |
| 20 posts | Brand's own history dominates; recommendations are visibly personalized |

It is ~15 lines of code, explainable to a user in one sentence, and has no training
pipeline. Start here. A learned model is only worth considering once there's meaningful
volume, and it would have to beat this baseline to justify itself.

### Surfacing it

Ranking silently is a missed opportunity. Show the reasoning:

> **Recommended for you** — *Before/After* posts drove **2.4× more link clicks** than your
> average over your last 12 posts.

And for a cold-start brand:

> **Popular with coffee shops** — *Behind the Scenes* templates perform well for
> businesses like yours.

This makes the core promise legible, and it's the difference between "the tool reordered
some tiles" and "the tool is learning my business." It also produces the honest failure
mode: when the explanation looks wrong to the user, we find out early.

### Guardrails

- **Always show an escape hatch.** Never collapse the gallery to recommendations only —
  `template acceptance rate` is a success metric and requires alternatives to exist.
- **Inject exploration.** Reserve ~20% of recommendation slots for templates the brand
  hasn't tried. Pure exploitation converges on a local maximum and makes every feed look
  identical — the exact Predis.ai failure the product exists to beat.
- **Require a minimum sample** before showing a brand-specific claim. Under 5 posts with
  an archetype, show the category framing instead.

## Send-time and cadence learning

**Decision ([Q18](./09-open-questions.md)):** the system learns each brand's best posting
times and frequency, starting from an informed guess and iterating on outcome data.

This reuses the machinery above rather than inventing a second one — the same shrinkage
formula, the same outcome score. What differs is the dimension being scored.

### Timezone still has to be right underneath

Learning *when* to post doesn't remove the need to represent time correctly. Two things
are stored:

- `Brand.timezone` — an IANA zone (`America/New_York`), not a UTC offset. Offsets change
  twice a year; zones don't.
- `Post.scheduledAt` (UTC instant) **and** `scheduledLocal` + the zone it was intended in.

Storing only the UTC instant loses the user's intent. "Every Tuesday at 9am" silently
becomes 8am or 10am after a DST transition, and recurring schedules drift. Capturing
intent alongside the instant is cheap now and unrecoverable later — the intent was simply
never recorded.

The default timezone is guessed from the browser at brand creation and is always editable.

### Audience timezone, not business timezone

The thing that matters is when the *audience* is awake, which is not always where the
business sits. A coffee shop's audience is local; Tax Dedux's audience is national and
spread across four US zones.

Platform insights expose audience geography where available, and first-party
`LinkClick` data gives a click-time histogram for free — **we can observe when a brand's
audience actually engages without asking any platform.** That histogram is the better
signal, and it's one the borrowed-metrics competitors can't easily build.

### Time slots: start coarse

The instinct is day-of-week × hour = 168 buckets. **That is far too sparse to learn
from** — a brand posting daily takes six months to get one observation per bucket, and
most buckets stay empty forever.

Start with 8 buckets and refine only when the data supports it:

| Dimension | Initial buckets |
|-----------|-----------------|
| Day type | weekday, weekend |
| Daypart | early (5–9), midday (9–14), afternoon (14–18), evening (18–23) |

Split a bucket only once it holds enough observations to distinguish its halves. This
matters more than the scoring formula: the right granularity is what makes the learning
possible at all.

### Scoring a slot

Identical in shape to archetype scoring:

```
score(b, s) = ( n(b,s) · observed(b,s) + k · prior(category(b), s) ) / ( n(b,s) + k )
```

Cold-start priors come from three stacked sources, best available first:

1. The brand's own `LinkClick` time histogram, if any links have been clicked
2. Category priors — other brands in the same `BusinessCategory`
3. Hand-seeded platform defaults in config

So a brand with zero posts still gets a defensible suggestion, and it improves
immediately rather than after some arbitrary threshold.

### Exploration is mandatory here

More so than for templates. **A pure-exploitation scheduler posts at the first slot that
looked good and never learns anything again** — it can't, because it generates no
observations anywhere else. The first lucky slot becomes permanent.

Reserve ~20–30% of scheduled posts for deliberately under-sampled slots, and prefer slots
with high uncertainty rather than uniformly random ones. Surface this honestly: *"Trying
Thursday evening — we haven't tested that time for you yet."* Users tolerate
experimentation they were told about.

### Cadence is a separate problem

Frequency doesn't have an optimum in the way timing does — it has **diminishing returns
and a fatigue cliff**, and the two look identical in the data until you cross the cliff.
Per-post engagement falling as volume rises can mean saturation, or simply that reach is
being spread thinner while total reach still grows.

So measure cadence against **total** outcome per week, not per-post average. Optimizing
per-post average pushes toward posting almost never, which scores beautifully and grows
nothing.

Cadence recommendations should be conservative and advisory in v1 — suggest a range, never
auto-schedule into it. Getting cadence wrong is visible to a brand's real audience in a way
that a mistimed post is not.

### Guardrails

- **Quiet hours.** Never auto-schedule overnight in the audience's timezone without
  explicit opt-in, regardless of what the data says.
- **Always explain and always allow override.** A suggested time the user can't move is a
  constraint, not a recommendation.
- **Minimum sample before brand-specific claims.** Under ~5 posts in a bucket, use the
  category framing.
- **Confounding is real and should be admitted.** A post's outcome reflects its content at
  least as much as its timing, and at low volume the two can't be separated. This argues
  for conservative language — *"Tuesday mornings have worked well for you"* — rather than
  false precision like *"9:15am is your optimal time."*

### Build order

Belongs to W8, after template scoring works:

1. `Brand.timezone` + intent-preserving schedule fields (W2)
2. Click-time histogram from `LinkClick` — free once W7 lands
3. Coarse slot bucketing + slot scoring reusing the shrinkage function
4. Suggested times in the composer, with explanations
5. Exploration scheduling for under-sampled slots
6. Cadence analysis as advisory guidance
7. Bucket refinement once volume justifies it

## Insights UI (v1 scope)

Deliberately narrow — the PRD puts deeper analytics at P1.

1. **Post list** — each post with its platforms, outcome score, and link clicks
2. **Post detail** — per-platform breakdown, metric snapshots over time, the click
   timeline
3. **Template performance** — archetypes ranked by outcome score for this brand, with
   sample sizes shown
4. **What's working** — a short prose summary driven by the same scoring that powers
   recommendations

Cross-post trend views, template-vs-template comparison, and per-platform benchmarking are
P1 and build on exactly this data.

## Build order for W7/W8

1. `ShortLink` model + `/s/:slug` redirector + `LinkClick` ingest
2. Bot filtering with `isBot` flagging
3. `{{link}}` injection at publish time, one link per platform
4. Click rollup queries
5. Metrics polling jobs per platform, writing snapshots
6. Outcome score computation with configurable weights
7. Shrinkage scoring + the recommendation endpoint
8. Composer recommendations with explanations
9. Send-time slot scoring + suggested times (see above)
10. Insights UI

Steps 1–4 have **no dependency on platform API approval** and can ship during M3.
