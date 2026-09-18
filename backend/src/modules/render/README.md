# `modules/render/`

**Owner:** W4 · **Status:** implemented

## Responsibility

Turning a template plus brand styling plus slot values into a PNG, via Satori → resvg
(ADR-0002). Implements the `Renderer` interface in
[docs/01-architecture.md](../../../../docs/01-architecture.md).

## Boundaries

- Rendering is **deterministic**. The same inputs produce the same bytes. This is what
  replaced Canva and generative images: a design that only renders once is not a design,
  it is a lottery ticket.
- Output goes to `platform/storage.ts` and is referenced by key. Rendered bytes must
  never be written to the dyno filesystem — Heroku wipes it on every restart.
- Rendering is CPU-bound and belongs in the worker process, not on a request thread.
- Fonts must be loaded explicitly; Satori has no system font fallback. A missing font is
  a blank image, not an error, so font loading failures must be raised loudly.

## What is here

| File | Responsibility |
|------|----------------|
| `renderer.ts` | The `Renderer` interface and the four rendition specs |
| `satori-renderer.ts` | Satori → resvg → sharp, and the preview path |
| `fonts.ts` | The curated set, metrics and Satori family naming |
| `emoji.ts` | Twemoji lookup and the `loadAdditionalAsset` hook |
| `text.ts` | Grapheme segmentation and the unrenderable-text check |
| `measure.ts` | Measurement, wrapping and the `$fit` binary search |
| `safe-area.ts` | The three-layer safe-area merge |
| `bindings.ts` | `$brand` / `$slot` / `$scale` / `$fit` resolution |
| `compile.ts` | Layout JSON → Satori element tree |
| `assets.ts` | Image preparation and asset resolution |
| `render.service.ts` | Orchestration, caching, storage, `Rendition` rows |

`fonts.ts` exports **`CURATED_FONTS`, which W3's typography picker imports.** It is a
cross-workstream contract: changing a family name or dropping a weight changes what brands
can select. Add rather than remove.

## Things that will bite you

Each is commented where it matters, and all three are written up in
[docs/05](../../../../docs/05-template-engine.md#three-satori-font-traps-all-of-which-cost-real-time).

- **Never use a variable font.** Satori's bundled opentype fork throws on `fvar`. The
  renderer dies; it does not degrade.
- **`latin` and `latin-ext` are complementary, not nested.** Both subsets ship per weight.
- **The two subsets must be registered under different family names**, joined by a CSS
  fallback list, and names with spaces must be quoted.

Assets are vendored offline (`npm run fonts:vendor`, `npm run emoji:vendor`) and committed.
The render path never fetches anything and never parses a font to measure — it reads
`assets/fonts/metrics.json`, generated at vendor time.

## Failure is loud, on purpose

Two conditions return an error rather than an image:

- **Overflow** (`RenderOverflowError`) — text that cannot fit its box even at the `$fit`
  minimum. Silent clipping produces a technically-successful render that is unusable, and
  nothing surfaces it.
- **Unrenderable text** (`UnrenderableTextError`) — a character no loaded font covers and
  that is not an emoji. Satori would draw a filled box and return success.

The preview endpoint is the deliberate exception: it *reports* overflow instead of
throwing, because the composer wants to show the problem while the user is still typing.

## A text-only post has no renditions

`renderPost` returns `[]` for `MediaType.TEXT`. This is not an edge case to tolerate — it
is how a plain X or Threads post works, and W2 seeded such posts so the path cannot be
assumed away.
