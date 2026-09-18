# `modules/identity/`

**Owner:** W3 · **Status:** partial (sign-in ported in W0/M1)

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

## The W3 seam

`findOrCreateGoogleUser` marks where first login must also create a `Workspace` and an
owning `Membership`. It could not be done in M1: those models do not exist until W2
writes them, and `prisma/schema.prisma` is W2's exclusively. The `isNewUser` branch is
the hook point.
