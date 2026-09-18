# W4 — Template engine & rendering

**Depends on:** W2 · **Parallel with:** W3 · **Blocks:** W5, W8

**Read first:** [05 — Template engine](../05-template-engine.md), [ADR-0002](../adr/0002-satori-template-rendering.md)

> **Highest-risk workstream in phase 1.** Follow the build order and stop at the
> checkpoint.

## Goal

`render(template, brandKit, slotValues, aspectRatio) → PNG`, producing four
platform-native renditions from one layout definition.

## Build order

1. **`Renderer` interface + Satori implementation for one hardcoded template, one ratio.**
   **⛔ STOP HERE and review output quality with Sara before continuing.** If the visuals
   aren't there, the approach needs revisiting before another seven steps are spent.
2. Font loading and caching — explicit buffers, curated set, loaded once at worker start.
   **Decide the emoji strategy now** ([Q9](../09-open-questions.md)), not after templates
   are authored.
3. Layout compiler: JSON → Satori element tree, resolving `$brand.*` and `$slot.*` bindings.
4. Responsive primitives `$scale(n)` and `$fit(max, min)` + multi-ratio output. **This is
   what makes one layout serve four ratios** — without it, template authoring cost
   quadruples.
5. Safe-area enforcement per ratio (Stories overlay the top ~8% / bottom ~12%).
6. resvg → PNG → `sharp` optimize → R2, persisting `Rendition` rows. Cache on
   `(templateId, templateVersion, brandId, hash(slotValues), ratio)`.
7. Author the remaining seed templates — 8–12 across the archetype table in
   [05](../05-template-engine.md).
8. Category tagging + the relevance ranking query: given a brand category, rank templates
   by `TemplateCategoryTag.weight` with parent-category inheritance.

## Also in scope

- Low-resolution preview mode for the composer (SVG, no rasterization).
- Render-time overflow detection that **fails loudly** rather than silently clipping text.
- Template registry API: list, filter by category, fetch with slot schema.

## Acceptance criteria

- [ ] A seeded template renders with a real brand kit into 1:1, 4:5, 9:16, and 16:9 PNGs
- [ ] Renditions land in storage with correct `Rendition` rows
- [ ] Single rendition < 300ms p95; four < 1s p95 (asserted in a test)
- [ ] `$fit` prevents overflow at max-length slot input across all four ratios
- [ ] Safe areas respected in 9:16
- [ ] Cache hit avoids a re-render
- [ ] Relevance query returns different rankings for different brand categories
- [ ] Emoji render correctly, or the chosen limitation is documented

## Coordinate with

**W2** on `layout` / `slotSchema` JSON shape (W2 seeds templates using it).
**W5** on the preview API contract.

## Notes

Font handling and text measurement are where Satori estimates usually break. Budget time
there. Visual quality at step 1 is the gate for the whole approach — don't skip the
checkpoint.
