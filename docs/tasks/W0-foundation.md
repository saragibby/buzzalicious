# W0 — Foundation & hygiene

**Depends on:** nothing · **Parallel with:** W1 · **Blocks:** everything

**Read first:** [01 — Architecture](../01-architecture.md)

## Goal

Make the repo a place where the rest of phase 1 can be built safely. No product features.

## Scope

### Config
- `backend/src/platform/config.ts` — Zod schema for every env var, parsed once at boot.
- The process **refuses to start** on missing/invalid required vars. Remove every silent
  fallback (`'your-secret-key'`, `'https://your-app.herokuapp.com'`).
- Update `.env.example` for both workspaces with descriptions and no real values.

### Logging
- Pino + `pino-http`, structured JSON, request IDs propagated into job context.
- **Redact tokens, secrets, emails, and IPs.** The prototype logs session contents.
- Replace every `console.log`.

### Errors
- Typed `AppError` hierarchy (`ValidationError`, `NotFoundError`, `AuthError`,
  `ExternalServiceError`, `RateLimitError`).
- One error middleware, registered last. Never leak internals to clients.

### Crypto
- `backend/src/platform/crypto.ts` — AES-256-GCM encrypt/decrypt with a key from config.
- Versioned ciphertext prefix so keys can be rotated.
- Used by W6 for OAuth tokens; must exist first.

### Storage
- `StorageDriver` interface with an R2 (S3-compatible) driver and a local-filesystem driver
  for development, selected by config. Local dev must never need R2 credentials.
- Support signed, time-limited URLs — Meta fetches media by URL.

### Sessions
- Move off MemoryStore to `connect-pg-simple` (already a dependency, unused).

### Lint / format
- Flat ESLint config at the repo root covering both workspaces. **The `lint` scripts
  currently fail because no config file exists.**
- Prettier + an `.editorconfig`.

### Tests
- Vitest at the root, projects for both workspaces. Supertest for HTTP.
- A documented pattern for DB-backed integration tests.
- One meaningful test per layer as a reference example.

### CI
- GitHub Actions on PR: install, typecheck, lint, test, build. All must pass.

### Rate limiting
- `express-rate-limit` on auth routes; the config for short-link and AI routes wired but
  unused until W6/W7.

## Files you own

`backend/src/platform/**`, root ESLint/Prettier/Vitest config, `.github/workflows/**`,
`package.json` scripts, `.env.example`.

## Acceptance criteria

- [x] `npm run lint`, `npm run type-check`, `npm test`, `npm run build` all pass at root
- [x] CI green on a PR — `.github/workflows/ci.yml`, with a Postgres service and a
      `format:check` step added beyond the four gates
- [x] Boot fails loudly with a clear message when a required env var is missing —
      `platform/boot.ts` prints every problem at once, deduped and sorted, and exits 1;
      covered by `platform/config.test.ts`
- [x] No `console.log` in `backend/src` — ESLint `no-console` enforces it; the only
      remaining occurrences are prose in comments describing what was removed
- [x] Round-trip unit test for crypto; storage driver test against the local driver —
      `platform/crypto.test.ts` (round trip, tamper detection, key rotation, opaque
      failure) and `platform/storage.test.ts` (put/get, signed URL expiry and forgery)
- [x] Sessions survive a server restart — `connect-pg-simple` backs the session store;
      the prototype's MemoryStore lost every session on deploy

## Out of scope

Domain models, product features, UI work.
