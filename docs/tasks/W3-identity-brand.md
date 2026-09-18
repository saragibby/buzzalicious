# W3 — Identity, tenancy, brand kit

**Depends on:** W2 · **Blocks:** W5, W6

**Read first:** [02 — Data model](../02-data-model.md), [ADR-0008](../adr/0008-brand-first-class.md)

## Goal

A user can sign in, gets a workspace, and can build a complete brand kit — logo, colors,
typography, category, target platforms, and an authored voice guide.

## Scope

### Identity
- Google OAuth completes the port from W1. On first login, create `Workspace` +
  `Membership` (role `OWNER`) and a default `Brand`.
- Session-based auth against the Postgres store.

### Authorization
- Middleware resolving **brand scope**, not just authentication: `requireBrand` loads the
  brand, verifies the user's membership, and attaches it to the request.
- Every brand-scoped route uses it. A route that can't be brand-scoped needs justification.

### Brand kit API + UI
- CRUD for `Brand`.
- Palette editor — primary, secondary, accent, neutral, background, text. Offer extraction
  from an uploaded logo as a nicety.
- Typography selection from the curated font set W4 ships.
- Business category picker over the seeded taxonomy — searchable, two-level.
- Target platform selection.
- **Voice guide editor.** The PRD is explicit that this is a real guide, not a one-line
  descriptor: summary, tone attributes, do-say / don't-say, vocabulary, sample copy,
  reading level, emoji policy. Validate against W2's Zod schema.
  - Offer AI-assisted drafting from the website URL + category, always user-editable.

### Assets
- Upload to R2 via W0's `StorageDriver`. Validate MIME and size; strip EXIF.
- `sharp` preprocessing: dimensions, thumbnails, format normalization.
- A simple asset library view, filterable by `AssetKind`.

### Brand switcher
- Minimal switcher in the app shell (see [Q11](../09-open-questions.md)). The two dogfood
  brands need it.

### Not in scope
Credential onboarding UI belongs to **W6** ([10](../10-credentials-and-security.md)), but
its tenancy depends on this workstream: credentials are scopeable at both workspace and
brand level, so `requireBrand` and the workspace-membership check must both be solid before
W6 builds on them.

> **Blocked on [Q15](../09-open-questions.md):** whether Rise & Shore and TaxDedux are
> separate workspaces or brands in one workspace. It changes seed data, the switcher, and
> what "cross-tenant access" means in the test below. Resolve before building the switcher.

## Acceptance criteria

- [ ] New user signs in → workspace + default brand created
- [ ] Complete brand kit can be created, edited, and reloaded
- [ ] Voice guide validates against the Zod schema and rejects malformed input
- [ ] Logo upload lands in storage with a correct `Asset` row
- [ ] Cross-brand access is denied (integration test)
- [ ] **Cross-workspace access is denied** (integration test)
- [ ] Switching brands changes the scoped data

## Notes

The cross-brand authorization test is the important one. Getting tenancy wrong here is a
security bug, and every later workstream inherits this middleware.
