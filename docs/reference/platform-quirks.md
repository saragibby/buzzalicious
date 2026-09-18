# Platform quirks — redirects, cookies, and token expiry

> [!CAUTION]
> **DEAD CODE and historical notes.** Sources: `backend/src/index.ts`,
> `backend/src/auth.ts`, `backend/src/routes/social.routes.ts`,
> `frontend/src/utils/api.ts`, and commits `3b75f69`, `9f2ae44`, `7ed695e` — all deleted
> or rewritten in M1.

This is the page that justifies the whole `docs/reference/` folder. None of what follows
is in any vendor's documentation. All of it was discovered by deploying something that
worked locally and watching it fail.

## The core problem: local and deployed are different topologies

| | Local | Heroku |
|---|---|---|
| Frontend origin | `http://127.0.0.1:3000` (Vite) | `https://<app>.herokuapp.com` |
| Backend origin | `http://127.0.0.1:3001` (Express) | `https://<app>.herokuapp.com` — **same origin** |
| How they connect | Vite dev-server proxy for `/api` | Express serves the built SPA |
| CORS | Needed, cross-origin | Not needed, same-origin |
| Cookies | `secure: false`, plain HTTP | Must be `secure: true` behind a TLS-terminating proxy |

Every bug below is a consequence of that table. **Three commits in a row** — `3b75f69`,
`9f2ae44`, `7ed695e` — were spent converging on it.

## Quirk 1 — `localhost` and `127.0.0.1` are different cookie origins

They resolve to the same host and they are **not** interchangeable for cookies or for
OAuth redirect-URI matching. A session cookie set on `127.0.0.1` is invisible to a page
served from `localhost`. The prototype's response was to standardize on `127.0.0.1`
everywhere — Vite's `server.host`, the proxy target, every fallback URL — and to
explicitly refuse to set a cookie domain:

```ts
cookie: {
  secure: false, // Must be false for http://
  httpOnly: true,
  sameSite: 'lax',
  maxAge: 24 * 60 * 60 * 1000, // 24 hours
  domain: undefined, // Don't set domain to allow both localhost and 127.0.0.1
},
```

The comment on `domain` is optimistic — leaving it undefined scopes the cookie to the
exact host that set it, which is what makes the standardization necessary rather than
what makes both work. **Some providers, Canva among them, reject `localhost` in a redirect
URI but accept `127.0.0.1`.** That asymmetry is why the whole codebase picked `127.0.0.1`.

Carried forward: local dev stays on `127.0.0.1`, and this is written into `.env.example`
rather than left as folklore.

## Quirk 2 — `secure: false` was hardcoded and is wrong on Heroku

The cookie config above is not environment-aware. On Heroku:

- Heroku's router terminates TLS and forwards **HTTP** to the dyno, so Express sees
  `req.protocol === 'http'` and will refuse to set a `secure` cookie unless
  `app.set('trust proxy', 1)` is on.
- Without `trust proxy`, setting `secure: true` produces a login that silently never
  establishes a session — the redirect succeeds, the cookie is dropped, the next request
  is anonymous. No error anywhere.

The prototype sidestepped this by leaving `secure: false` in production, which works and
is a security hole. The new bootstrap sets `trust proxy` and `secure` together, driven by
`NODE_ENV`, because they are only ever correct as a pair.

## Quirk 3 — deriving a base URL from `NODE_ENV`, with a fake fallback

This shape was copy-pasted into **three** files — `index.ts`, `auth.ts`, and
`social.routes.ts`:

```ts
const getFrontendUrl = () => {
  if (process.env.NODE_ENV === 'production') {
    return process.env.FRONTEND_URL || 'https://your-app.herokuapp.com';
  }
  return 'http://127.0.0.1:3000';
};
```

and its backend twin in `auth.ts`:

```ts
const getBaseUrl = () => {
  if (process.env.NODE_ENV === 'production') {
    return process.env.BACKEND_URL || 'https://your-app.herokuapp.com';
  }
  return 'http://127.0.0.1:3001';
};
```

Two separate failures live here:

1. **`'https://your-app.herokuapp.com'` is a placeholder that boots happily.** Forget to
   set `FRONTEND_URL` and the app starts, then redirects real users to a domain that does
   not exist. This is the canonical example behind W0's rule that the process must refuse
   to start on a missing required var.
2. **Three copies drift.** `3b75f69` had to add the same helper to three files at once
   precisely because there was no single source of truth.

Carried forward: one Zod-validated `config` module, `APP_URL` derived once, no fallbacks.

## Quirk 4 — the post-login redirect, twice

`3b75f69` made the Google callback branch on environment:

```ts
const redirectUrl = process.env.NODE_ENV === 'production'
  ? '/'
  : getFrontendUrl();
res.redirect(redirectUrl);
```

Six minutes later, `9f2ae44` ("redirect issues fix?") reverted it:

```ts
res.redirect(getFrontendUrl());
```

The reasoning: in production the SPA and the API share an origin, so a relative `'/'`
*should* work — but it lands on the Express catch-all rather than a URL the SPA router
recognizes, and any state in the redirect is lost. An absolute URL behaves identically in
both environments, so the branch was pure risk.

**Rule: always redirect to an absolute URL built from config.** Never branch redirect
targets on environment.

## Quirk 5 — the frontend has to discover its own API origin

`7ed695e` added this, and it is the cleanest thing in the harvested set:

```ts
// Helper function to get the backend API URL
export const getBackendUrl = (): string => {
  // In production (when VITE_API_URL is not set), use the same origin as the frontend
  // This works because both frontend and backend are served from the same Heroku domain
  if (import.meta.env.VITE_API_URL) {
    return import.meta.env.VITE_API_URL;
  }

  // Check if we're in development (localhost or 127.0.0.1)
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    return 'http://127.0.0.1:3001';
  }

  // Production: use the same origin (works when frontend and backend are on same domain)
  return window.location.origin;
};
```

Why it matters: **Vite inlines `import.meta.env` at build time.** On Heroku the frontend
is built during the slug compile, before any runtime config var is knowable, so the
production API URL genuinely cannot come from the environment. Falling back to
`window.location.origin` is the correct answer for a single-deployable app, not a
workaround.

The new typed API client keeps this behavior and simplifies it: same-origin by default,
overridable only by `VITE_API_URL` for local development.

## Quirk 6 — `credentials: 'include'` on every request

Session auth over `fetch` does not send cookies unless asked. Every call in the prototype
carried `credentials: 'include'`, and the one place it was forgotten produced a 401 that
looked like a session bug. In the new frontend this is set once in the API client rather
than repeated per call.

## Quirk 7 — redirect URIs must match byte-for-byte

Across X, LinkedIn, and Canva, the callback URL sent on the authorize leg and the one sent
on the token-exchange leg must be **identical strings**. Not equivalent — identical. A
trailing slash, `http` vs `https`, or `localhost` vs `127.0.0.1` each produce a generic
invalid-grant error that names nothing.

The prototype handled this by recomputing the same expression in both places:

```ts
const callbackUrl = process.env.LINKEDIN_REDIRECT_URI
  || `${process.env.BACKEND_URL || 'http://127.0.0.1:3001'}/api/social/linkedin/callback`;
```

Duplicated between the connect route and the callback route — correct by copy-paste, which
holds until someone edits one of them. [10 — Credentials & security](../10-credentials-and-security.md)
resolves this properly with a **single canonical callback URL** per platform, derived once
from config, that every client registers.

## Quirk 8 — token expiry behavior, by platform

| Platform | Expiry | Refreshable | Consequence |
|----------|--------|-------------|-------------|
| **X (OAuth 1.0a)** | Never | N/A | Only revocation or an app permission change invalidates a token. `DIRECT_TOKEN` is genuinely durable here. |
| **LinkedIn** | ~60 days (`expires_in` on exchange) | Not on all app tiers | Prototype stored `linkedinTokenExpiry` and checked it **only at publish time**, three weeks after it mattered. |
| **Canva** | Short-lived + refresh token | Yes | The only refresh flow in the prototype. Refresh returns a **new refresh token** that must replace the stored one — rotate-on-use. |
| **Meta** (not in prototype) | ~60 days | Requires the **app secret** | See [10](../10-credentials-and-security.md): this is why `DIRECT_TOKEN` is a bootstrap mode and not a destination. |

The generalization: **expiry must be recorded at connect time and swept proactively**,
never discovered during a scheduled publish. That is `tokenExpiresAt` plus the recurring
validation sweep in [10 — Credentials & security](../10-credentials-and-security.md).

## Quirk 9 — a rotate-on-use refresh token can be lost

Canva's refresh returned both a new access token *and* a new refresh token:

```ts
return {
  accessToken: response.data.access_token,
  refreshToken: response.data.refresh_token,
};
```

If the response is received but the write fails, the old refresh token is already spent
and the new one is gone — the connection is unrecoverable and the user must re-authorize.
Any platform with rotate-on-use refresh needs the token write to be the transactional step,
not an afterthought.

## Checklist for the new implementation

- [ ] One `config` module; no URL derived in more than one place
- [ ] No placeholder fallback values anywhere — boot fails instead
- [ ] `trust proxy` and `cookie.secure` set together from `NODE_ENV`
- [ ] Local dev pinned to `127.0.0.1`, documented in `.env.example`
- [ ] Redirects always absolute, never branched on environment
- [ ] One canonical OAuth callback URL per platform, from config
- [ ] `credentials: 'include'` set once in the API client
- [ ] `tokenExpiresAt` recorded at connect; expiry swept, not discovered
- [ ] Refresh-token rotation written transactionally
