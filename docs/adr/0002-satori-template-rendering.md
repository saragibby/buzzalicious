# ADR-0002 — Satori for template rendering

**Date:** 2026-09-17 · **Status:** Accepted

## Context

The v1 PRD requires auto-populating a template with the user's photos, copy, and brand kit,
then exporting in the correct format per platform. The spec never defines what a template
*is* technically — this is the largest unresolved scope question in v1 and the single
biggest build risk.

## Options

1. **Canva Connect API** — reuse the existing integration and Canva's template library.
2. **Headless browser** (Puppeteer/Playwright) rendering HTML/CSS to PNG.
3. **Satori + resvg** — HTML/CSS-like JSX → SVG → PNG, no browser.
4. **In-browser canvas editor** (Polotno/Fabric.js) — user edits, client exports.
5. **Text/caption only** — no visual generation in v1.

## Decision

**Option 3.** Templates are JSON layout definitions compiled to a Satori element tree,
rendered to SVG, rasterized by `@resvg/resvg-js`, optimized with `sharp`, and stored in R2
as `Rendition` rows.

Keep the `Renderer` interface open so Puppeteer can be added later for a complex-template
tier, and so video/motion renderers (v2/v3) implement the same contract.

## Rationale

- **Cost and speed.** ~10–50ms and ~50–100MB per render versus ~200–800ms and 300MB+ for
  Chromium. Every post produces four renditions and previews re-render on edit, so this
  difference decides whether live preview is feasible at all.
- **Ownership.** Canva would put our core differentiator — template relevance and
  auto-population — behind someone else's API, rate limits, and roadmap. The wedge depends
  on controlling template metadata and category tagging.
- **Determinism.** No browser or font-version drift between environments.
- **Infrastructure.** Runs in a plain Node container; no Chromium system dependencies.
- Option 4 shifts work back to the user, contradicting the "no design skill required"
  premise. Option 5 abandons a P0 requirement.

## Consequences

- Templates must be authored within Satori's CSS subset: flexbox only, no grid, limited
  filters, no `position` in some cases.
- Fonts must be loaded as explicit buffers; emoji require a dedicated strategy (see
  [Q9](../09-open-questions.md)).
- Responsive primitives (`$scale`, `$fit`) are needed so one layout serves four aspect
  ratios — otherwise template authoring cost quadruples.
- Visual quality must be validated on the very first template before building further.
- Meta's publishing API fetches media by URL, so renditions need signed, time-limited
  public URLs.
