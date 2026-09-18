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

### After merging anything, re-sync the environment before believing the result

Two failure modes here both present as something other than a failure:

- **A merged schema change leaves a stale Prisma client.** The suite reports
  **"no tests found"**. That is a *collection* failure, not a pass — the files never
  loaded because the generated client lacks a new enum or model. Run `npx prisma generate`.
- **A merged dependency is missing locally.** The W6 spine added `pg-boss`; before
  `npm install`, five files failed to load with `Failed to load url pg-boss`, while the
  summary still read `559 passed` with **zero failures**. Passing test *counts* mean
  nothing if the file count is short — always read `Test Files` alongside `Tests`.

So after any merge: `npm install && npx prisma generate`, then compare the **file and
test totals** against what the branch reported. A drop in totals with no red is the
signature of both bugs.

## `npm test` must pass on a clean clone

No Postgres, no API keys, no `.env`. This is a hard rule: a suite that only runs on a
correctly-configured machine is a suite people stop running.

Two things make it hold.

**Fixed fake credentials.** `backend/tests/env.ts` sets a complete, valid environment
before anything imports `platform/config`. The values are invented and constant.

Most are assigned with `??=`, so the workflow or a developer can override them. **Anything
that authenticates against a third party is not** — provider credentials are overwritten
unconditionally, even when already set. That asymmetry is the whole point: `backend/.env`
is gitignored and loaded before the tests run, so a developer has real keys where CI has
none, and the suite diverges per machine in the one direction nobody checks.

It is not hypothetical. `tests/db/trend.test.ts` drives `mapTrend` → `classifyWithLlm`,
which calls a provider for real. With a live `OPENAI_API_KEY` present, that file took 41s
and timed out two tests; with fakes it takes 3s and passes — and every run in between was
issuing billable requests to OpenAI. The failure looked like flakiness, which is why it
survived four merges.

**A test must not be able to reach a third-party API.** Anything outbound belongs behind a
stub. New provider credentials go in the forced list in `env.ts`, not the `??=` block, and
`tests/env.test.ts` asserts a real-looking key is replaced rather than deferred to.

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

The schema and seed are applied automatically. `backend/tests/global-setup.ts` runs
`prisma migrate deploy` and then the seed before the suite whenever `TEST_DATABASE_URL`
is set, and does nothing when it is not. Deliberately `migrate deploy` and not
`migrate dev`: it is the same command the Procfile runs on release, so every test run
rehearses the deploy path rather than only the local one. Create the database; do not
migrate or seed it by hand.

Seeding in global setup is load-bearing, not a convenience. It used to happen only as a
side effect of `seed.test.ts` calling `seedAll`, which made every other database test's
data depend on **file execution order** — a file sorting before `seed.test.ts` saw an
empty database and failed on a cold one while passing on any database a previous run had
touched. If a database test needs seeded data, read it; never seed from a `beforeAll`,
and never depend on another test file having run first.

Database tests own their fixtures. Backend test files run one at a time
(`fileParallelism: false`) because they share one Postgres, but that only removes
interleaving, not interference — a test that deletes rows another file expects still
breaks it. Create what you need under a unique name and clean it up, as
`tests/db/schema.test.ts` does. Seeded data is the exception: it is idempotent and may be
read by anything.

Never point `TEST_DATABASE_URL` at a database you care about.

**Bind timestamps into raw SQL as UTC text, never as a `Date`.** Prisma serializes a
raw-bound `Date` in the *process's* local zone, so a `timestamp without time zone` column
written by `$executeRaw` lands at a different instant than the same value written through
the query builder. W10 hit this: rollup rows sat four hours before the ledger rows they
summarised, every lookup by period missed, and the whole thing would have been green on a
UTC host — which CI is. Pass `date.toISOString()` and cast
`::timestamptz AT TIME ZONE 'UTC'`, and assert against a literal instant rather than
against the other code path, since comparing two shifted paths to each other passes.

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

### Tenancy rules: cover the shape of the row, not just the scope kind

Two real leaks have now shipped past tenancy tests that looked thorough. Both had the
same root, and the rule below is what actually catches them.

**`{}` in a `ScopeRule` is *no filter*, not a deny.** A broken rule returns *more* rows,
never fewer. So every assertion shaped like "returns 0 rows", "throws", or any count
check **passes under the bug**. Assert on **identity** — `toContain` / `not.toContain` on
specific ids — and make sure another tenant's rows are genuinely present in the database
at the moment of the read. A test that would pass against an empty table proves nothing.

**If a rule reaches through a relation, scope-kind coverage is necessary but not
sufficient.** W10's rollup leak was invisible to a workspace-scoped test because the bug
was in the *brand* rule — that one is caught by covering both scope kinds. W6's
`OAuthHandshake` leak passed tests that *already* covered **both** kinds, because both
fixtures used a brand-scoped credential and the leak only opened when the related
credential had `brandId: null`.

The missing axis there was not the scope kind. It was **the shape of the row being scoped
through**. So:

> When a rule filters through a relation — `{ credential: { workspaceId } }`,
> `{ post: { brandId } }` — write a fixture for **every shape that relation can take**,
> especially the **nullable-FK** shape. A nullable owner column is where sharing
> semantics live, and therefore where the leak is.

Concretely, a workspace-shared credential has `brandId: null`. Scoping a child row
through `{ credential: { OR: [{ brandId }, { brandId: null }] } }` reads as "my brand's
credentials plus shared ones" and is wrong: every sibling brand matches the shared arm
and sees each other's in-flight rows. Prefer the row's **own** `brandId` when the child
row has one, and write the test with two brands sharing one workspace-level credential.

### Make the negative case prove itself

The single most common way work has gone wrong on this project is **absence of evidence
rendered as evidence of absence** — something stayed quiet, and the quiet was read as a
pass. It has arrived in four different disguises, none of which looked like the others at
the time:

- **A probe that matched nothing.** A mutation applied with
  `sed -i '' "0,/.../s//.../"` silently changed no bytes. "No error" was read as "the
  code does not catch this", when the truth was "the mutation never ran".
- **An assertion whose premise was never met.** A guard test written against a Zod
  `too_big` issue, which never carries the submitted value. It passed no matter what the
  code did. Rewritten against `invalid_enum_value` it failed immediately — and that
  failure is the only reason a live value-echo leak was found.
- **A comment asserting a property the code did not have.** `normalizeError`'s doc
  comment claimed `details` "carries no received values", which was false. Worse than an
  untested guard: an untested guard lets one bug through, a wrongly asserted one makes
  every future reader stop checking.
- **An empty probe output.** stdout captured nothing while checking whether rejected
  values reach the logs. Empty output is equally consistent with "no leak" and "the probe
  never observed the right stream", so it established nothing and the question stays open.

In every one of the four, **the negative result was indistinguishable from a
non-result**. That is the whole trap, and it gives the rule a form you can check on
review rather than merely be warned by:

> **A test or probe must be able to tell "this didn't happen" apart from "this didn't
> run". If it cannot, its silence means nothing.**

Ask it of any new assertion: *if the code under test were never reached at all, would
this still be green?* If yes, it is not evidence yet.

The defences are mechanical, and they are cheap:

> **Every guard needs a positive control** — an assertion that fails if the fixture never
> reached the code path. If a test would still pass against an empty table, a skipped
> mutation, or an unreached branch, it is not testing anything.
>
> **Every tool must distinguish "clean" from "did nothing".** A mutation harness prints
> `NOMATCH` and exits non-zero rather than reporting a clean run — the original bug was
> that "applied nothing" and "applied cleanly" shared an exit code.
>
> **Observe the stream you actually mean, and prove you can see it.** To show a value
> does *not* reach the logs, first assert a known sentinel **is** present on a known-good
> path, then assert the suspect value is absent on the same captured **pino destination
> stream** — not stdout. Without the known-good half you have only proved your probe is
> quiet, which is what stdout capture already did.
>
> **Never let prose stand in for a test.** A claim about behaviour belongs in an
> assertion; in prose only, it is unverified by construction. If it must stay prose, it
> has to say plainly that it is unverified.

This is the same root as the recurring "tests that pass for the wrong reason" trap, and
it is why every new assertion on this project is mutation-tested: breaking the thing a
test protects, and confirming it goes red, is the only evidence that the green was ever
load-bearing.

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
`backend/tests/env.ts` and nowhere else — the general variables there are assigned with
`??=`, so anything the workflow exports silently overrides it. The workflow sets only
`TEST_DATABASE_URL`, which is the one thing `env.ts` cannot know. Provider credentials are
the deliberate exception and cannot be overridden; see above.

This is not a style preference. The first version of the workflow duplicated the whole
fake environment and mistyped `ENCRYPTION_KEY` by four characters; CI then fed that
invalid key to every test and the suite failed in a way that passed locally. One
definition of the test environment, or two that disagree.

### A pull request opened while conflicted gets no CI at all

`pull_request` workflows run against `refs/pull/N/merge`, and GitHub only creates that ref
when the PR merges cleanly. Open a PR that already conflicts with its base and the ref
never exists, so **no run is ever scheduled** — not queued, not failed, not pending.
The checks area is simply empty, and it stays that way until someone pushes.

This bit us for real: PR #4 was opened 47 seconds after another workstream merged the
change that conflicted with it, and got zero runs. The PRs that opened while clean each
got a run within ~3 seconds.

It is a trap for parallel workstreams specifically, and it scales with them: the first
branch to merge is fine, and the second and third are the ones exposed. So:

- **Merge `main` into your branch and resolve conflicts _before_ opening the PR.**
- An empty checks list means "never scheduled", not "still starting". Waiting will not
  fix it — push a commit.
- Confirm a run exists rather than assuming: `gh pr checks <n>`, or
  `gh run list --branch <branch>`. A PR reporting `MERGEABLE` / `CLEAN` with no runs is
  the signature.

## Current state (end of M3, plus the W6 spine)

608 tests across 58 files.

Running without a database, 503 of them: crypto round-trip and tamper detection, the
Prisma encryption extension against a mock, config validation, the storage driver and its
signed URLs, local-to-UTC time conversion across DST, the HTTP error boundary and app
smoke tests, the AI prompt and parse layer, every JSON column's Zod contract, and the
frontend auth guard and API client.

With `TEST_DATABASE_URL` set, 105 more in `backend/tests/db/`:

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
- **`usage.test.ts`** — the W10 meter. Idempotency under retry, concurrent emits of the
  same metric not losing an increment, the rollup agreeing with a rebuild from the ledger,
  a rebuild repairing deliberately corrupted drift, the AI ceiling refusing generation
  while still allowing a publish, and the raw rollup insert binding `periodStart` as UTC.
  Every claim here is trivially satisfiable by a vacuous test, so each is paired with a
  control that must move the same number — see the file header. Also the brand-scope
  tenancy case: a `ScopeRule` returning `{}` is *no filter*, not a deny, so that test
  asserts on **which** workspaces come back rather than on a count, with the other
  workspace's rows guaranteed present at the time of the read.
- **`publishing.test.ts`** — the W6 spine. `OAuthHandshake` tenancy under **both** scope
  kinds, plus the case neither of those can see on its own: a *workspace-shared*
  credential has `brandId: null`, so scoping a handshake through its credential rather
  than through its own `brandId` leaks every sibling brand's in-flight handshake. That
  third test is the one that found a real leak in this workstream's first rule. Also the
  resolver's three-tier precedence asserted on identity with a rival credential present,
  the access log written on every decrypt, the request-token secret proved to be
  ciphertext via `$queryRaw`, single-use handshake consumption, and the publish pipeline:
  metering exactly once with an attempt-independent key, idempotency across a redelivered
  job, `BLOCKED` rather than `FAILED` on a revoked account, backoff that the sweep
  actually respects, terminal validation failures, `PARTIALLY_PUBLISHED` roll-up, and a
  workspace **over its AI ceiling** still publishing end to end.
- **`usage-admin-serialization.test.ts`** — that the admin response actually serializes.
  `quantity` is a `BigInt` and `JSON.stringify` throws on one, so a field later returned
  straight from Prisma would fail at runtime, only on a populated database. Real read
  layer, real `res.json`, only the two auth layers mocked.
- **`trend-mapping-budget.test.ts`** — that `classifyWithLlm` rethrows
  `BudgetExceededError` but still degrades to rule matches on a provider failure. Both
  halves, because a service that rethrows everything passes the first alone and a service
  that swallows everything passes the second alone.
- **`account-health.test.ts`** — W6 PR 2's sweep, revocation and the connections read.
  The interesting part is a mistake it caught in itself. The revocation tests separate
  their two tenants by `credentialId`, so the tenancy rule is redundant there: replacing
  `byBrandColumn.brand` with `() => ({})` left every one of them green. The test that
  actually pins the brand rule needs scope to be the **only** separator — two brands in
  *one* workspace, asserted with `toContain` / `not.toContain` on identity. With that added,
  the same mutation kills 14 tests. A tenancy test whose fixtures differ in any other
  column is not testing tenancy, however much it looks like it is.

  Also covers: the sweep refreshing only inside its window and skipping `REVOKED` accounts,
  one platform failing without abandoning the rest, `connect()` fanning out across **two
  brands**, the nullable-`SocialAccount.credentialId` shape, both scope kinds on the
  connections read, and — asserted on the serialized body rather than the object — that no
  token reaches the response.

## The failure that looks exactly like a pass

Worth repeating because it happened again in W6 PR 2. A test file that fails to *load*
reports `0 test` for that file and **zero failures** overall. The run is green-ish, the
summary looks fine, and the assertions simply never happened. In PR 2 it was an import of
`@testing-library/user-event`, which is not a dependency of this repo.

The only defence is to compare **both** totals — `Test Files` and `Tests` — against the
number you expected, every time. A number that only went up is not evidence.

## A unit-tested guard is not a *wired* guard

Also from W6 PR 2, and the more expensive of the two. `caption-gate.ts` had fourteen unit
tests — every platform's counting unit, every message, the `''`-versus-`null` override
distinction — all green. Commenting out the single `await assertCaptionsFit(...)` line
inside `scheduleTargets` broke **none of them**.

Fourteen tests proving the guard works, zero proving it was reached. That is the same class
of defect as a test that passes for the wrong reason, and it is invisible to code review
because both halves look right in isolation.

`tests/db/caption-gate-schedule.test.ts` closes it by going through the real entry point and
asserting on the **persisted row**, not just on the thrown error. That distinction matters
too: moving the gate to after the `updateMany` still satisfies `rejects.toThrow`, and only
the `expect(await statusOf(targetId)).toBe('DRAFT')` assertion catches it. Both mutations
were measured — removing the call kills 4 tests, moving it after the write kills 3.

**The rule:** when you add a guard at a call site, mutate the *call site*, not the guard.
