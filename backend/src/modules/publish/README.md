# `modules/publish/`

**Owner:** W6 · **Status:** scaffold

## Responsibility

Getting a finished post onto a social network, and everything that implies: platform
adapters, credential resolution, retries, and recording what was published where.

## The central interface

`PlatformAdapter`, defined in [docs/01-architecture.md](../../../../docs/01-architecture.md).
One implementation per network. v1 targets Instagram, Facebook, Threads and X (ADR-0005).
LinkedIn is P1 and deliberately not carried over — its prototype code is preserved in
[docs/reference/linkedin.md](../../../../docs/reference/linkedin.md) and must not be
copied here until it is scheduled.

## Boundaries

- **Every adapter method takes a resolved credential. No adapter reads `process.env`.**
  Clients bring their own platform apps (ADR-0009), so the app key itself varies per
  workspace. An adapter that reads the environment works for exactly one client.
- Credentials are stored encrypted via `platform/crypto.ts` and resolved by a
  `CredentialResolver` in this module. Adapters never touch ciphertext.
- Job payloads carry identifiers, never tokens. Queue rows are readable by anyone with
  database access and outlive the job.
- Rotate-on-use refresh tokens must be written transactionally. If the write fails after
  the response arrives, the token is gone permanently — see
  [docs/reference/platform-quirks.md](../../../../docs/reference/platform-quirks.md).

## `x/`

`x/twitter.service.ts` is parked, unreferenced prototype code. It holds the real API shape
— `v1.uploadMedia` for media, `v2.tweet` for posting — but its constructor reads the
environment and must be rewritten to take a resolved credential. The OAuth 1.0a handshake
that produces its tokens is in
[docs/reference/x-oauth1a.md](../../../../docs/reference/x-oauth1a.md); read it first,
because the callback does not return `oauth_token_secret` and the flow cannot be
reconstructed from X's documentation alone.
