import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { createInsightRouter } from './insight.routes';
import { errorHandler } from '../middleware/error-handler';

/**
 * Auth and validation boundaries on the insight routes.
 *
 * No database: every case here is rejected before a query runs. That ordering is the
 * thing worth pinning — an analytics endpoint that authorizes *after* reading has already
 * done the cross-tenant read by the time it returns 404.
 */
describe('insight routes', () => {
  const app = createApp();

  const PATHS = [
    '/api/brands/some-brand/insights',
    '/api/brands/some-brand/insights/clicks',
    '/api/brands/some-brand/insights/targets/some-target/timeline',
  ];

  it('requires a session on every insight surface', async () => {
    for (const path of PATHS) {
      const response = await request(app).get(path);

      expect(response.status, `${path} should be 401`).toBe(401);
      expect(response.body.error.code).toBe('UNAUTHENTICATED');
    }
  });

  /**
   * The same assertion against the router **on its own**.
   *
   * The block above passes without this router having any guard at all: `brand.routes.ts`
   * is mounted on the shorter `/api/brands` prefix and calls `router.use(requireAuth)`,
   * so it answers 401 before the request ever falls through to here. That made the test
   * above green for someone else's middleware — it could not tell "my guard rejected
   * this" from "my guard was never reached".
   *
   * Mounting bare removes the neighbour, so these cases fail if this router's own
   * `requireAuth` is dropped. Both layers are kept: the prefix guard is the one that
   * actually runs today, and this one is what survives the prefix being moved.
   */
  describe('mounted on its own, without the brand prefix guard in front', () => {
    const bare = express();
    bare.use('/insights', createInsightRouter());
    bare.use(errorHandler);

    const BARE_PATHS = ['/insights', '/insights/clicks', '/insights/targets/some-target/timeline'];

    it('rejects every surface without a session', async () => {
      for (const path of BARE_PATHS) {
        const response = await request(bare).get(path);

        expect(response.status, `${path} should be 401`).toBe(401);
        expect(response.body.error.code).toBe('UNAUTHENTICATED');
      }
    });

    it('routes really do exist here, so the 401s are refusals and not misses', async () => {
      // Without this a typo in every path above would produce 404s that the loop would
      // have reported as... 404s, not 401s. Included so the negative case has to prove
      // itself: an unknown path answers differently from a guarded one.
      const response = await request(bare).get('/insights/definitely-not-a-route');

      expect(response.status).toBe(404);
    });
  });

  it('rejects an out-of-range window before authenticating', async () => {
    // 401 rather than 400: the auth middleware runs first. Asserting this rather than the
    // validation error is deliberate — if the order ever flipped, a stranger could probe
    // query handling on a brand id they cannot read.
    const response = await request(app).get('/api/brands/some-brand/insights?days=9999');

    expect(response.status).toBe(401);
  });

  it('does not reveal route shape under the brand prefix to a stranger', async () => {
    // 401, not 404. `brand.routes.ts` applies `requireAuth` to the whole `/api/brands`
    // prefix, so an unauthenticated caller cannot tell a real insight sub-route from a
    // made-up one — which is the right answer for a prefix whose path segments are tenant
    // ids. Asserted here so a future refactor that moves the guard onto individual
    // handlers is caught rather than silently turning this into an enumeration oracle.
    const response = await request(app).get('/api/brands/some-brand/insights/nope');

    expect(response.status).toBe(401);
    expect(response.headers['content-type']).toMatch(/json/);
  });
});
