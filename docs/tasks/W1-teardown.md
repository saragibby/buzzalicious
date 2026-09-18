# W1 — Teardown

**Depends on:** nothing · **Parallel with:** W0 · **Blocks:** W2

**Read first:** [03 — Teardown plan](../03-teardown.md), [ADR-0001](../adr/0001-clean-foundation-reset.md)

## Goal

Remove the old product's code and scaffold the new module structure, without losing the
integration knowledge embedded in what's deleted.

## Scope

### Step 1 — Harvest (do this first, same PR)

Create `docs/reference/` and capture, clearly marked as dead code:

- X OAuth 1.0a request-token → access-token sequence from `social.routes.ts`
- LinkedIn OAuth + UGC post payload shape from `linkedin.service.ts`
- Scheduled-post status transitions from `scheduler.service.ts`
- Platform quirks: redirect URI handling, token expiry behavior, and the deployed-env
  redirect fixes visible in git history

Also move the useful parts of `TWITTER_INTEGRATION.md` into
[08 — Platform integrations](../08-platform-integrations.md).

### Step 2 — Delete

Per the disposition table in [03](../03-teardown.md). Backend: `social.routes.ts`,
`ai.routes.ts`, `schedule.routes.ts`, `canva.service.ts`, `scheduler.service.ts`.
Frontend: `AIGenerator`, `Analytics`, `Profile`, `ScheduledPosts` and their CSS.
Root: `AI_INTEGRATION.md`, `TWITTER_INTEGRATION.md`.
Prisma: all 14 migrations, `migrate-social-data.sql`.

### Step 3 — Port

- `services/ai/*` → `backend/src/modules/ai/`. Extend with a `purpose` field and
  structured-output support. **Drop image generation** — Satori replaces it.
- `services/twitter.service.ts` → kept for W6 to reshape into the `X` adapter.
- `auth.ts` → `modules/identity/`. Must create a `Workspace` + `Membership` on first login
  (W3 completes this).
- `linkedin.service.ts` → `docs/reference/` only. Do **not** carry into `modules/publish/`.

### Step 4 — Scaffold

Create the structure from [01 — Architecture](../01-architecture.md):
`http/{routes,middleware}`, `modules/{identity,brand,template,render,publish,trend,insight,recommend,ai}`,
`jobs/`, `platform/`, `types/`.

Add a `README.md` in each module folder stating its responsibility and boundaries.

### Step 5 — Frontend shell

React Router with an auth guard; TanStack Query provider. Delete the tab-state navigation.
Keep `logo.png` and the favicons. Placeholder routes only — W5 builds the real UI.

### Step 6 — Root README

Rewrite to describe the new product, setup, and a pointer to `docs/`.

## Acceptance criteria

- [x] No reference to Canva, `setInterval` scheduling, or free-prompt AI generation
      remains. Canva's service, routes, columns-in-use and frontend component are gone;
      `docs/reference/canva.md` keeps the integration knowledge for the record. The one
      surviving `setInterval` is a keep-alive in `worker.ts` holding the event loop open
      for a process that listens on no socket — not scheduling.
- [x] The four old frontend components are gone
- [x] `prisma/migrations/` is empty (W2 adds `0001_init`) — only `migration_lock.toml`
      remains, which Prisma requires
- [x] The app builds and boots; Google sign-in works
- [x] `docs/reference/` captures the harvested knowledge — six pages, written and
      committed **before** the deletions in the same commit
- [x] Root `README.md` is accurate

## Notes

Harvest **before** deleting, in the same PR, so review can verify nothing was lost.
