# `modules/brand/`

**Owner:** W3 · **Status:** scaffold

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

## Notes

The prototype had no brand concept at all — content was attached directly to a user, and
per-platform identity was a set of columns on `User`. Everything here is new.
