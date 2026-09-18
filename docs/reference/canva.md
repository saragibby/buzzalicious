# Canva integration — why it's gone

> [!CAUTION]
> **DELETED, not parked.** Source: `backend/src/services/canva.service.ts` (299 lines)
> plus the Canva OAuth routes and the `canva*` columns on `User`. Removed in M1.

This page exists so the absence is deliberate and documented, not an oversight someone
tries to "fix" later.

## Why it was removed

[ADR-0002](../adr/0002-satori-template-rendering.md) chose HTML/CSS → Satori → resvg →
PNG, rendered server-side. That decision makes a third-party design tool redundant for the
core loop:

- Rendering happens in-process in tens of milliseconds, with no OAuth, no rate limit, and
  no external availability risk on the critical path.
- Templates are ours. Slot schemas, brand-kit application, and per-platform renditions are
  all things we need to control directly to make the outcome feedback loop work.
- An integration whose value is "the user leaves and designs something elsewhere" is the
  opposite of [the one-pipeline principle](../../AGENTS.md#anchoring-principles).

It also carried real cost: an OAuth flow with token refresh, three more encrypted columns,
and another vendor whose API changes could break publishing.

## The one thing worth remembering

The Canva flow was the only **OAuth 2.0 + PKCE** implementation in the prototype, and PKCE
is the pattern several platforms now prefer. The mechanics, for whoever needs them next:

```ts
// Generate PKCE code verifier and challenge
static generatePKCE(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = crypto.randomBytes(96).toString('base64url');
  const codeChallenge = crypto
    .createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');

  return { codeVerifier, codeChallenge };
}
```

The verifier is sent on the token exchange as `code_verifier`; the challenge goes on the
authorize URL as `code_challenge` with `code_challenge_method=S256`. **`base64url`, not
`base64`** — standard base64 contains `+` and `/`, which do not survive a URL, and the
resulting mismatch reports as a generic invalid-grant.

Like the X flow, the prototype held the verifier in an in-memory `Map`
(`canvaStateStore`), with all the same multi-dyno problems described in
[`x-oauth1a.md`](./x-oauth1a.md#leg-13-state--the-part-that-was-wrong).

## If Canva ever comes back

It would be an **asset import source** — pull an existing design in as a brand asset — not
a rendering backend. That is a completely different integration from the one deleted here,
and nothing above would be reused beyond the PKCE helper.
