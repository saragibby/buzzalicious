import { describe, expect, it } from 'vitest';
import { GraphClient } from './graph.client';
import { FakeGraph, networkFailureFetch } from './graph.fake';
import { classifyMetaError, graphError, META_CODE_CLASSES } from './meta.errors';
import { isPlatformError, policyFor } from '../publish.errors';

describe('GraphClient', () => {
  it('sends the access token in the body of a write, never the query string', async () => {
    const fake = new FakeGraph([{ match: '/me/feed', body: { id: '1_2' } }]);
    const client = new GraphClient('FACEBOOK', { fetchImpl: fake.fetch });

    await client.call({
      path: 'me/feed',
      method: 'POST',
      accessToken: 'secret-token',
      body: { message: 'hello' },
    });

    const request = fake.lastRequest!;
    // The property that matters: a token in a URL is a token in every access log,
    // proxy log and error tracker between here and Meta.
    expect(request.url).not.toContain('secret-token');
    expect(request.form.access_token).toBe('secret-token');
    expect(request.form.message).toBe('hello');
  });

  it('versions API paths but not the OAuth token endpoints', async () => {
    const fake = new FakeGraph([
      { match: '/me', body: { id: '1' } },
      { match: 'access_token', body: { access_token: 't' } },
    ]);
    const client = new GraphClient('FACEBOOK', { fetchImpl: fake.fetch, version: 'v23.0' });

    await client.call({ path: 'me', accessToken: 't' });
    await client.call({ path: 'oauth/access_token', unversioned: true, accessToken: '' });

    expect(fake.requests[0]!.url).toContain('/v23.0/me');
    // A versioned token endpoint 404s, and the 404 says nothing about the real problem.
    expect(fake.requests[1]!.url).not.toContain('/v23.0/');
    expect(fake.requests[1]!.url).toContain('/oauth/access_token');
  });

  it('routes Threads to its own host', async () => {
    const fake = new FakeGraph([{ match: 'me', body: { id: '1' } }]);
    await new GraphClient('THREADS', { fetchImpl: fake.fetch }).call({
      path: 'me',
      accessToken: 't',
    });

    expect(fake.lastRequest!.url).toContain('graph.threads.net');
    expect(fake.lastRequest!.url).not.toContain('graph.facebook.com');
  });

  it('classifies a dropped connection as transient rather than leaking a TypeError', async () => {
    const client = new GraphClient('FACEBOOK', { fetchImpl: networkFailureFetch });

    const error = await client.call({ path: 'me', accessToken: 't' }).catch((e: unknown) => e);

    expect(isPlatformError(error)).toBe(true);
    // A raw TypeError would escape the pipeline's retry logic entirely, because nothing
    // downstream knows what class an unclassified throw belongs to.
    expect(isPlatformError(error) && error.errorClass).toBe('TRANSIENT');
    expect(policyFor('TRANSIENT').retryable).toBe(true);
  });

  it('keeps an HTML error page classifiable instead of throwing a SyntaxError', async () => {
    const fake = new FakeGraph([
      { match: 'me', status: 502, body: '<html><body>Bad Gateway</body></html>' },
    ]);
    const client = new GraphClient('FACEBOOK', { fetchImpl: fake.fetch });

    const error = await client.call({ path: 'me', accessToken: 't' }).catch((e: unknown) => e);

    expect(isPlatformError(error)).toBe(true);
    expect(isPlatformError(error) && error.errorClass).toBe('TRANSIENT');
  });

  it('returns the outcome without throwing from raw(), so a sweep can continue', async () => {
    const fake = new FakeGraph([
      { match: 'me', status: 400, body: { error: { message: 'dead', code: 190 } } },
    ]);
    const client = new GraphClient('FACEBOOK', { fetchImpl: fake.fetch });

    const response = await client.raw({ path: 'me', accessToken: 't' });

    expect(response.ok).toBe(false);
    expect(response.status).toBe(400);
    expect(graphError(response.body)?.code).toBe(190);
  });
});

describe('Meta error classification', () => {
  const asFailure = (status: number, code: number, subcode?: number) =>
    classifyMetaError({
      platform: 'FACEBOOK',
      status,
      body: { error: { message: 'upstream detail', code, error_subcode: subcode } },
    });

  it('separates the four meanings Graph hides behind one HTTP 400', () => {
    // The whole reason `META_CODE_CLASSES` exists. All four are 400s; classifying on
    // status alone collapses them into VALIDATION and the UI then tells every client to
    // edit their post, including the ones whose token is dead.
    expect(asFailure(400, 190).errorClass).toBe('AUTH');
    expect(asFailure(400, 200).errorClass).toBe('CREDENTIAL');
    expect(asFailure(400, 100).errorClass).toBe('VALIDATION');
    expect(asFailure(400, 368).errorClass).toBe('POLICY');
  });

  it('distinguishes a rate limit from a daily publishing quota, both of which are 429', () => {
    // Different waits: one requeues in seconds, the other must sit out a window measured
    // in hours. Treating a quota as a rate limit burns every attempt the job has.
    expect(asFailure(429, 4).errorClass).toBe('TRANSIENT');
    expect(asFailure(429, 341).errorClass).toBe('QUOTA');
    expect(policyFor('QUOTA').retryable).not.toBe(policyFor('VALIDATION').retryable);
  });

  it('still forces an unrecognised 429 to TRANSIENT', () => {
    const error = classifyMetaError({
      platform: 'FACEBOOK',
      status: 429,
      body: { error: { message: 'slow down' } },
    });
    expect(error.errorClass).toBe('TRANSIENT');
  });

  it('falls through to the status for a code it has never seen', () => {
    // Deliberate: guessing a class for an unknown code is worse than admitting ignorance.
    expect(META_CODE_CLASSES[99999]).toBeUndefined();
    expect(asFailure(401, 99999).errorClass).toBe('AUTH');
  });

  it('names why a token died, because the two causes send a client to different places', () => {
    const removed = asFailure(400, 190, 458);
    const passwordChanged = asFailure(400, 190, 460);

    expect(removed.message).toContain('removed the app');
    expect(passwordChanged.message).toContain('password changed');
    expect(removed.errorClass).toBe('AUTH');
  });

  it('prefers error_user_msg, which is Meta writing for a user rather than a developer', () => {
    const error = classifyMetaError({
      platform: 'INSTAGRAM',
      status: 400,
      body: {
        error: {
          message: 'OAuthException: (#100) Invalid parameter',
          error_user_msg: 'The image aspect ratio is not supported.',
          code: 100,
        },
      },
    });

    expect(error.message).toContain('aspect ratio');
  });

  it('never returns an upstream body to a client', () => {
    const error = asFailure(400, 100);
    expect(error.message).toContain('upstream detail');
    // The client message comes from the taxonomy, not from Meta. An upstream body can
    // contain an app id, a trace id or a token fragment.
    expect(error.clientMessage).not.toContain('upstream detail');
  });

  it('handles a body that is not a Graph envelope at all', () => {
    expect(graphError(null)).toBeUndefined();
    expect(graphError('nope')).toBeUndefined();
    expect(graphError({ error: 'a string' })).toBeUndefined();
    expect(classifyMetaError({ platform: 'THREADS', status: 500, body: {} }).errorClass).toBe(
      'TRANSIENT',
    );
  });
});
