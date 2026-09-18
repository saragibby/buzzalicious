import { describe, expect, it } from 'vitest';
import type { PublishInput, ResolvedCredential, StoredAccount } from '../adapter.types';
import { isPlatformError } from '../publish.errors';
import { FacebookAdapter } from './facebook.adapter';
import { InstagramAdapter } from './instagram.adapter';
import { ThreadsAdapter } from './threads.adapter';
import { FakeGraph, instantSleep } from './graph.fake';

const CRED: ResolvedCredential = {
  id: 'cred-1',
  mode: 'CLIENT_APP',
  platform: 'FACEBOOK',
  workspaceId: 'ws-1',
  brandId: 'brand-1',
  appId: 'app-123',
  appSecret: 'app-secret',
  redirectUri: 'https://buzzalicious.test/oauth/callback',
  grantedScopes: ['pages_manage_posts', 'pages_show_list'],
};

function publishInput(overrides: Partial<PublishInput> = {}): PublishInput {
  return {
    account: { externalId: 'acct-1', tokens: { accessToken: 'page-token' } },
    caption: 'hello world',
    media: [],
    idempotencyKey: 'target-1',
    ...overrides,
  };
}

const IMAGE = { url: 'https://cdn.test/a.png', mimeType: 'image/png' };

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  return promise.catch((error: unknown) => error);
}

describe('FacebookAdapter', () => {
  it('returns every Page the user administers, not just the first', async () => {
    const fake = new FakeGraph([
      { match: 'oauth/access_token', body: { access_token: 'short' }, repeat: true },
      {
        match: 'me/accounts',
        body: {
          data: [
            { id: '1', name: 'Bakery', access_token: 'tok-1', tasks: ['CREATE_CONTENT'] },
            { id: '2', name: 'Cafe', access_token: 'tok-2', tasks: ['CREATE_CONTENT'] },
          ],
        },
      },
    ]);

    const accounts = await new FacebookAdapter({ fetchImpl: fake.fetch }).connect(CRED, {
      code: 'auth-code',
    });

    // The prototype returned one account here and silently dropped the rest, which to an
    // agency or a multi-location business looks like the connection simply failed.
    expect(accounts.map((a) => a.externalId)).toEqual(['1', '2']);
    expect(accounts.map((a) => a.tokens.accessToken)).toEqual(['tok-1', 'tok-2']);
  });

  it('stores the Page token rather than the user token', async () => {
    const fake = new FakeGraph([
      { match: 'oauth/access_token', body: { access_token: 'USER-TOKEN' }, repeat: true },
      {
        match: 'me/accounts',
        body: {
          data: [
            { id: '1', name: 'Bakery', access_token: 'PAGE-TOKEN', tasks: ['CREATE_CONTENT'] },
          ],
        },
      },
    ]);

    const [account] = await new FacebookAdapter({ fetchImpl: fake.fetch }).connect(CRED, {
      code: 'auth-code',
    });

    // A user token cannot publish to a Page. Storing it produces an account that connects
    // cleanly and fails on its first post.
    expect(account!.tokens.accessToken).toBe('PAGE-TOKEN');
    expect(account!.tokens.accessToken).not.toBe('USER-TOKEN');
  });

  it('exchanges the short-lived code token for a long-lived one', async () => {
    const fake = new FakeGraph([
      { match: 'oauth/access_token', body: { access_token: 'short-lived' } },
      { match: 'oauth/access_token', body: { access_token: 'long-lived', expires_in: 5184000 } },
      {
        match: 'me/accounts',
        body: { data: [{ id: '1', access_token: 'p', tasks: ['CREATE_CONTENT'] }] },
      },
    ]);

    await new FacebookAdapter({ fetchImpl: fake.fetch }).connect(CRED, { code: 'auth-code' });

    const exchanges = fake.requestsMatching('oauth/access_token');
    // Two calls, not one. A code exchange yields roughly an hour of validity; shipping
    // that is how a product works all through testing and breaks the next morning.
    expect(exchanges).toHaveLength(2);
    expect(exchanges[1]!.url).toContain('grant_type=fb_exchange_token');
    expect(exchanges[1]!.url).toContain('fb_exchange_token=short-lived');
  });

  it('drops Pages the user cannot post to, and says so when none remain', async () => {
    const fake = new FakeGraph([
      { match: 'oauth/access_token', body: { access_token: 'short' }, repeat: true },
      {
        match: 'me/accounts',
        body: {
          data: [{ id: '1', name: 'Analytics only', access_token: 't', tasks: ['ANALYZE'] }],
        },
      },
    ]);

    const error = await captureError(
      new FacebookAdapter({ fetchImpl: fake.fetch }).connect(CRED, { code: 'c' }),
    );

    expect(isPlatformError(error)).toBe(true);
    // CREDENTIAL, because the fix is a role change by the client — not something a retry
    // or a different post could ever resolve.
    expect(isPlatformError(error) && error.errorClass).toBe('CREDENTIAL');
    expect(isPlatformError(error) && error.message).toContain('permission to create posts');
  });

  it('keeps a Page whose tasks Meta omitted rather than hiding a usable Page', async () => {
    const fake = new FakeGraph([
      { match: 'oauth/access_token', body: { access_token: 'short' }, repeat: true },
      { match: 'me/accounts', body: { data: [{ id: '9', name: 'Legacy', access_token: 't' }] } },
    ]);

    const accounts = await new FacebookAdapter({ fetchImpl: fake.fetch }).connect(CRED, {
      code: 'c',
    });

    expect(accounts.map((a) => a.externalId)).toEqual(['9']);
  });

  it('posts text to the Page feed', async () => {
    const fake = new FakeGraph([{ match: '/feed', body: { id: '111_222' } }]);

    const result = await new FacebookAdapter({ fetchImpl: fake.fetch }).publish(
      CRED,
      publishInput({
        account: {
          externalId: 'acct',
          tokens: { accessToken: 'page-token' },
          platformMeta: { facebookPageId: '111' },
        },
      }),
    );

    expect(fake.lastRequest!.url).toContain('/111/feed');
    expect(fake.lastRequest!.form.message).toBe('hello world');
    expect(result.externalPostId).toBe('111_222');
    expect(result.externalUrl).toBe('https://www.facebook.com/111/posts/222');
  });

  it('uploads several photos unpublished and attaches them to one post', async () => {
    const fake = new FakeGraph([
      { match: '/photos', body: { id: 'photo-1' } },
      { match: '/photos', body: { id: 'photo-2' } },
      { match: '/feed', body: { id: '111_333' } },
    ]);

    await new FacebookAdapter({ fetchImpl: fake.fetch }).publish(
      CRED,
      publishInput({
        media: [IMAGE, { url: 'https://cdn.test/b.png', mimeType: 'image/png' }],
        account: {
          externalId: 'acct',
          tokens: { accessToken: 'page-token' },
          platformMeta: { facebookPageId: '111' },
        },
      }),
    );

    const photos = fake.requestsMatching('/photos');
    // Unpublished, or this is three posts instead of one.
    expect(photos.every((request) => request.form.published === 'false')).toBe(true);

    const feed = fake.requestsMatching('/feed')[0]!;
    expect(feed.form['attached_media[0]']).toBe('{"media_fbid":"photo-1"}');
    expect(feed.form['attached_media[1]']).toBe('{"media_fbid":"photo-2"}');
  });

  it('reports a dead token as REVOKED so dependent targets get blocked', async () => {
    const fake = new FakeGraph([
      {
        match: '/acct-1',
        status: 400,
        body: { error: { message: 'gone', code: 190, error_subcode: 458 } },
      },
    ]);
    const account: StoredAccount = { externalId: 'acct-1', tokens: { accessToken: 'dead' } };

    const health = await new FacebookAdapter({ fetchImpl: fake.fetch }).validate(CRED, account);

    expect(health.status).toBe('REVOKED');
    expect(health.message).toBeTruthy();
  });

  it('reports a transient failure as ERROR, not REVOKED', async () => {
    const fake = new FakeGraph([
      { match: '/acct-1', status: 500, body: { error: { message: 'oops', code: 2 } } },
    ]);

    const health = await new FacebookAdapter({ fetchImpl: fake.fetch }).validate(CRED, {
      externalId: 'acct-1',
      tokens: { accessToken: 't' },
    });

    // The distinction is the whole point: REVOKED blocks scheduled posts, ERROR does not.
    // Blocking a client's queue because Meta had a bad minute would be worse than the bug.
    expect(health.status).toBe('ERROR');
  });

  it('names the exact missing scope in a pre-flight report', async () => {
    const fake = new FakeGraph([
      {
        match: 'debug_token',
        body: { data: { is_valid: true, scopes: ['pages_show_list', 'pages_read_engagement'] } },
      },
    ]);

    const report = await new FacebookAdapter({ fetchImpl: fake.fetch }).introspect({
      ...CRED,
      directToken: 'user-token',
    });

    expect(report.status).toBe('INSUFFICIENT');
    // Naming the scope is what turns an invisible failure into an actionable task.
    expect(report.summary).toContain('pages_manage_posts');
    expect(report.capabilities.publish_text?.missingScopes).toEqual(['pages_manage_posts']);
    expect(report.capabilities.publish_text?.supported).toBe(false);
  });

  it('does not block publishing over a missing insights scope', async () => {
    const fake = new FakeGraph([
      {
        match: 'debug_token',
        body: { data: { is_valid: true, scopes: ['pages_manage_posts', 'pages_show_list'] } },
      },
    ]);

    const report = await new FacebookAdapter({ fetchImpl: fake.fetch }).introspect({
      ...CRED,
      directToken: 'user-token',
    });

    // Missing metrics is a degraded product; missing publishing is a broken one. Meta
    // reviews `read_insights` separately and more slowly, so conflating them would stop a
    // client posting at all over a permission they are still waiting on.
    expect(report.status).toBe('ACTIVE');
    expect(report.capabilities.read_insights?.supported).toBe(false);
  });
});

describe('InstagramAdapter', () => {
  const IG_ACCOUNT = {
    externalId: 'ig-1',
    tokens: { accessToken: 'page-token' },
    platformMeta: { instagramUserId: 'ig-1' },
  };

  it('finds Business accounts through the Pages they are linked to', async () => {
    const fake = new FakeGraph([
      { match: 'oauth/access_token', body: { access_token: 'tok' }, repeat: true },
      {
        match: 'me/accounts',
        body: {
          data: [
            {
              id: 'p1',
              name: 'Bakery',
              access_token: 'page-tok',
              instagram_business_account: { id: 'ig-1', username: 'bakery' },
            },
            { id: 'p2', name: 'No IG', access_token: 'page-tok-2' },
          ],
        },
      },
    ]);

    const accounts = await new InstagramAdapter({ fetchImpl: fake.fetch }, instantSleep).connect(
      CRED,
      { code: 'c' },
    );

    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.externalId).toBe('ig-1');
    expect(accounts[0]!.handle).toBe('bakery');
    expect(accounts[0]!.platformMeta?.facebookPageId).toBe('p1');
  });

  it('explains the personal-account case instead of failing vaguely', async () => {
    const fake = new FakeGraph([
      { match: 'oauth/access_token', body: { access_token: 'tok' }, repeat: true },
      { match: 'me/accounts', body: { data: [{ id: 'p1', name: 'Bakery', access_token: 't' }] } },
    ]);

    const error = await captureError(
      new InstagramAdapter({ fetchImpl: fake.fetch }, instantSleep).connect(CRED, { code: 'c' }),
    );

    // The most common Instagram support case by a wide margin, and it is a setting the
    // client can change — so the message names it rather than saying "it didn't work".
    expect(isPlatformError(error) && error.message).toContain('Business or Creator');
  });

  it('distinguishes having no Pages at all from having no linked account', async () => {
    const fake = new FakeGraph([
      { match: 'oauth/access_token', body: { access_token: 'tok' }, repeat: true },
      { match: 'me/accounts', body: { data: [] } },
    ]);

    const error = await captureError(
      new InstagramAdapter({ fetchImpl: fake.fetch }, instantSleep).connect(CRED, { code: 'c' }),
    );

    expect(isPlatformError(error) && error.message).toContain('No Facebook Pages');
  });

  it('refuses a text-only post locally rather than via a confusing Graph error', async () => {
    const fake = new FakeGraph([]);

    const error = await captureError(
      new InstagramAdapter({ fetchImpl: fake.fetch }, instantSleep).publish(
        CRED,
        publishInput({ account: IG_ACCOUNT, media: [] }),
      ),
    );

    expect(isPlatformError(error) && error.errorClass).toBe('VALIDATION');
    expect(isPlatformError(error) && error.message).toContain('at least one image');
    // Nothing was sent. A local rejection that still hits the network is not one.
    expect(fake.requests).toHaveLength(0);
  });

  it('creates a container, waits for it, then publishes it', async () => {
    const fake = new FakeGraph([
      { match: '/ig-1/media', body: { id: 'container-1' } },
      { match: '/container-1', body: { status_code: 'FINISHED' } },
      { match: '/ig-1/media_publish', body: { id: 'media-99' } },
      { match: '/media-99', body: { permalink: 'https://instagram.com/p/abc' } },
    ]);

    const result = await new InstagramAdapter({ fetchImpl: fake.fetch }, instantSleep).publish(
      CRED,
      publishInput({ account: IG_ACCOUNT, media: [IMAGE] }),
    );

    // The container id is not a post id. Returning it yields an identifier that looks
    // valid and resolves to nothing.
    expect(result.externalPostId).toBe('media-99');
    expect(result.externalUrl).toBe('https://instagram.com/p/abc');
    expect(result.platformMeta?.instagramContainerId).toBe('container-1');
  });

  it('polls until the container is ready rather than publishing too early', async () => {
    const fake = new FakeGraph([
      { match: '/ig-1/media', body: { id: 'c1' } },
      { match: '/c1', body: { status_code: 'IN_PROGRESS' } },
      { match: '/c1', body: { status_code: 'IN_PROGRESS' } },
      { match: '/c1', body: { status_code: 'FINISHED' } },
      { match: '/ig-1/media_publish', body: { id: 'm1' } },
      { match: '/m1', body: { permalink: 'https://instagram.com/p/x' } },
    ]);

    await new InstagramAdapter({ fetchImpl: fake.fetch }, instantSleep).publish(
      CRED,
      publishInput({ account: IG_ACCOUNT, media: [IMAGE] }),
    );

    // Publishing an IN_PROGRESS container fails with a generic parameter error that gives
    // no hint the answer is simply to wait.
    expect(fake.requestsMatching('/c1')).toHaveLength(3);
  });

  it('treats a rejected image as VALIDATION, because the identical retry cannot work', async () => {
    const fake = new FakeGraph([
      { match: '/ig-1/media', body: { id: 'c1' } },
      { match: '/c1', body: { status_code: 'ERROR', status: 'Aspect ratio not supported' } },
    ]);

    const error = await captureError(
      new InstagramAdapter({ fetchImpl: fake.fetch }, instantSleep).publish(
        CRED,
        publishInput({ account: IG_ACCOUNT, media: [IMAGE] }),
      ),
    );

    expect(isPlatformError(error) && error.errorClass).toBe('VALIDATION');
    expect(isPlatformError(error) && error.message).toContain('Aspect ratio');
  });

  it('builds a carousel from children that carry no caption of their own', async () => {
    const fake = new FakeGraph([
      { match: '/ig-1/media', body: { id: 'child-1' } },
      { match: '/ig-1/media', body: { id: 'child-2' } },
      { match: '/ig-1/media', body: { id: 'carousel' } },
      { match: '/carousel', body: { status_code: 'FINISHED' } },
      { match: '/ig-1/media_publish', body: { id: 'm2' } },
      { match: '/m2', body: { permalink: 'https://instagram.com/p/y' } },
    ]);

    await new InstagramAdapter({ fetchImpl: fake.fetch }, instantSleep).publish(
      CRED,
      publishInput({
        account: IG_ACCOUNT,
        media: [IMAGE, { url: 'https://cdn.test/b.png', mimeType: 'image/png' }],
      }),
    );

    const creates = fake.requestsMatching('/ig-1/media').filter((r) => r.method === 'POST');
    expect(creates[0]!.form.is_carousel_item).toBe('true');
    // A carousel child carrying a caption is rejected outright.
    expect(creates[0]!.form.caption).toBeUndefined();
    expect(creates[2]!.form.media_type).toBe('CAROUSEL');
    expect(creates[2]!.form.children).toBe('child-1,child-2');
    expect(creates[2]!.form.caption).toBe('hello world');
  });

  it('still reports a publish that succeeded when the permalink lookup fails', async () => {
    const fake = new FakeGraph([
      { match: '/ig-1/media', body: { id: 'c1' } },
      { match: '/c1', body: { status_code: 'FINISHED' } },
      { match: '/ig-1/media_publish', body: { id: 'm3' } },
      { match: '/m3', status: 500, body: { error: { message: 'nope' } } },
    ]);

    const result = await new InstagramAdapter({ fetchImpl: fake.fetch }, instantSleep).publish(
      CRED,
      publishInput({ account: IG_ACCOUNT, media: [IMAGE] }),
    );

    // A post that went out and a job that reports failure is the worst outcome in the
    // whole pipeline: the retry posts it twice.
    expect(result.externalPostId).toBe('m3');
    expect(result.externalUrl).toBeUndefined();
  });
});

describe('ThreadsAdapter', () => {
  const TH_ACCOUNT = {
    externalId: 'th-1',
    tokens: { accessToken: 'th-token' },
    platformMeta: { threadsUserId: 'th-1' },
  };

  it('uses the Threads spelling of the token exchange, not the Facebook one', async () => {
    const fake = new FakeGraph([
      { match: 'oauth/access_token', body: { access_token: 'short', user_id: 'th-1' } },
      { match: 'access_token', body: { access_token: 'long', expires_in: 5184000 } },
      { match: '/me', body: { id: 'th-1', username: 'bakery' } },
    ]);

    const accounts = await new ThreadsAdapter({ fetchImpl: fake.fetch }, instantSleep).connect(
      CRED,
      { code: 'c' },
    );

    const exchange = fake.requestsMatching('access_token')[1]!;
    // `fb_exchange_token` here returns a 400 that says nothing about the parameter name.
    expect(exchange.url).toContain('grant_type=th_exchange_token');
    expect(accounts[0]!.handle).toBe('bakery');
    expect(accounts[0]!.tokens.accessToken).toBe('long');
    expect(accounts[0]!.tokens.expiresAt).toBeInstanceOf(Date);
  });

  it('refreshes through the endpoint only Threads has', async () => {
    const fake = new FakeGraph([
      { match: 'refresh_access_token', body: { access_token: 'renewed', expires_in: 5184000 } },
    ]);

    const tokens = await new ThreadsAdapter({ fetchImpl: fake.fetch }, instantSleep).refresh(CRED, {
      externalId: 'th-1',
      tokens: { accessToken: 'current', scopes: ['threads_basic'] },
    });

    expect(fake.lastRequest!.url).toContain('grant_type=th_refresh_token');
    expect(tokens.accessToken).toBe('renewed');
    expect(tokens.scopes).toEqual(['threads_basic']);
  });

  it('posts text through a container', async () => {
    const fake = new FakeGraph([
      { match: '/th-1/threads', body: { id: 'c1' } },
      { match: '/th-1/threads_publish', body: { id: 'p1' } },
      { match: '/p1', body: { permalink: 'https://threads.net/@bakery/post/1' } },
    ]);

    const result = await new ThreadsAdapter({ fetchImpl: fake.fetch }, instantSleep).publish(
      CRED,
      publishInput({ account: TH_ACCOUNT }),
    );

    const create = fake.requestsMatching('/th-1/threads')[0]!;
    expect(create.form.media_type).toBe('TEXT');
    expect(create.form.text).toBe('hello world');
    expect(result.externalPostId).toBe('p1');
  });

  it('says plainly that its pre-flight is not a live check', async () => {
    const fake = new FakeGraph([{ match: '/me', body: { id: 'th-1', username: 'bakery' } }]);

    const report = await new ThreadsAdapter({ fetchImpl: fake.fetch }, instantSleep).introspect({
      ...CRED,
      directToken: 'token',
      grantedScopes: ['threads_basic', 'threads_content_publish', 'threads_manage_insights'],
    });

    expect(report.status).toBe('ACTIVE');
    // Threads has no debug_token. Presenting connect-time scopes as a verified check would
    // be a claim we cannot support.
    expect(report.summary).toContain('does not publish a token inspection endpoint');
  });

  it('sums reposts and quotes into shares, keeping "no data" distinct from zero', async () => {
    const withData = new FakeGraph([
      {
        match: '/insights',
        body: {
          data: [
            { name: 'reposts', values: [{ value: 3 }] },
            { name: 'quotes', values: [{ value: 2 }] },
          ],
        },
      },
    ]);
    const withNothing = new FakeGraph([{ match: '/insights', body: { data: [] } }]);

    const target = { externalPostId: 'p1', account: TH_ACCOUNT };
    const a = await new ThreadsAdapter({ fetchImpl: withData.fetch }, instantSleep).fetchMetrics(
      CRED,
      target,
    );
    const b = await new ThreadsAdapter({ fetchImpl: withNothing.fetch }, instantSleep).fetchMetrics(
      CRED,
      target,
    );

    expect(a.shares).toBe(5);
    // Not 0. "Threads told us nothing" and "nobody shared it" are different facts, and
    // collapsing them would put fabricated zeroes into the outcome loop this product is
    // built around.
    expect(b.shares).toBeNull();
  });
});
