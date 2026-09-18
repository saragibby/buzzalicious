# ADR-0009 — Bring-your-own platform credentials (dual mode)

**Date:** 2026-09-17 · **Status:** Accepted
**Supersedes parts of:** [ADR-0005](./0005-v1-platform-targets.md)

## Context

[ADR-0005](./0005-v1-platform-targets.md) assumed the conventional SaaS model: Buzzalicious
registers one Meta app and one X app, completes business verification and app review once,
and every client authorizes into our app. That made **Meta app review the critical path for
all of phase 1** — weeks of external dependency before anyone could publish.

But the first two clients, Rise & Shore and TaxDedux, are *already* verified businesses
with their own platform credentials. Requiring them to authorize into an unreviewed
Buzzalicious app would mean waiting on a review process they've already completed
themselves.

## Decision

Support **credential modes** behind a single resolution interface:

| Mode | What we hold | Who it's for |
|------|--------------|--------------|
| `DIRECT_TOKEN` | A long-lived access token the client pastes in | Day-one migration. Both existing apps already run this way. |
| `CLIENT_APP` | The client's app ID + secret; we run OAuth and refresh | Clients with verified apps who want publishing that doesn't break |
| `PLATFORM_APP` | Buzzalicious's own app, from config | Non-technical small businesses (deferred) |

**`DIRECT_TOKEN` and `CLIENT_APP` both ship in v1.** `PLATFORM_APP` continues in parallel
and is not on the critical path for anything.

### Why both, and not just one

The audit of `tax-agent` and `sc-rental-monitor` found that **neither existing app uses
OAuth.** Both paste long-lived tokens into environment variables —
`INSTAGRAM_ACCESS_TOKEN`, `FACEBOOK_PAGE_ACCESS_TOKEN`, `THREADS_ACCESS_TOKEN`, and X
OAuth 1.0a consumer/access pairs. That is the real starting state, and `DIRECT_TOKEN` lets
both brands migrate onto Buzzalicious in an afternoon with zero OAuth work.

But `DIRECT_TOKEN` cannot be the destination. **Meta long-lived tokens expire in roughly 60
days and cannot be refreshed without the app secret.** A platform whose publishing silently
stops every two months until someone remembers to paste a new token is not a product — and
the failure is invisible until a client notices their posts stopped.

So `DIRECT_TOKEN` is explicitly a **migration and bootstrap mode**, not a supported
steady state:

- Every `DIRECT_TOKEN` credential records an expiry and warns well before it
- The UI names it as temporary and prompts to upgrade to `CLIENT_APP`
- X OAuth 1.0a tokens are the exception — they don't expire, so `DIRECT_TOKEN` is
  legitimately durable there
- Meta **system user tokens**, where a client has one, are reported not to expire and sit
  between the two modes — verify before relying on it

Credential resolution order for a given `(brand, platform)`:

1. Brand-scoped credential (`CLIENT_APP` preferred over `DIRECT_TOKEN`)
2. Workspace-scoped credential (same preference)
3. `PLATFORM_APP` credential from config

## Rationale

- **It removes app review from the critical path.** This was the single largest scheduling
  risk in phase 1. Publishing can work on day one for clients who bring credentials.
- **Rate limits are per-app.** Each client gets their own quota instead of contending for
  a shared pool — a real scaling benefit, not just a launch convenience.
- **It moves the X API subscription cost onto the client**, removing the largest fixed
  infrastructure cost from Buzzalicious.
- **No unverified-app warning screens** during client onboarding.
- **But BYO alone contradicts the target user.** The PRD's user is "a small business owner
  with no design background," and activation within 7 days is a success metric. Registering
  a Meta developer account, completing business verification, and passing app review is a
  multi-week technical project — impossible for that user. Hence dual mode, not BYO-only.

### Why app credentials rather than pasted tokens

A pasted long-lived Meta token expires in roughly 60 days and **cannot be refreshed
without the app secret that issued it.** That failure mode is the worst kind: publishing
silently stops two months after onboarding, and neither we nor the client notice until
posts stop appearing. Holding app credentials lets us run the OAuth exchange and refresh
tokens on a schedule.

Meta system user tokens are designed for exactly this server-to-server case and can be
non-expiring, which makes them the preferred mechanism where a client has Business Manager
set up.

## Consequences

### Architectural

- **The `PlatformAdapter` interface changes.** Every method takes a resolved credential
  rather than reading app config from the environment. This is a breaking change to the
  design in [08](../08-platform-integrations.md) and must land before any adapter is written.
- **`SocialAccount` gains a `credentialId`.** A token is only valid and refreshable via the
  app that minted it — losing that link makes refresh impossible and the token
  unrecoverable.
- **OAuth `state` must encode which credential is in play**, so the callback knows which
  app secret to exchange the authorization code with.
- A single canonical callback URL is used for all clients; each client registers it once in
  their own app.

### Operational

- **Capability pre-flight is now required.** A client's app may be approved for a narrower
  permission set than we need. Onboarding must validate the credential, introspect granted
  permissions, and report what will and won't work — otherwise the failure surfaces as a
  mysterious publish error weeks later.
- Client app misconfiguration becomes a Buzzalicious support burden, into which we have
  limited visibility.

### Security

- **We now hold client app secrets**, which are substantially higher-value than user access
  tokens — effectively keys to a client's entire social presence. This warrants envelope
  encryption with per-tenant data keys, an access audit trail, and documented rotation and
  revocation paths. See [10 — Credentials & security](../10-credentials-and-security.md).
- Buzzalicious is acting as a data processor on behalf of the client. The legal framing
  (DPA, responsibilities) needs review.
- Platform terms on third parties holding app secrets must be verified for each platform.

### Trend collection

Read-only trend collection cannot depend on client credentials — trend data quality would
vary with which clients we happen to have, and it would burn their rate limits on work that
isn't their post. **A minimal Buzzalicious-owned app is retained for trend collection
only**, with read-only scopes that are far lighter to get approved than publishing
permissions. See [07](../07-trend-engine.md).
