# Buzzalicious

A social content platform for a small agency that runs accounts on behalf of its clients.
It turns a brand's identity and what is actually happening in its niche into posts that
are ready to publish: reusable templates rendered to images, trend signals worth reacting
to, AI drafting constrained by the brand's own voice, scheduling, and publishing to the
client's own platform accounts.

> **Status: reset in progress.** The repository is being rebuilt from a prototype on a
> clean foundation. See [ADR-0001](docs/adr/0001-clean-foundation-reset.md) for why, and
> [`docs/`](docs/README.md) for the plan. Milestone M1 (foundation and teardown) has
> landed: the platform layer, module scaffold, tooling and tests exist; the domain models
> and product features do not yet.

## What is here today

- An Express API with Google sign-in, sessions that survive a restart, a validated
  configuration boundary, structured logging, an error taxonomy, envelope encryption for
  credentials, and a pluggable object-storage driver.
- A Vite + React SPA shell: routing, an auth guard, a typed API client, placeholder routes.
- An empty but named module for every part of the product, each with a README describing
  what it will own.
- Lint, format, type-check, test and build, all green, all enforced in CI.

## Getting started

Requires Node 20+ and Postgres 14+.

```bash
npm install

cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env

# Fill in backend/.env. Two values need generating:
openssl rand -base64 32   # SESSION_SECRET
openssl rand -base64 32   # ENCRYPTION_KEY

createdb buzzalicious
npm run db:push
npm run db:seed

npm run dev
```

The API is on <http://127.0.0.1:3001> and the SPA on <http://127.0.0.1:5173>.

Use `127.0.0.1`, not `localhost`. They are different cookie origins and different strings
for OAuth redirect matching; mixing them gives you a login that appears to work and a
session that is not there. This and eight other hard-won integration details are in
[`docs/reference/platform-quirks.md`](docs/reference/platform-quirks.md).

`db:push` rather than `migrate` is deliberate for now — see *Migrations* below.

### Google sign-in

Create an OAuth client in Google Cloud Console and add
`http://127.0.0.1:3001/auth/google/callback` as an authorised redirect URI. It must match
`${APP_URL}/auth/google/callback` byte for byte.

Leaving `ALLOWED_EMAILS` and `ALLOWED_DOMAINS` empty lets anyone with a Google account in.
Set at least one before deploying anywhere reachable.

To access both seeded client workspaces locally, set `SEED_ADMIN_EMAIL` to the same email
you use for Google sign-in before running `npm run db:seed`. The seed grants that user the
`ADMIN` role in Rise & Shore and TaxDedux and safely reuses an existing Google-linked user.

## Commands

| Command | Does |
|---------|------|
| `npm run dev` | API and SPA together, both watching |
| `npm test` | The whole suite, once. Passes on a clean clone — see [docs/12-testing.md](docs/12-testing.md) |
| `npm run test:watch` | The suite, watching |
| `npm run lint` | ESLint. Enforces the layering rules, not just style |
| `npm run format` | Prettier, writing |
| `npm run type-check` | `tsc --noEmit` across both workspaces |
| `npm run build` | Production build of both |
| `npm run db:push` | Sync the schema to a development database |

## Layout

```
backend/src/
  platform/    config, logging, errors, crypto, storage, db — no product knowledge
  http/        Express wiring: app factory, middleware, routers. Thin.
  modules/     the product, one folder per capability
  jobs/        background work, run by the worker process
  index.ts     web entry point
  worker.ts    worker entry point
frontend/src/  the SPA
docs/          architecture, decisions, workstream briefs, harvested reference
```

Dependencies point inward: `http` may call `modules`, `modules` may call `platform`, and
nothing may call `http`. ESLint enforces the last part, because a rule nobody checks is a
preference.

Each folder has a README explaining what belongs in it. Start with
[`backend/src/platform/README.md`](backend/src/platform/README.md).

## Deployment

Heroku, one app, two process types (`Procfile`):

- `web` — the API, which also serves the built SPA
- `worker` — background jobs, on its own dyno so scheduled work is not duplicated once per
  web dyno

Three consequences worth knowing before changing anything:

- **The filesystem is ephemeral.** Nothing written to disk survives a restart, so
  `STORAGE_DRIVER=local` is rejected in production.
- **TLS terminates at the router.** `trust proxy` must be set, or secure cookies never
  reach the browser and sign-in silently fails with no error anywhere.
- **Vite inlines `import.meta.env` at build time.** The SPA's API URL cannot come from a
  runtime config var, so it falls back to `window.location.origin`.

### Migrations

`prisma/migrations/` is intentionally empty. The prototype's fourteen migrations described
a data model that no longer exists, and replaying them onto a fresh database would produce
tables the new code does not use.

W2 owns [`backend/prisma/schema.prisma`](backend/prisma/schema.prisma) and will author
`0001_init` as the first migration of the new model. Until then `db:deploy` runs
successfully with nothing to apply, and local development uses `db:push`.

## Documentation

[`docs/README.md`](docs/README.md) is the index and the reading order.

- [`docs/01-architecture.md`](docs/01-architecture.md) — the target structure
- [`docs/adr/`](docs/adr/) — decisions and their reasons
- [`docs/tasks/`](docs/tasks/) — one brief per workstream
- [`docs/reference/`](docs/reference/) — integration knowledge harvested from the
  prototype before it was deleted. Written down because it is expensive to rediscover and
  is in no vendor's documentation.

## Contributing

Read [`AGENTS.md`](AGENTS.md) first. It is short, and it is where the working rules live.

The four gates — `lint`, `type-check`, `test`, `build` — must pass before anything merges.
CI runs all four on every pull request.
