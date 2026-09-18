# `modules/identity/`

**Owner:** W3 · **Status:** implemented

## Responsibility

Who is signed in, what workspaces they belong to, and what they are allowed to do there.

- Google OAuth sign-in and the Passport wiring
- `User` lookup and first-login creation
- **W3:** `Workspace`, `Membership`, roles, invitations, and the authorization checks the
  rest of the product asks

## Boundaries

- Session mechanics — the cookie, the Postgres store, `trust proxy` — belong to
  `http/app.ts`. This module supplies the strategy and the serialize/deserialize hooks.
- Authorization decisions live here, not in route handlers. `requireAuth` in `http/`
  answers "is anyone signed in?" and nothing more; "may this user publish for this
  brand?" is a question for this module, so it can be tested without HTTP.
- No platform OAuth. A user's Instagram connection is a *credential*, and credentials
  belong to `modules/publish/`. Identity is about people, not about connected accounts.

## What M1 ported, and what it changed

From the prototype's `backend/src/auth.ts`:

- The callback URL is read from config, derived once. It had been recomputed in three
  files with a `https://your-app.herokuapp.com` fallback that booted happily.
- The allow list still works, but a denied sign-in no longer logs the email address.
- `/auth/me` returns an explicit projection. The prototype returned the `User` row
  verbatim, which on the old schema meant returning every stored OAuth token.

## First login

`findOrCreateGoogleUser`'s `isNewUser` branch calls `onboarding.ts`, which creates a
`Workspace`, an owning `Membership`, and a default `Brand` in one transaction. A user who
reaches the app without a workspace has nowhere to be, so this is not deferred to a
setup wizard.

`ensureWorkspace()` is the repair path for accounts that predate this — including the
M1 sign-ins that ran while the seam was still empty. It is idempotent.

## Authorization

`authorization.ts` is the tenancy boundary the rest of the product inherits.
`requireWorkspaceAccess` and `requireBrandAccess` resolve a caller's membership and return
a **pre-scoped** client (`platform/tenancy.ts`), not a boolean. Handlers therefore cannot
accidentally query outside the tenant: there is no unscoped client in reach.

- No membership → **404**, deliberately identical to "no such brand". A 403 would confirm
  that a brand id exists, which is an enumeration oracle.
- Membership with an insufficient role → **403**.
- Not signed in → **401**, resolved before any tenancy lookup.

Resolving a brand's `workspaceId` is the one read that is legitimately unscoped —
discovering a scope cannot itself require one. `User`, `Workspace` and `Membership` are
not tenant models for the same reason.

The Express adapters are `http/middleware/require-scope.ts`; they are thin on purpose, so
the decision is testable without a request.
