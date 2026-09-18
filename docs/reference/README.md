# `docs/reference/` — harvested prototype knowledge

> [!CAUTION]
> **Everything in this folder is DEAD CODE.** None of it runs. None of it is imported.
> It does not compile, it is excluded from lint and type-check, and it must not be
> copy-pasted into the new codebase without being reworked against
> [10 — Credentials & security](../10-credentials-and-security.md).

## Why this exists

The old prototype was deleted in M1 (W1 — Teardown). A handful of things in it were
learned the hard way against live third-party APIs and are not written down in any
vendor documentation: OAuth sequencing details, redirect-URI behavior, token expiry
quirks, and the specific fixes that made OAuth work once the app was deployed behind
Heroku's router rather than running on `127.0.0.1`.

Rediscovering that is expensive. Reading it is cheap. So it was captured **in the same
commit that deleted the source**, so a reviewer can diff the two halves together and
confirm nothing was lost.

## Contents

| File | What it captures | Who needs it |
|------|------------------|--------------|
| [`x-oauth1a.md`](./x-oauth1a.md) | X (Twitter) OAuth 1.0a request-token → authorize → access-token sequence, verbatim | W6 |
| [`linkedin.md`](./linkedin.md) | LinkedIn OAuth 2 exchange, `/v2/userinfo`, and the UGC post payload shape, verbatim | P1, whenever LinkedIn returns |
| [`scheduler.md`](./scheduler.md) | Scheduled-post status transitions and the specific gaps pg-boss must close | W6 |
| [`platform-quirks.md`](./platform-quirks.md) | Redirect-URI handling, token expiry behavior, and the deployed-environment redirect fixes from git history | W3, W6 |
| [`canva.md`](./canva.md) | Why the Canva integration is gone, and the one idea worth keeping from it | nobody, deliberately |

## What was *not* harvested, and why

- **Credential values.** None. Not one. See the handling rules in
  [10 — Credentials & security](../10-credentials-and-security.md).
- **`ai.routes.ts`** — free-prompt content generation. The new surface is template- and
  brand-driven; there is nothing here to learn.
- **`AIGenerator.tsx`, `Analytics.tsx`** — the old product's UI. W5 builds the real thing.
- **`schedule.routes.ts` CRUD shape** — covered by `scheduler.md`; the route handlers
  themselves were a thin wrapper over Prisma and carried no knowledge.

## Reading this alongside the new code

The single biggest structural difference: the prototype read app credentials straight
from `process.env` and stored user tokens as **plaintext columns on `User`**. The new
system does neither. Every credential is resolved through `CredentialResolver`, encrypted
at rest, and passed *into* an adapter — see
[ADR-0009](../adr/0009-byo-platform-credentials.md). Treat every `process.env.*_API_KEY`
and every `user.somethingAccessToken` below as an illustration of the shape of a call,
never of how to obtain the value.
