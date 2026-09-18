# 12 — Testing

Tests are part of done, not a follow-up. A change that cannot be verified is a change
nobody can safely modify later.

## Running them

```bash
npm test          # both workspaces, once
npm run test:watch
```

One command covers backend and frontend, because "did the tests pass?" should have one
answer. The two halves need different environments, so `vitest.workspace.ts` defines two
projects — `backend` on `node`, `frontend` on `jsdom` — rather than compromising on one.

## `npm test` must pass on a clean clone

No Postgres, no API keys, no `.env`. This is a hard rule: a suite that only runs on a
correctly-configured machine is a suite people stop running.

Two things make it hold.

**Fixed fake credentials.** `backend/tests/setup.ts` sets a complete, valid environment
before anything imports `platform/config`. The values are invented and constant. No test
reads a developer's `.env`, so a suite that passes locally passes in CI for the same
reasons.

**Database tests opt in.** They run only when `TEST_DATABASE_URL` is set, and skip
otherwise:

```ts
import { hasTestDatabase } from '../../tests/env';

describe.skipIf(!hasTestDatabase)('BrandRepository', () => {
  // ...
});
```

CI sets `TEST_DATABASE_URL`, so the skipped tests do run before anything merges. Locally:

```bash
createdb buzzalicious_test
TEST_DATABASE_URL=postgresql://localhost:5432/buzzalicious_test npm test
```

The database named there is truncated between tests. Never point it at one you care
about.

## What to test

The bar is **behaviour a future change could plausibly break**, not a coverage number.
Coverage measures which lines ran, which is not the same as which behaviours are pinned.

Worth a test:

- **Security boundaries.** That the error handler does not leak an upstream provider
  message. That tampered ciphertext fails. That a signed URL for one key does not work
  for another. These are the tests that justify the whole suite.
- **Config validation.** Every required variable, missing, individually. The prototype
  booted happily without `FRONTEND_URL` and redirected real users to
  `https://your-app.herokuapp.com`; that class of bug is now a failing test away.
- **Contracts between layers.** A `PlatformAdapter` implementation against the interface's
  expectations. A module's public function, not its internals.
- **Bugs.** Every fix gets the test that would have caught it, in the same commit.

Not worth a test: that a framework works, that a getter returns what was set, or the
exact wording of a string.

## Conventions

| Thing | Convention |
|-------|------------|
| Location | Beside the code, as `thing.test.ts`. Shared helpers live in `tests/`. |
| Naming | `it('rejects an expired signed URL')` — a sentence about behaviour, not `it('works')`. |
| Comments | Explain *why* a case matters when it is not obvious. A test asserting no token leaks should say what the leak would cost. |
| Isolation | No shared mutable state between tests. `loadConfig` takes its source as an argument precisely so tests never mutate `process.env`. |
| Network | Never. Mock at the module boundary, or test against the interface. |

## Layers

**Unit** — most of the suite. Pure functions and single classes: crypto, config,
prompts, key validation. Fast enough to run on save.

**Integration (HTTP)** — Supertest against `createApp()`. This is why the app factory is
separate from `index.ts`: tests mount the real middleware stack without binding a port or
starting a worker. Use these for status codes, auth boundaries, and error-body shape.

**Integration (database)** — real Postgres, opt-in as above. Use for anything where the
query is the thing being tested: cascade behaviour, unique constraints, transactional
credential writes.

**Frontend** — React Testing Library, queried the way a user perceives the page (roles and
text, not class names). `fetch` is stubbed; jsdom has no server to talk to.

## CI

`.github/workflows/ci.yml` runs install → type-check → lint → format → test → build on
every pull request, with a Postgres service and `TEST_DATABASE_URL` set. Build is last: it
is the slowest step and the least likely to be the thing that is broken.

CI holds fixed fake credentials only. A real one must never appear in the workflow file,
in a repository secret used by tests, or in a fixture.

## Current state (end of M1)

95 tests across 8 files: crypto round-trip and tamper detection, config validation, the
storage driver and its signed URLs, the HTTP error boundary and app smoke tests, the AI
prompt and parse layer, and the frontend auth guard and API client.

No database tests exist yet — there are no models until W2. The CI Postgres service and
the `TEST_DATABASE_URL` convention are in place so that W2 can add them without also
having to work out how to run them.
