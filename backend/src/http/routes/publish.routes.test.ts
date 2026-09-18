import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app';

/**
 * HTTP-level guarantees for the publishing surface.
 *
 * No database: every assertion here is about what happens *before* a query, which is
 * exactly the part that is easy to get wrong and easy to not notice. An endpoint that
 * publishes on behalf of a brand without checking the session is not a subtle bug, but it
 * is an invisible one until someone goes looking.
 */
describe('publishing routes', () => {
  const app = createApp();

  const PROTECTED: Array<[string, string]> = [
    ['get', '/api/workspaces/ws-1/credentials'],
    ['post', '/api/workspaces/ws-1/credentials'],
    ['get', '/api/workspaces/ws-1/credentials/cred-1'],
    ['patch', '/api/workspaces/ws-1/credentials/cred-1'],
    ['post', '/api/workspaces/ws-1/credentials/cred-1/preflight'],
    ['post', '/api/brands/brand-1/publishing/schedule'],
    ['post', '/api/brands/brand-1/publishing/cancel'],
    ['post', '/api/brands/brand-1/publishing/publish'],
    ['post', '/api/brands/brand-1/publishing/publish-now/target-1'],
    ['post', '/oauth/brand-1/connect/X'],
  ];

  for (const [method, path] of PROTECTED) {
    it(`requires a session for ${method.toUpperCase()} ${path}`, async () => {
      const agent = request(app) as unknown as Record<string, (url: string) => request.Test>;
      const response = await agent[method]!(path).send({});

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('UNAUTHENTICATED');
    });
  }

  it('mounts the routers at all', async () => {
    // The control for the loop above, which would otherwise pass for routers that were
    // never mounted: an unmounted `/api` path 404s, so a 401 on the publishing paths is
    // evidence that a real `requireAuth` intercepted rather than that nothing is there.
    const unmounted = await request(app).get('/api/publishing-does-not-exist');
    expect(unmounted.status).toBe(404);
  });

  it('does not reveal whether a publishing sub-path exists', async () => {
    // Router-level `requireAuth` runs before routing, so an unauthenticated caller gets
    // the same 401 for a real endpoint and an invented one. That is the intended shape:
    // a 404 here would enumerate the API for anyone without a session.
    const invented = await request(app).get('/api/brands/brand-1/publishing/not-a-route');
    expect(invented.status).toBe(401);
  });

  describe('oauth callback', () => {
    it('rejects a missing state without touching the platform', async () => {
      const response = await request(app).get('/oauth/callback/X?code=abc');
      expect(response.status).toBe(400);
    });

    it('rejects a forged state', async () => {
      // A state whose signature was not produced by this deployment's key. If this ever
      // succeeds, `state` is a bearer token anyone can mint.
      const forged = `${Buffer.from(
        JSON.stringify({
          c: 'cred-1',
          n: 'nonce',
          b: 'brand-1',
          p: 'X',
          e: Math.floor(Date.now() / 1000) + 600,
        }),
      ).toString('base64url')}.not-a-real-signature`;

      const response = await request(app).get(
        `/oauth/callback/X?code=abc&state=${encodeURIComponent(forged)}`,
      );
      expect(response.status).toBe(400);
    });

    it('gives the same message for every rejection reason', async () => {
      // Distinguishing "bad signature" from "expired" is free information for someone
      // probing the endpoint, and there is nothing a legitimate user can do differently
      // with either.
      const missing = await request(app).get('/oauth/callback/X');
      const forged = await request(app).get('/oauth/callback/X?state=aaa.bbb');

      expect(forged.body.error.message).toBe(missing.body.error.message);
      // Control: it is a real message rather than both being undefined.
      expect(typeof missing.body.error.message).toBe('string');
      expect(missing.body.error.message.length).toBeGreaterThan(20);
    });
  });
});
