# LinkedIn OAuth 2 + UGC posting — harvested from the prototype

> [!CAUTION]
> **DEAD CODE, and deliberately parked.** Source: `backend/src/services/linkedin.service.ts`
> and the LinkedIn routes in `backend/src/routes/social.routes.ts`, both deleted in M1.
>
> [03 — Teardown](../03-teardown.md) is explicit: LinkedIn drops to **P1** and this code
> must **not** be carried into `backend/src/modules/publish/`. It lives here and only
> here. v1 publishing targets are Instagram, Facebook, Threads, and X
> ([ADR-0005](../adr/0005-v1-platform-targets.md)).

## Why it's parked rather than deleted outright

It worked. It posted real text posts to real LinkedIn accounts. When LinkedIn comes back
in P1, the `ugcPosts` payload shape below and the `openid`-era `/v2/userinfo` behavior are
the two things that cost time to get right, and neither is obvious from LinkedIn's docs.

## Authorization URL (verbatim)

```ts
// Generate LinkedIn OAuth URL
static generateAuthUrl(callbackUrl: string, state: string): string {
  const clientId = process.env.LINKEDIN_CLIENT_ID;
  const scope = 'openid profile w_member_social email';

  return `https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(callbackUrl)}&state=${state}&scope=${encodeURIComponent(scope)}`;
}
```

**Scope notes.** `w_member_social` is the one that actually permits posting; `openid`,
`profile`, and `email` are what make `/v2/userinfo` return anything useful. LinkedIn
migrated to OpenID Connect and the older `r_liteprofile` / `r_emailaddress` scopes were
the source of a lot of stale advice. Verify current scope names against LinkedIn's
documentation before writing any of this again — per AGENTS.md rule 7, these are exactly
the kind of volatile specifics that should not be trusted from a year-old file.

## Token exchange (verbatim)

```ts
static async getAccessToken(code: string, redirectUri: string): Promise<{
  accessToken: string;
  expiresIn: number;
}> {
  try {
    const response = await axios.post(
      'https://www.linkedin.com/oauth/v2/accessToken',
      null,
      {
        params: {
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          client_id: process.env.LINKEDIN_CLIENT_ID,
          client_secret: process.env.LINKEDIN_CLIENT_SECRET,
        },
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );

    return {
      accessToken: response.data.access_token,
      expiresIn: response.data.expires_in,
    };
  } catch (error: any) {
    console.error('LinkedIn token exchange error:', error.response?.data || error.message);
    throw new Error('Failed to exchange LinkedIn authorization code');
  }
}
```

Two traps, both of which produce the same unhelpful `invalid_request`:

- **The body is `null` and everything goes in `params`.** LinkedIn accepts the exchange as
  a query string on a `POST`. Sending a form-encoded body instead is the more standard
  reading of the spec and it is not what worked here.
- **`redirect_uri` must match leg 1 byte-for-byte.** Not semantically — byte-for-byte.
  This is why the prototype recomputed the same `callbackUrl` expression in both the
  connect route and the callback route rather than trusting the incoming request.

## Profile lookup (verbatim)

```ts
async getProfile(): Promise<{ id: string; name: string; email?: string }> {
  try {
    const response = await axios.get('https://api.linkedin.com/v2/userinfo', {
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
      },
    });

    return {
      id: response.data.sub,
      name: response.data.name,
      email: response.data.email,
    };
  } catch (error: any) {
    console.error('LinkedIn profile error:', error.response?.data || error.message);
    throw new Error('Failed to fetch LinkedIn profile');
  }
}
```

The member ID is `sub` — the OIDC subject claim — not `id`. It is needed to build the
author URN for a post, so a failure here blocks posting entirely.

## UGC post payload (verbatim) — the valuable part

```ts
async postText(text: string): Promise<{ id: string; url: string }> {
  try {
    // First, get the user's LinkedIn ID
    const profile = await this.getProfile();

    // Create a post (share)
    const response = await axios.post(
      'https://api.linkedin.com/v2/ugcPosts',
      {
        author: `urn:li:person:${profile.id}`,
        lifecycleState: 'PUBLISHED',
        specificContent: {
          'com.linkedin.ugc.ShareContent': {
            shareCommentary: {
              text: text,
            },
            shareMediaCategory: 'NONE',
          },
        },
        visibility: {
          'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC',
        },
      },
      {
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
          'X-Restli-Protocol-Version': '2.0.0',
        },
      }
    );

    const postId = response.data.id;
    const postUrl = `https://www.linkedin.com/feed/update/${postId}`;

    return { id: postId, url: postUrl };
  } catch (error: any) {
    console.error('LinkedIn post error:', error.response?.data || error.message);
    throw new Error('Failed to post to LinkedIn');
  }
}
```

What makes this payload worth keeping:

- **The fully-qualified Java-style keys are mandatory.**
  `com.linkedin.ugc.ShareContent` and `com.linkedin.ugc.MemberNetworkVisibility` are
  literal object keys, not namespacing decoration.
- **`X-Restli-Protocol-Version: 2.0.0` is required.** Omitting it fails in a way that
  does not mention the header.
- **`author` is a URN**, `urn:li:person:<sub>`. Posting as a company page uses
  `urn:li:organization:<id>` and a different permission — never exercised here.
- **`shareMediaCategory: 'NONE'`** is the text-only path. Image posts require registering
  an upload, PUTting the bytes to the returned URL, then referencing the returned asset
  URN — a three-step flow this prototype never implemented.
- **The returned `id` is itself a URN** and drops straight into
  `https://www.linkedin.com/feed/update/<urn>` to build a permalink.

## Token expiry

`expiresIn` came back from the exchange and the prototype **stored it on the user but
never acted on it**. The only expiry handling anywhere was a check inside the scheduler:

```ts
// Check if token is expired
if (user.linkedinTokenExpiry && new Date(user.linkedinTokenExpiry) <= new Date()) {
  throw new Error('LinkedIn token expired');
}
```

That is a failure at publish time, three weeks after the cause — precisely the invisible
failure mode [10 — Credentials & security](../10-credentials-and-security.md) is built to
prevent. LinkedIn access tokens last roughly 60 days. Refresh tokens are not granted to
every app tier, so re-authorization may be the only path. Whenever LinkedIn returns, its
credential must record `tokenExpiresAt` and participate in the validation sweep like every
other platform.
