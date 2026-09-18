# `platform/` — cross-cutting infrastructure

**Owner:** W0 · **Status:** implemented

## Responsibility

The things every module needs and no module should implement twice: configuration,
logging, errors, encryption, object storage, the database client, and rate limiting.

## Boundaries

- **`platform/` imports nothing from `modules/` or `http/`.** It is the bottom of the
  dependency graph. If something here needs to know about a domain concept, it belongs
  in a module instead.
- **`config.ts` is the only file in the backend that reads `process.env`.** Everything
  else takes config as an argument or calls `getConfig()`. A URL derived in three places
  drifts in three places — see `docs/reference/platform-quirks.md`.
- **No `console.*` anywhere in `backend/src`.** ESLint enforces it. Use `getLogger()`.

## Files

| File | What it owns |
|------|--------------|
| `config.ts` | Zod schema for every env var. Refuses to boot on missing or invalid required vars. |
| `logger.ts` | Pino + `pino-http`. Allow-list serializers, deny-list redaction, request IDs. |
| `errors.ts` | `AppError` hierarchy and the single error body shape the API returns. |
| `crypto.ts` | AES-256-GCM with versioned ciphertext behind a `KeyProvider` seam. |
| `storage.ts` | `StorageDriver` with local and R2 implementations, and signed URLs. |
| `db.ts` | The Prisma singleton, with query logging routed through Pino. |
| `rate-limit.ts` | `express-rate-limit` configurations. Only `authLimiter` is mounted today. |

## Things to know before changing anything here

**Ciphertext is versioned on purpose.** `v1.<keyId>.<iv>.<tag>.<ct>`, with the scheme and
key id authenticated as GCM AAD. Changing the format means every stored credential
becomes unreadable, so add a new scheme rather than editing `v1`.

**`KeyProvider` exists so a KMS can replace the Heroku config var** without a search
across the codebase (Q14, `docs/10-credentials-and-security.md`). W6 layers per-workspace
DEKs on top of it; nothing that calls `encrypt`/`decrypt` should have to change.

**The local storage driver refuses to run in production.** Heroku's filesystem is
ephemeral, so anything written to it disappears on the next dyno cycle. `config.ts`
rejects the combination at boot and `createStorageDriver` throws as a second lock,
because the failure is otherwise silent and delayed.

**Rate limiting depends on `trust proxy`.** Behind Heroku's router every request appears
to come from the proxy. Without `trust proxy`, all users share one bucket.

## Deliberately not here

- **Job scheduling.** `jobs/` owns it; pg-boss arrives in W6.
- **Credential resolution.** `CredentialResolver` is a `modules/publish/` concern. This
  layer provides the primitive; it does not decide whose key is used.
