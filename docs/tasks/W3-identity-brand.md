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

> **Q15 is resolved.** Rise & Shore and TaxDedux are separate *workspaces* — see
> [ADR-0010](../adr/0010-workspace-per-client.md) and
> [09-open-questions](../09-open-questions.md). The W2 seed already creates them that way,
> and "cross-tenant access" in the tests below therefore means both cross-workspace and
> cross-brand.

## Acceptance criteria

- [x] New user signs in → workspace + default brand created —
      `modules/identity/onboarding.ts`, called from the `isNewUser` branch of
      `findOrCreateGoogleUser`
- [x] Complete brand kit can be created, edited, and reloaded — `modules/brand/` and
      `routes/BrandKit.tsx`
- [x] Voice guide validates against the Zod schema and rejects malformed input — the
      schemas in `brand.schemas.ts` are the only validator; the update payload is
      `.strict()`, so an unknown key is a 422 rather than a silent drop
- [x] Logo upload lands in storage with a correct `Asset` row — `asset.service.ts`, via
      `platform/storage.ts`
- [x] Cross-brand access is denied (integration test) — `tests/db/tenancy.test.ts`
- [x] **Cross-workspace access is denied** (integration test) —
      `tests/db/tenancy.test.ts`, asserting a genuine 404 rather than an empty result
- [x] Switching brands changes the scoped data — `lib/ScopeProvider.tsx`; the scope is a
      query key, so a switch refetches rather than re-filtering on the client

### How scoping fails closed

ADR-0010 asks for a mechanism rather than a convention. `platform/tenancy.ts` wraps the
Prisma client in an extension that injects the tenant filter into every query against a
tenant model, and **throws** if such a model is reached without a scope. A route that
forgets to scope does not quietly go global; it raises `UnscopedTenantAccessError`. The
scope is AND-ed in, so a caller's own `where` cannot displace it.

Denial semantics, chosen deliberately: no membership → **404**, byte-identical to "no such
brand", because a 403 turns a brand id into an enumeration oracle. Insufficient *role*
within a workspace the caller can already see → **403**. 401 is resolved before tenancy, so
an anonymous caller learns nothing about which ids exist.

## Notes

The cross-brand authorization test is the important one. Getting tenancy wrong here is a
security bug, and every later workstream inherits this middleware.
