# `modules/brand/`

**Owner:** W3 · **Status:** implemented

## Responsibility

The brand as a first-class object (ADR-0008): voice, palette, typography, logo and other
assets, plus the per-platform handles a brand publishes under. One workspace may hold
several brands, and an agency managing five clients is the normal case, not an edge case.

## Boundaries

- A brand belongs to a workspace. Every query here is scoped by workspace; an unscoped
  read is a cross-tenant data leak, not a performance note.
- Brand *assets* are bytes in object storage. This module owns the metadata and the
  storage key; `platform/storage.ts` owns the bytes.
- Rendering is `modules/render/`. This module supplies the palette and fonts a template
  consumes; it does not know what a PNG is.

## What is here

- `brand.service.ts` — CRUD and the view projection. Create and update payloads are
  `.strict()`, so an unrecognised key is a 422 rather than a silent no-op.
- `brand.schemas.ts` (W2) — the only validators for the JSON columns. Do not write a
  parallel set.
- `asset.service.ts` — upload, thumbnail, delete. Images are re-encoded through `sharp`,
  which strips EXIF (location data in a logo is a real leak) and applies the orientation
  tag rather than trusting a viewer to. SVG is refused: it is a script-carrying document,
  not an image.
- `category.service.ts` — the industry taxonomy. Reference data, so it is served through a
  null scope, which still throws on any tenant model.
- `palette.ts` — extracts a starting palette from an uploaded logo. A suggestion; the user
  edits it.
- `voice.service.ts` — drafts a structured voice guide via `modules/ai`. The result is
  validated against the same Zod schema as a hand-written one.
- `fonts.ts` — **a placeholder.** The brief says typography is chosen from the curated set
  W4 ships; W4 has not landed one yet, so this holds only the families the seed uses.
  Replace it with W4's catalogue, do not grow it here. Licensing is Q19.

Typography is a closed set rather than free text because Satori has no system fallback: an
unresolvable family renders a *blank image* instead of raising.

## Notes

The prototype had no brand concept at all — content was attached directly to a user, and
per-platform identity was a set of columns on `User`. Everything here is new.
