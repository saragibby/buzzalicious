# X (Twitter) OAuth 1.0a — harvested from the prototype

> [!CAUTION]
> **DEAD CODE.** Source: `backend/src/routes/social.routes.ts` and
> `backend/src/services/twitter.service.ts`, both deleted in M1. Reproduced verbatim so
> the sequencing is not lost. Do not copy it forward unchanged — see
> [What W6 must change](#what-w6-must-change).

## Why OAuth 1.0a at all

X supports OAuth 2.0 with PKCE, but the prototype used **OAuth 1.0a** and it worked. Two
properties made it the right call then and probably still do:

- **OAuth 1.0a access tokens do not expire.** They are only invalidated when the user
  revokes access or the app's permissions change. This is why
  [10 — Credentials & security](../10-credentials-and-security.md) calls `DIRECT_TOKEN`
  *legitimately durable* for X while treating it as a 60-day bootstrap for Meta.
- **`twitter-api-v2` handles the signing.** The HMAC-SHA1 request signing that makes
  OAuth 1.0a tedious by hand is entirely inside the library.

The cost is that the flow is a **three-legged handshake with server-side state** between
leg 1 and leg 3, and that state is the part the prototype got wrong (see below).

## The sequence

```mermaid
sequenceDiagram
    participant U as User
    participant B as Buzzalicious
    participant X as X API

    U->>B: GET /api/social/twitter/connect
    B->>X: POST oauth/request_token (appKey + appSecret, callback URL)
    X-->>B: oauth_token + oauth_token_secret + authorize URL
    Note over B: Leg 1→3 state: oauth_token_secret<br/>must survive until the callback
    B-->>U: { authUrl }  (client does window.location = authUrl)
    U->>X: Authorizes the app
    X-->>B: GET /callback?oauth_token=...&oauth_verifier=...
    Note over B: Look up oauth_token_secret by oauth_token
    B->>X: POST oauth/access_token (oauth_verifier + the stored secret)
    X-->>B: accessToken + accessSecret + userId + screenName
    B->>B: Persist; redirect to the frontend
```

**The thing that is easy to miss:** the callback carries `oauth_token` and
`oauth_verifier`, but *not* `oauth_token_secret`. Leg 3 cannot be completed without the
secret issued in leg 1. It must be stored server-side, keyed by `oauth_token`, and it is
single-use.

## Leg 1 — request token (verbatim)

From `twitter.service.ts`:

```ts
/**
 * Generate OAuth 1.0a authorization URL
 */
static async generateAuthUrl(callbackUrl: string): Promise<{ url: string; oauth_token: string; oauth_token_secret: string }> {
  try {
    const client = new TwitterApi({
      appKey: process.env.TWITTER_API_KEY!,
      appSecret: process.env.TWITTER_API_SECRET!,
    });

    console.log('Generating Twitter auth link with callback:', callbackUrl);
    const authLink = await client.generateAuthLink(callbackUrl);
    console.log('Successfully generated auth link');
    return authLink;
  } catch (error: any) {
    console.error('Twitter API Error Details:', {
      message: error.message,
      code: error.code,
      data: error.data,
    });
    throw error;
  }
}
```

Note that `generateAuthLink` is constructed with **only** `appKey` and `appSecret` — no
user tokens. The route side, from `social.routes.ts`:

```ts
const callbackUrl = `${process.env.BACKEND_URL || 'http://127.0.0.1:3001'}/api/social/twitter/callback`;
console.log('Initiating Twitter OAuth with callback:', callbackUrl);

const authLink = await TwitterService.generateAuthUrl(callbackUrl);

// Store the oauth token secret temporarily
oauthTokenStore.set(authLink.oauth_token, {
  secret: authLink.oauth_token_secret,
  userId: (req.user as any).id,
});

res.json({ authUrl: authLink.url });
```

## Leg 1→3 state — the part that was wrong

```ts
// Store temporary OAuth tokens in memory (in production, use Redis or database)
const oauthTokenStore = new Map<string, { secret: string; userId: string }>();
```

The prototype's own comment admits the problem. An in-process `Map` breaks in four ways:

1. **Multiple dynos.** Heroku routes the callback to an arbitrary web dyno. If leg 1 was
   served by dyno A and the callback lands on dyno B, the lookup misses and the user
   sees `Invalid OAuth token` with no explanation.
2. **Any restart** — a deploy, a dyno cycle, a crash — drops every in-flight handshake.
3. **Unbounded growth.** Entries are only deleted on a successful callback. Every
   abandoned authorization leaks an entry, holding a secret in memory forever.
4. **No expiry and no CSRF binding.** `oauth_token` comes back from the user's browser
   and is trusted as a lookup key.

## Leg 3 — access token (verbatim)

```ts
/**
 * Complete OAuth flow and get access tokens
 */
static async getAccessToken(oauthToken: string, oauthVerifier: string, oauthTokenSecret: string): Promise<{
  accessToken: string;
  accessSecret: string;
  userId: string;
  screenName: string;
}> {
  const client = new TwitterApi({
    appKey: process.env.TWITTER_API_KEY!,
    appSecret: process.env.TWITTER_API_SECRET!,
    accessToken: oauthToken,
    accessSecret: oauthTokenSecret,
  });

  const { accessToken, accessSecret, userId, screenName } = await client.login(oauthVerifier);

  return { accessToken, accessSecret, userId, screenName };
}
```

The subtlety: the client for leg 3 is constructed with the **request** token and the
**request** token secret in the `accessToken`/`accessSecret` positions. `client.login()`
then swaps them for the real access pair. Passing the app credentials alone, or the
verifier in the wrong position, produces a generic 401 that gives no hint about which.

The callback route, verbatim:

```ts
const { oauth_token, oauth_verifier } = req.query;

if (!oauth_token || !oauth_verifier) {
  res.status(400).send('Missing OAuth parameters');
  return;
}

// Retrieve stored token secret
const stored = oauthTokenStore.get(oauth_token as string);
if (!stored) {
  res.status(400).send('Invalid OAuth token');
  return;
}

// Exchange for access token
const { accessToken, accessSecret, userId, screenName } = await TwitterService.getAccessToken(
  oauth_token as string,
  oauth_verifier as string,
  stored.secret
);

// Clean up temporary storage
oauthTokenStore.delete(oauth_token as string);
```

## Posting and media (verbatim)

```ts
async postTweet(text: string): Promise<{ id: string; text: string }> {
  const tweet = await this.client.v2.tweet(text);
  return { id: tweet.data.id, text: tweet.data.text };
}

async postTweetWithMedia(text: string, mediaUrls: string[]): Promise<{ id: string; text: string }> {
  // Upload media first
  const mediaIds: string[] = [];

  for (const url of mediaUrls) {
    // Fetch image from URL
    const response = await fetch(url);
    const buffer = Buffer.from(await response.arrayBuffer());

    // Upload to Twitter
    const mediaId = await this.client.v1.uploadMedia(buffer, {
      mimeType: response.headers.get('content-type') || 'image/jpeg',
    });
    mediaIds.push(mediaId);
  }

  // Post tweet with media (max 4 images)
  const tweet = await this.client.v2.tweet(text, {
    media: { media_ids: mediaIds.slice(0, 4) as [string] | [string, string] | [string, string, string] | [string, string, string, string] },
  });

  return { id: tweet.data.id, text: tweet.data.text };
}
```

Three things worth keeping:

- **Media upload is `v1`, posting is `v2`.** They are different API versions in the same
  client. This is the "media upload is a separate step" warning in
  [08 — Platform integrations](../08-platform-integrations.md), made concrete.
- **Maximum four images**, and `twitter-api-v2` types `media_ids` as a fixed-length tuple
  union, which is why that cast is there. It is ugly but it is load-bearing.
- **The media is fetched over HTTP by URL, not read from disk.** That happens to be
  exactly the shape the new render pipeline wants, since renditions live in R2 and Meta
  fetches media by URL anyway.

## What W6 must change

| Prototype | New system | Why |
|-----------|-----------|-----|
| `process.env.TWITTER_API_KEY` inside the service | `ResolvedCredential` passed into every adapter method | [ADR-0009](../adr/0009-byo-platform-credentials.md) — clients bring their own X app |
| In-memory `Map` for leg 1→3 state | Signed `state` carrying `credentialId`, plus a short-TTL server-side row for `oauth_token_secret` | Survives multi-dyno and restarts; the callback must know *which* client's app secret to use for leg 3 |
| Tokens written to `User.twitterAccessToken` in plaintext | `SocialAccount` with encrypted values and a `credentialId` link | A token can only be refreshed or revoked by the app that minted it |
| Per-user callback URL built from `BACKEND_URL` | One canonical `https://<app-domain>/auth/:platform/callback` | Each client registers a single URL once |
| `console.log` of the auth link and error `data` | Pino, with the auth link and any error payload redacted | The authorize URL contains `oauth_token` |

## Setup knowledge

The X developer-portal setup steps from the old `TWITTER_INTEGRATION.md` moved into
[08 — Platform integrations](../08-platform-integrations.md#x) rather than here, because
they describe live configuration a client still has to perform.
