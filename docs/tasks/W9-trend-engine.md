# W9 — Trend engine v0

**Depends on:** W2 · **Parallel with:** everything after M1

**Read first:** [07 — Trend engine](../07-trend-engine.md), [ADR-0007](../adr/0007-in-house-trend-engine.md)

> **Largest scope risk in phase 1.** v0 is explicitly bounded: manual collector + one
> automated collector + scoring + category mapping + feed. Nothing more.

## Goal

A per-brand trend feed answering *"what's trending for a business like mine, that I could
post about this week"* — **not** a general trend feed. That reframing is what makes this
achievable: modest coverage with high category relevance, not breadth.

## Build order

**Steps 1–6 have no external API dependency**, which is what keeps this off the
Meta-approval critical path.

1. `Trend` / `TrendSignal` / `TrendCategoryScore` models + internal admin CRUD
2. **Manual curation collector + admin UI.** Build this first. It is not a placeholder —
   a weekly curation pass by someone who understands small-business marketing beats a
   naive automated feed for months, and it's the only way to have signals to score while
   automated collectors mature.
3. Scoring engine — velocity, momentum, lifecycle — running over manual signals
4. Category mapping layers 1 and 2: keyword/entity rules first (deterministic,
   explainable, free), then LLM classification for what rules miss. **Cache per trend, not
   per brand.**
5. Per-brand feed API + UI, with "why this fits you" explanations
6. Trend → compatible template pairing in the composer
7. **One** automated collector end to end — X search or Meta hashtag, whichever clears
   approval first. **Resolve [Q6](../09-open-questions.md) before touching TikTok.**
8. Cross-platform entity resolution (start exact-match only; add fuzzy with human review)
9. Outcome feedback into category mapping (layer 4) — after W7 has data

## Scoring notes

- Signals are **append-only**, so scoring can be re-run over history when the algorithm
  changes. Essential while tuning.
- **Velocity, not volume.** A hashtag at 10M posts that's flat is useless; one at 50K
  doubling daily is actionable.
- **Saturation penalty is the differentiator.** By the time a trend is everywhere, a small
  business posting it is late and looks like everyone else. Generic trend tools rank by
  popularity; we favor emerging.
- Only `EMERGING` and early `PEAKING` surface in the feed. Showing a declining trend wastes
  the user's week.

## Legal / ToS — settle before any collector ships

- Use official APIs wherever one exists. Scraping risks ToS violation and account
  termination — **including the accounts we publish from**, which matters far more than
  the trend feed.
- Store derived signals, not copies of other people's content.
- Real backoff on rate limits. Violations threaten the publishing integration.

## Acceptance criteria

- [ ] Trends can be curated manually and appear in the feed
- [ ] Scoring produces sensible velocity/momentum and lifecycle transitions over seeded signals
- [ ] Category mapping assigns plausible scores; low-confidence results flagged for review
- [ ] Feeds for brands in different categories differ substantially
- [ ] Every surfaced trend carries an explanation **and a concrete suggested angle** — a
      trend without a usable idea attached is just noise, and removing the blank-page
      problem is the whole point
- [ ] Re-running scoring over history is possible and tested
- [ ] One automated collector runs on a cron with backoff and rate-limit handling

## Notes

Resist scope creep. The temptation is to add collectors; the value is in scoring and
category mapping. One automated collector done well beats four done badly.
