import type { Platform } from '@prisma/client';
import { TwitterApi } from 'twitter-api-v2';
import {
  buildAdapterSpec,
  type AccountHealth,
  type AuthUrlContext,
  type CapabilityReport,
  type ConnectedAccount,
  type MetricsTarget,
  type OAuthCallback,
  type PlatformAdapter,
  type PlatformMetrics,
  type PlatformSpec,
  type PublishInput,
  type PublishResult,
  type ResolvedCredential,
  type StoredAccount,
  type TokenSet,
} from '../adapter.types';
import { classifyPlatformError, isPlatformError, type PlatformError } from '../publish.errors';
import { measureCaption } from '../../template/platform-spec';

/**
 * Translate whatever `twitter-api-v2` threw into the shape the taxonomy classifies.
 *
 * The library throws `ApiResponseError`, which carries the HTTP status on `.code` — not
 * `.status`, which is the trap — and puts the useful text in `.data.detail` while
 * `.message` is a generic wrapper. Classifying on `.message` alone would mean the X
 * read-only rule in `MESSAGE_RULES` never matches, so the most important
 * X-specific classification would silently never fire.
 */
function xFailure(error: unknown): Parameters<typeof classifyPlatformError>[0] {
  const err = error as {
    code?: unknown;
    message?: unknown;
    data?: { detail?: unknown; errors?: Array<{ message?: unknown }> };
    rateLimit?: { reset?: unknown };
  };

  const status = typeof err?.code === 'number' ? err.code : undefined;
  const detail =
    typeof err?.data?.detail === 'string'
      ? err.data.detail
      : typeof err?.data?.errors?.[0]?.message === 'string'
        ? err.data.errors[0].message
        : undefined;
  const message =
    detail ?? (typeof err?.message === 'string' ? err.message : 'Unknown platform error');

  // X reports the reset as an epoch second, not a delay.
  const reset = err?.rateLimit?.reset;
  const retryAfterSeconds =
    typeof reset === 'number' ? Math.max(1, Math.ceil(reset - Date.now() / 1000)) : undefined;

  return { platform: 'X', status, message, retryAfterSeconds, cause: error };
}

/**
 * Convert a thrown value into a classified `PlatformError`, preserving one it already is.
 *
 * The guard is essential rather than defensive. `publish()` wraps its whole body in a
 * try/catch, and some of the failures raised inside that body are ones *we* classified —
 * an over-length caption, an unsupported MIME type. Passing those back through
 * `xFailure()` strips the class: a `PlatformError` carries no `.code`, so the status is
 * undefined and `matchByStatus` defaults it to `TRANSIENT`. The visible effect is a post
 * that can never succeed being retried until it exhausts its attempts, and a user told to
 * wait rather than told to shorten their caption.
 */
function toPlatformError(error: unknown): PlatformError {
  return isPlatformError(error) ? error : classifyPlatformError(xFailure(error));
}

function rethrow(error: unknown): never {
  throw toPlatformError(error);
}

/**
 * A rejection we decided ourselves, before any network call.
 *
 * Deliberately not routed through `xFailure`: that produces no status, and
 * `matchByStatus(undefined)` defaults to `TRANSIENT` — so an over-length caption would be
 * retried until it exhausted its attempts instead of being reported to the user as
 * something they can fix. Local rejections state their class outright.
 */
function localRejection(
  message: string,
  errorClass: 'VALIDATION' | 'TRANSIENT',
): ReturnType<typeof classifyPlatformError> {
  // Reuses the taxonomy's status mapping rather than hand-building a PlatformError, so
  // the client-facing wording stays in one place.
  return classifyPlatformError({
    platform: 'X',
    status: errorClass === 'VALIDATION' ? 422 : 503,
    message,
  });
}

/**
 * X (Twitter) adapter.
 *
 * X is the odd one out and it is worth being explicit about why, because the shape of
 * this file is mostly a consequence of it: X is the only v1 platform on **OAuth 1.0a**.
 * That has three knock-on effects the OAuth 2.0 adapters do not have —
 *
 *  - there is no `state` parameter in the protocol, so CSRF binding has to be carried in
 *    the callback URL and matched against a stored nonce (see `oauth/state.ts`);
 *  - leg 1 mints a request token *pair*, and the secret is never sent to the callback,
 *    so it must be persisted before the redirect or leg 3 is impossible;
 *  - tokens do not expire and there is no refresh, so `refresh()` is a no-op rather than
 *    an unimplemented method.
 *
 * Everything here is pure translation. The adapter holds no database handle and persists
 * nothing itself; leg-1 material goes out through `context.persistRequestToken`.
 */

/**
 * How a `TwitterApi` gets built. Injectable for one reason, and it is the reason
 * non-negotiable #5 exists: with a real constructor, a test that merely *constructs* the
 * adapter is one typo away from a live authenticated call to X. Tests pass a fake here,
 * so reaching the network is not something a test can do by accident — it would have to
 * deliberately supply the real factory.
 */
export type TwitterClientFactory = (options: {
  appKey: string;
  appSecret: string;
  accessToken?: string;
  accessSecret?: string;
}) => TwitterApi;

const defaultFactory: TwitterClientFactory = (options) => new TwitterApi(options);

/** Media X will accept in a v1 upload. Anything else is rejected before the network. */
const SUPPORTED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

const MAX_MEDIA = 4;

/**
 * `media_ids` is typed as a fixed-length tuple of 1–4, because that is genuinely the
 * platform limit rather than a library quirk. The cast is confined to this one helper so
 * the length check and the cast cannot drift apart.
 */
type MediaIdTuple =
  [string] | [string, string] | [string, string, string] | [string, string, string, string];

function asMediaIds(ids: readonly string[]): MediaIdTuple {
  return ids.slice(0, MAX_MEDIA) as unknown as MediaIdTuple;
}

/**
 * X's spec.
 *
 * The caption limit, ratios, `mediaRequired` and `linkBehavior` are no longer stated here
 * — they come from the shared table, which is the same one the composer counts against.
 * 280 is the standard-account limit; Premium raises it, but we cannot tell a client's tier
 * without an extra call, and being wrong in the permissive direction means a publish that
 * fails at the platform after the user thought it was scheduled.
 */
export const X_SPEC: PlatformSpec = buildAdapterSpec('X', {
  maxMediaCount: MAX_MEDIA,
  supportsScheduling: false,
  requiredScopes: {
    // OAuth 1.0a has no scope strings — access is an app-level permission setting
    // ("Read" vs "Read and write"). The empty arrays are honest: pre-flight cannot
    // determine capability from scopes here, so `introspect()` probes instead.
    publish_text: [],
    publish_image: [],
    publish_carousel: [],
    publish_video: [],
    read_insights: [],
    read_hashtags: [],
  },
});

export class XAdapter implements PlatformAdapter {
  readonly platform: Platform = 'X';
  readonly specs = X_SPEC;

  constructor(private readonly createClient: TwitterClientFactory = defaultFactory) {}

  private appClient(cred: ResolvedCredential): TwitterApi {
    return this.createClient({ appKey: cred.appId, appSecret: cred.appSecret });
  }

  private userClient(cred: ResolvedCredential, tokens: TokenSet): TwitterApi {
    return this.createClient({
      appKey: cred.appId,
      appSecret: cred.appSecret,
      accessToken: tokens.accessToken,
      // OAuth 1.0a signs every request with the user's token secret as well as the app
      // secret. A missing `tokenSecret` produces a 401 that reads like a revoked token,
      // which is a genuinely confusing failure, so it is worth never omitting.
      accessSecret: tokens.tokenSecret,
    });
  }

  async getAuthUrl(
    cred: ResolvedCredential,
    state: string,
    context: AuthUrlContext,
  ): Promise<string> {
    try {
      const client = this.appClient(cred);
      // The signed state rides on the callback URL because OAuth 1.0a has nowhere else to
      // put it — X echoes back only `oauth_token` and `oauth_verifier`.
      const callback = new URL(cred.redirectUri);
      callback.searchParams.set('state', state);

      const link = await client.generateAuthLink(callback.toString(), { linkMode: 'authorize' });

      // Persist before returning. If this throws, the user is never redirected, which is
      // the correct order: a redirect with no stored secret is an unfinishable flow.
      await context.persistRequestToken?.({
        token: link.oauth_token,
        secret: link.oauth_token_secret,
      });

      return link.url;
    } catch (error) {
      rethrow(error);
    }
  }

  async connect(cred: ResolvedCredential, callback: OAuthCallback): Promise<ConnectedAccount[]> {
    if (!callback.oauthVerifier || !callback.requestToken || !callback.requestTokenSecret) {
      // Reached only if the handshake row was consumed without leg-1 material, which
      // means a bug here rather than anything the user did.
      throw localRejection('Missing OAuth 1.0a handshake material', 'VALIDATION');
    }

    try {
      const client = this.createClient({
        appKey: cred.appId,
        appSecret: cred.appSecret,
        accessToken: callback.requestToken,
        accessSecret: callback.requestTokenSecret,
      });

      const login = await client.login(callback.oauthVerifier);

      return [
        {
          platform: 'X',
          externalId: login.userId,
          handle: login.screenName,
          displayName: login.screenName,
          tokens: {
            accessToken: login.accessToken,
            tokenSecret: login.accessSecret,
            // OAuth 1.0a access tokens do not expire. Null is the accurate answer and it
            // keeps the health sweep from treating X accounts as perpetually stale.
            expiresAt: null,
          },
          platformMeta: { xUserId: login.userId },
        },
      ];
    } catch (error) {
      rethrow(error);
    }
  }

  async refresh(_cred: ResolvedCredential, account: StoredAccount): Promise<TokenSet> {
    // Not an oversight and not unimplemented: OAuth 1.0a tokens are valid until revoked.
    // Returning the existing set means the health sweep can call `refresh()` uniformly
    // across platforms without a per-platform conditional.
    return account.tokens;
  }

  async validate(cred: ResolvedCredential, account: StoredAccount): Promise<AccountHealth> {
    const checkedAt = new Date();
    try {
      await this.userClient(cred, account.tokens).v2.me();
      return { status: 'ACTIVE', checkedAt };
    } catch (error) {
      const platformError = toPlatformError(error);
      // AUTH here means the user revoked our access in their X settings, which is a
      // REVOKED account rather than a transient failure — the distinction drives whether
      // scheduled targets get BLOCKED.
      const status =
        platformError.errorClass === 'AUTH'
          ? 'REVOKED'
          : platformError.errorClass === 'CREDENTIAL'
            ? 'ERROR'
            : 'ERROR';
      return { status, checkedAt, message: platformError.clientMessage };
    }
  }

  /**
   * Pre-flight for X.
   *
   * Unlike the Meta platforms there are no granted scopes to compare against, so the only
   * way to know whether the client's app is "Read and write" is to ask. `v2.me()` proves
   * the tokens work; write permission is not directly queryable, so it is reported as
   * supported and the specific "Read-only application cannot POST" 403 is classified as a
   * CREDENTIAL error at publish time. That is a real limitation and is called out in
   * docs/08 rather than papered over with a fake probe.
   */
  async introspect(cred: ResolvedCredential): Promise<CapabilityReport> {
    const checkedAt = new Date();
    try {
      const me = await this.userClientFromCredential(cred).v2.me();
      const supported = { supported: true, missingScopes: [], checkedAt: checkedAt.toISOString() };
      return {
        status: 'ACTIVE',
        grantedScopes: [],
        capabilities: {
          publish_text: supported,
          publish_image: supported,
          publish_carousel: supported,
          publish_video: {
            supported: false,
            reason: 'Video publishing to X is not supported in v1.',
            missingScopes: [],
            checkedAt: checkedAt.toISOString(),
          },
          read_insights: supported,
          read_hashtags: {
            supported: false,
            reason: 'X does not expose hashtag search on the tiers we support.',
            missingScopes: [],
            checkedAt: checkedAt.toISOString(),
          },
        },
        summary: `Connected to X as @${me.data.username}. Posting and metrics are available.`,
        checkedAt,
      };
    } catch (error) {
      const platformError = toPlatformError(error);
      return {
        status: platformError.errorClass === 'CREDENTIAL' ? 'INSUFFICIENT' : 'INVALID',
        grantedScopes: [],
        capabilities: {},
        summary: platformError.clientMessage,
        checkedAt,
      };
    }
  }

  /**
   * DIRECT_TOKEN credentials carry the user tokens on the credential itself, which is the
   * day-one migration path in ADR-0009 — a client pastes tokens from their existing app
   * rather than completing an OAuth flow.
   */
  private userClientFromCredential(cred: ResolvedCredential): TwitterApi {
    return this.createClient({
      appKey: cred.appId,
      appSecret: cred.appSecret,
      accessToken: cred.directToken,
      accessSecret: cred.directTokenSecret,
    });
  }

  async publish(cred: ResolvedCredential, input: PublishInput): Promise<PublishResult> {
    // Counted X's way — URLs bill a flat 23 via t.co, emoji and CJK bill 2 — using the
    // same `measureCaption` the composer's counter and draft-save validation use.
    //
    // A raw `.length` here disagreed with the composer in the direction that hurts: a
    // 314-character caption whose URL is long weighs 233 to X, so the composer showed
    // "233/280, fits" and let the user schedule it, and this gate then rejected the
    // identical text at publish time. Any caption containing a link was a candidate,
    // which is most of them — link clicks are the metric this product exists to move.
    const measured = measureCaption('X', input.caption);
    if (measured.over) {
      // Caught before the network on purpose: X returns a 403 for an over-length tweet,
      // and a 403 would otherwise be classified as a credential problem and send the
      // client to re-check their app permissions for what is really a content bug.
      throw localRejection('Tweet exceeds the 280 character limit', 'VALIDATION');
    }

    try {
      const client = this.userClient(cred, input.account.tokens);
      const mediaIds = await this.uploadMedia(client, input);

      const tweet = await client.v2.tweet(
        input.caption,
        mediaIds.length > 0 ? { media: { media_ids: asMediaIds(mediaIds) } } : undefined,
      );

      return {
        externalPostId: tweet.data.id,
        externalUrl: `https://x.com/${input.account.platformMeta?.xUserId ?? 'i'}/status/${tweet.data.id}`,
        publishedAt: new Date(),
      };
    } catch (error) {
      rethrow(error);
    }
  }

  private async uploadMedia(client: TwitterApi, input: PublishInput): Promise<string[]> {
    const ids: string[] = [];

    for (const media of input.media.slice(0, MAX_MEDIA)) {
      if (!SUPPORTED_MIME.has(media.mimeType)) {
        throw localRejection(`X does not accept ${media.mimeType} media`, 'VALIDATION');
      }

      const response = await fetch(media.url);
      if (!response.ok) {
        // Our own signed URL failed, not X's. TRANSIENT is right — the usual cause is an
        // expired signature, and the retry mints a fresh one.
        throw localRejection(`Could not fetch media for upload (${response.status})`, 'TRANSIENT');
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      ids.push(await client.v1.uploadMedia(buffer, { mimeType: media.mimeType }));
    }

    return ids;
  }

  async fetchMetrics(cred: ResolvedCredential, target: MetricsTarget): Promise<PlatformMetrics> {
    try {
      const client = this.userClient(cred, target.account.tokens);
      const tweet = await client.v2.singleTweet(target.externalPostId, {
        'tweet.fields': ['public_metrics'],
      });

      const metrics = tweet.data.public_metrics;
      return {
        impressions: metrics?.impression_count ?? null,
        likes: metrics?.like_count ?? null,
        // X calls these retweets; the spine records shares. Same concept, and normalising
        // here keeps the outcome rollups platform-agnostic.
        shares: metrics?.retweet_count ?? null,
        comments: metrics?.reply_count ?? null,
        reach: null,
        saves: metrics?.bookmark_count ?? null,
        videoViews: null,
        collectedAt: new Date(),
      };
    } catch (error) {
      rethrow(error);
    }
  }
}
