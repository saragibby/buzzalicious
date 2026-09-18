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

The schema is applied automatically. `backend/tests/global-setup.ts` runs
`prisma migrate deploy` before the suite whenever `TEST_DATABASE_URL` is set, and does
nothing when it is not. Deliberately `migrate deploy` and not `migrate dev`: it is the
same command the Procfile runs on release, so every test run rehearses the deploy path
rather than only the local one. Create the database; do not migrate it by hand.

Database tests own their fixtures. Backend test files run one at a time
(`fileParallelism: false`) because they share one Postgres, but that only removes
interleaving, not interference — a test that deletes rows another file expects still
breaks it. Create what you need under a unique name and clean it up, as
`tests/db/schema.test.ts` does. Seeded data is the exception: it is idempotent and may be
read by anything.

Never point `TEST_DATABASE_URL` at a database you care about.

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

There is no separate migration step, and there should not be one: the global setup applies
migrations, so the database tests and the deploy-path rehearsal cannot drift apart.

CI holds no credentials at all, real or fake. The test environment lives in
`backend/tests/setup.ts` and nowhere else — every variable there is assigned with `??=`,
so anything the workflow exports silently overrides it. The workflow sets only
`TEST_DATABASE_URL`, which is the one thing `setup.ts` cannot know.

This is not a style preference. The first version of the workflow duplicated the whole
fake environment and mistyped `ENCRYPTION_KEY` by four characters; CI then fed that
invalid key to every test and the suite failed in a way that passed locally. One
definition of the test environment, or two that disagree.

## Current state (end of M2)

217 tests across 19 files.

Running without a database, 193 of them: crypto round-trip and tamper detection, the
Prisma encryption extension against a mock, config validation, the storage driver and its
signed URLs, local-to-UTC time conversion across DST, the HTTP error boundary and app
smoke tests, the AI prompt and parse layer, every JSON column's Zod contract, and the
frontend auth guard and API client.

With `TEST_DATABASE_URL` set, 24 more in `backend/tests/db/`:

- **`encryption.test.ts`** — that the stored column is ciphertext, asserted with
  `$queryRaw` against the raw value. A round-trip through our own codec passes even when
  the column holds plaintext, so this is the assertion that actually means something. Also
  covers the version prefix, decryption through a relation `include`, re-encryption
  idempotence, the refusal to filter on an encrypted column, and tamper detection.
- **`schema.test.ts`** — workspace cascade delete, the uniqueness constraints downstream
  code relies on instead of checking for duplicates itself, `SetNull` on a retired
  template, and the ADR-0010 tenancy boundary read out of `information_schema`.
- **`seed.test.ts`** — idempotence, two separate workspaces, unmistakably fake
  credentials, all eight send-time slots covered per brand with genuinely different
  shapes, text posts with zero renditions, a schedule that crosses a DST boundary, and
  `PostMetric.linkClicks` agreeing with the `LinkClick` rows it was derived from.
