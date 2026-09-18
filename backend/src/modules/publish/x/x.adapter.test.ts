import { describe, expect, it, vi } from 'vitest';
import type { TwitterApi } from 'twitter-api-v2';
import type { ResolvedCredential } from '../adapter.types';
import { XAdapter, type TwitterClientFactory } from './x.adapter';
import { measureCaption } from '../../template/platform-spec';

/**
 * The X adapter, against a fake client.
 *
 * **No test in this file may reach the network.** The injected factory is the mechanism:
 * the adapter has no other way to construct a client, so a test that forgot to stub
 * something fails with a missing-method TypeError rather than quietly authenticating
 * against X with whatever key happened to be in the environment. `tests/env.ts` overwrites
 * the X keys with fakes as a second layer, but that layer only helps if a real call is
 * *attempted*, and by then a real call has been attempted.
 */

const credential: ResolvedCredential = {
  id: 'cred-1',
  mode: 'CLIENT_APP',
  platform: 'X',
  workspaceId: 'ws-1',
  brandId: 'brand-1',
  appId: 'fake-app-key',
  appSecret: 'fake-app-secret',
  redirectUri: 'https://example.test/api/auth/x/callback',
  grantedScopes: [],
};

const account = {
  externalId: '12345',
  tokens: { accessToken: 'fake-token', tokenSecret: 'fake-secret' },
  platformMeta: { xUserId: '12345' },
};

/** Builds a fake `TwitterApi` with only the methods a given test needs. */
function fakeClient(overrides: Record<string, unknown>): {
  factory: TwitterClientFactory;
  calls: Array<Record<string, unknown>>;
} {
  const calls: Array<Record<string, unknown>> = [];
  const factory = ((options: Record<string, unknown>) => {
    calls.push(options);
    return overrides as unknown as TwitterApi;
  }) as TwitterClientFactory;
  return { factory, calls };
}

describe('XAdapter', () => {
  describe('getAuthUrl', () => {
    it('persists the request token secret before returning the URL', async () => {
      const order: string[] = [];
      const { factory } = fakeClient({
        generateAuthLink: async () => {
          order.push('generateAuthLink');
          return {
            url: 'https://api.x.com/oauth/authorize?oauth_token=rt',
            oauth_token: 'rt',
            oauth_token_secret: 'rts',
          };
        },
      });

      const persist = vi.fn(async () => {
        order.push('persist');
      });

      const url = await new XAdapter(factory).getAuthUrl(credential, 'signed-state', {
        persistRequestToken: persist,
      });

      expect(url).toContain('oauth_token=rt');
      expect(persist).toHaveBeenCalledWith({ token: 'rt', secret: 'rts' });
      // Order is the point. OAuth 1.0a never sends the token secret to the callback, so a
      // redirect issued before the secret is stored produces a handshake that *cannot* be
      // completed — and the user has already left for x.com by then.
      expect(order).toEqual(['generateAuthLink', 'persist']);
    });

    it('carries the signed state on the callback URL', async () => {
      let captured = '';
      const { factory } = fakeClient({
        generateAuthLink: async (callback: string) => {
          captured = callback;
          return { url: 'https://x.test/auth', oauth_token: 'rt', oauth_token_secret: 'rts' };
        },
      });

      await new XAdapter(factory).getAuthUrl(credential, 'signed-state', {});

      // OAuth 1.0a has no `state` parameter, so the callback URL is the only carrier. Lose
      // this and the callback cannot tell which credential to exchange with.
      expect(new URL(captured).searchParams.get('state')).toBe('signed-state');
    });
  });

  describe('connect', () => {
    it('exchanges the verifier using the leg-1 token pair', async () => {
      const { factory, calls } = fakeClient({
        login: async (verifier: string) => ({
          accessToken: 'at',
          accessSecret: 'as',
          userId: '99',
          screenName: 'buzzco',
          verifier,
        }),
      });

      const accounts = await new XAdapter(factory).connect(credential, {
        oauthVerifier: 'v1',
        requestToken: 'rt',
        requestTokenSecret: 'rts',
      });

      // The client must be built with the *request* token pair, not the app alone —
      // signing leg 3 with anything else returns 401.
      expect(calls[0]).toMatchObject({ accessToken: 'rt', accessSecret: 'rts' });
      expect(accounts).toHaveLength(1);
      expect(accounts[0]).toMatchObject({ platform: 'X', externalId: '99', handle: 'buzzco' });
      // OAuth 1.0a tokens do not expire; null keeps the health sweep from treating every
      // X account as perpetually stale.
      expect(accounts[0]!.tokens.expiresAt).toBeNull();
      expect(accounts[0]!.tokens.tokenSecret).toBe('as');
    });

    it('fails when handshake material is missing rather than calling X', async () => {
      const login = vi.fn();
      const { factory } = fakeClient({ login });

      await expect(
        new XAdapter(factory).connect(credential, { oauthVerifier: 'v1' }),
      ).rejects.toMatchObject({ errorClass: 'VALIDATION' });
      expect(login).not.toHaveBeenCalled();
    });
  });

  describe('publish', () => {
    it('posts a text tweet and returns the external id', async () => {
      const { factory, calls } = fakeClient({
        v2: { tweet: async () => ({ data: { id: '777', text: 'hi' } }) },
      });

      const result = await new XAdapter(factory).publish(credential, {
        account,
        caption: 'hello world',
        media: [],
        idempotencyKey: 'publish:target-1',
      });

      expect(result.externalPostId).toBe('777');
      expect(result.externalUrl).toContain('/status/777');
      // Signed with both the app secret and the user's token secret.
      expect(calls[0]).toMatchObject({ accessToken: 'fake-token', accessSecret: 'fake-secret' });
    });

    it('rejects an over-length caption as VALIDATION without calling X', async () => {
      const tweet = vi.fn();
      const { factory } = fakeClient({ v2: { tweet } });

      const error = await new XAdapter(factory)
        .publish(credential, {
          account,
          caption: 'x'.repeat(281),
          media: [],
          idempotencyKey: 'publish:target-1',
        })
        .catch((e) => e);

      // VALIDATION, emphatically not TRANSIENT. X answers an over-length tweet with a 403,
      // and a local rejection with no status would default to TRANSIENT and retry a post
      // that can never succeed until the user edits it.
      expect(error.errorClass).toBe('VALIDATION');
      expect(tweet).not.toHaveBeenCalled();
    });

    it('counts a caption X’s way, so it accepts what the composer said would fit', async () => {
      // The composer and the publisher have to agree, or the product schedules posts it
      // then refuses to send. They disagreed: this gate used a raw `.length` while the
      // composer used X's weighting, where a URL bills a flat 23 however long it is.
      //
      // This caption is deliberately in the gap — over 280 raw characters, under 280
      // weighted — which is the shape of any ordinary post containing a tracked link.
      const url =
        'https://riseandshore.example.com/menu/spring-specials?utm_source=x&utm_medium=social&utm_campaign=launch';
      const caption = 'Spring specials are live at Rise + Shore. '.repeat(5) + url;

      // The premise of the test, asserted rather than assumed: if a future edit made this
      // caption short enough to pass a naive length check, the test would still go green
      // while proving nothing.
      expect(caption.length).toBeGreaterThan(280);
      expect(measureCaption('X', caption).used).toBeLessThanOrEqual(280);

      const { factory } = fakeClient({
        v2: { tweet: async () => ({ data: { id: '778', text: caption } }) },
      });

      const result = await new XAdapter(factory).publish(credential, {
        account,
        caption,
        media: [],
        idempotencyKey: 'publish:target-2',
      });

      expect(result.externalPostId).toBe('778');
    });

    it('classifies a read-only app as CREDENTIAL, not AUTH', async () => {
      const { factory } = fakeClient({
        v2: {
          tweet: async () => {
            // The shape `twitter-api-v2` actually throws: HTTP status on `.code`, useful
            // text on `.data.detail`. Reading `.status`, or `.message`, would miss both.
            throw Object.assign(new Error('Request failed with code 403'), {
              code: 403,
              data: { detail: 'Read-only application cannot POST' },
            });
          },
        },
      });

      const error = await new XAdapter(factory)
        .publish(credential, {
          account,
          caption: 'hi',
          media: [],
          idempotencyKey: 'publish:target-1',
        })
        .catch((e) => e);

      // The distinction that matters to the user: fix one app setting, not reconnect
      // every account.
      expect(error.errorClass).toBe('CREDENTIAL');
    });

    it('rejects unsupported media before uploading', async () => {
      const uploadMedia = vi.fn();
      const { factory } = fakeClient({ v1: { uploadMedia }, v2: { tweet: vi.fn() } });

      const error = await new XAdapter(factory)
        .publish(credential, {
          account,
          caption: 'hi',
          media: [{ url: 'https://example.test/a.tiff', mimeType: 'image/tiff' }],
          idempotencyKey: 'publish:target-1',
        })
        .catch((e) => e);

      expect(error.errorClass).toBe('VALIDATION');
      expect(uploadMedia).not.toHaveBeenCalled();
    });
  });

  describe('refresh', () => {
    it('returns the existing tokens rather than calling X', async () => {
      // Not a stub-and-forget: OAuth 1.0a genuinely has no refresh. Returning the existing
      // set lets the health sweep treat every platform uniformly.
      const { factory, calls } = fakeClient({});
      const tokens = await new XAdapter(factory).refresh(credential, account);

      expect(tokens).toEqual(account.tokens);
      expect(calls).toHaveLength(0);
    });
  });

  describe('validate', () => {
    it('reports REVOKED when the platform rejects the token', async () => {
      const { factory } = fakeClient({
        v2: {
          me: async () => {
            throw Object.assign(new Error('Unauthorized'), {
              code: 401,
              data: { detail: 'Invalid or expired token' },
            });
          },
        },
      });

      const health = await new XAdapter(factory).validate(credential, account);
      // REVOKED rather than ERROR drives the cascade that BLOCKs scheduled targets, so the
      // distinction is load-bearing rather than cosmetic.
      expect(health.status).toBe('REVOKED');
    });

    it('reports ACTIVE for a working token', async () => {
      const { factory } = fakeClient({ v2: { me: async () => ({ data: { id: '1' } }) } });
      const health = await new XAdapter(factory).validate(credential, account);
      expect(health.status).toBe('ACTIVE');
    });
  });

  describe('fetchMetrics', () => {
    it('normalises retweets to shares', async () => {
      const { factory } = fakeClient({
        v2: {
          singleTweet: async () => ({
            data: {
              public_metrics: {
                impression_count: 10,
                like_count: 3,
                retweet_count: 2,
                reply_count: 1,
                bookmark_count: 4,
              },
            },
          }),
        },
      });

      const metrics = await new XAdapter(factory).fetchMetrics(credential, {
        externalPostId: '777',
        account,
      });

      // X's vocabulary is not the spine's. Normalising here keeps outcome rollups
      // platform-agnostic instead of teaching every consumer about retweets.
      expect(metrics.shares).toBe(2);
      expect(metrics.impressions).toBe(10);
      expect(metrics.saves).toBe(4);
      // Genuinely unavailable, and null is the honest answer — zero would be a number the
      // outcome loop would happily average.
      expect(metrics.reach).toBeNull();
    });
  });
});
