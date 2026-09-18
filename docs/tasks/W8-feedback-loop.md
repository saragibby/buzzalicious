# W8 — Feedback loop v0

**Depends on:** W4, W7 · **Blocks:** nothing (M6 exit)

**Read first:** [06 — Outcome & feedback loop](../06-outcome-and-feedback-loop.md)

## Goal

The PRD's P0: *"surface the user's best-performing template types, and bias future
defaults toward them"* — while also serving the cold-start case: *"As a brand-new user
with no performance history yet, I want useful recommendations from day one."*

Those two requirements together rule out ranking by average score.

## Scope

### Shrinkage scoring

```
score(b, a) = ( n(b,a) · observed(b,a) + k · prior(category(b), a) ) / ( n(b,a) + k )
```

Start with `k = 5`, in config. Priors come from aggregate category performance, falling
back to hand-seeded `BusinessCategory.priors` when data is thin.

~15 lines of code, no training pipeline, explainable in one sentence. A learned model must
beat this baseline to justify itself — don't start there.

### Recommendation API
Ranked templates for a brand, each with a **structured explanation payload** so the UI can
render "why this" without re-deriving the reasoning.

### Guardrails — all three are required
- **Escape hatch.** Never collapse the gallery to recommendations only. `template
  acceptance rate` is a success metric and needs alternatives to exist.
- **Exploration.** Reserve ~20% of slots for untried templates. Pure exploitation
  converges on a local maximum and makes every feed look identical — the exact Predis.ai
  failure this product exists to beat.
- **Minimum sample.** Under 5 posts with an archetype, show the category framing, not a
  brand-specific claim.

### Composer surfacing
> **Recommended for you** — *Before/After* posts drove **2.4× more link clicks** than your
> average over your last 12 posts.

Cold start:
> **Popular with coffee shops** — *Behind the Scenes* templates perform well for
> businesses like yours.

Making the reasoning visible is the difference between "the tool reordered some tiles" and
"the tool is learning my business." It also surfaces the honest failure mode early: when
the explanation looks wrong to the user, we find out.

### Insights
"What's working" summary driven by the same scoring that powers recommendations, so the
two can never disagree.

### Send-time and cadence learning

Same shrinkage function, different dimension. Full design in
[06](../06-outcome-and-feedback-loop.md#send-time-and-cadence-learning).

- **Start with 8 coarse slots** (weekday/weekend × 4 dayparts), not 168 day-hour buckets.
  Getting the granularity right matters more than the formula — 168 buckets never
  accumulate enough observations to learn from.
- Cold-start priors stack: the brand's own `LinkClick` time histogram → category priors →
  hand-seeded platform defaults.
- **Exploration matters more here than for templates.** A pure-exploitation scheduler
  generates no observations outside its current slot, so the first lucky time becomes
  permanent. Reserve 20–30% for under-sampled slots and prefer high-uncertainty ones.
- Tag exploration posts `scheduleSource = EXPLORATION` and suggested-and-accepted ones
  `SUGGESTED`. Without this the loop trains on its own suggestions.
- **Cadence is scored on total weekly outcome, not per-post average.** Per-post average
  optimizes toward posting almost never, which scores well and grows nothing.
- Cadence is advisory in v1 — suggest a range, never auto-schedule into it.
- Respect quiet hours in the *audience's* timezone unless explicitly opted in.

## Acceptance criteria

- [ ] A brand with 0 posts gets category-prior recommendations
- [ ] A brand with a strong history gets visibly different ordering (test with seeded data)
- [ ] One outlier post cannot dominate ranking at low `n`
- [ ] Exploration slots appear in every result set
- [ ] Claims below the sample threshold fall back to category framing
- [ ] Explanations are accurate against the underlying numbers
- [ ] Weights and `k` are config, not constants
- [ ] A brand with no post history still gets a defensible suggested time
- [ ] Suggested times are correct across a DST boundary (test explicitly)
- [ ] Exploration posts are tagged and excluded from being treated as user preference

## Notes

**The demo that proves phase 1:** Rise & Shore and TaxDedux must receive genuinely
different recommendations, and both must differ from a cold-start brand. Build toward
being able to show that.
