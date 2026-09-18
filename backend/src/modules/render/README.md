# `modules/render/`

**Owner:** W4 · **Status:** scaffold

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
