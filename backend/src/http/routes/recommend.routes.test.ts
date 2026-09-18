import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { createRecommendRouter } from './recommend.routes';
import { errorHandler } from '../middleware/error-handler';

/**
 * Auth and validation boundaries on the recommendation route.
 *
 * No database: every case here is rejected before a query runs, which is the ordering
 * worth pinning. This endpoint performs a deliberately cross-brand read to build the
 * category prior, so an authorization check that ran *after* the read would have already
 * touched other tenants' rows by the time it returned 401.
 */
describe('recommendation routes', () => {
  const app = createApp();

  it('requires a session', async () => {
    const response = await request(app).get('/api/brands/some-brand/recommendations');

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHENTICATED');
  });

  /**
   * The same assertion against this router **on its own**.
   *
   * The case above passes even if this router has no guard at all, because
   * `brand.routes.ts` is mounted on the shorter `/api/brands` prefix and calls
   * `router.use(requireAuth)` — so it answers 401 before the request ever reaches here.
   * That is the masking class from `docs/12-testing.md`: a correct guard upstream
   * concealing a missing one here, with both producing the identical response.
   *
   * Mounting bare removes the neighbour, so this fails if this router's own `requireAuth`
   * is dropped.
   */
  describe('mounted on its own, without the brand prefix guard in front', () => {
    const bare = express();
    bare.use('/recommendations', createRecommendRouter());
    bare.use(errorHandler);

    it('rejects the surface without a session', async () => {
      const response = await request(bare).get('/recommendations');

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('UNAUTHENTICATED');
    });

    it('the route really does exist here, so the 401 is a refusal and not a miss', async () => {
      // The positive control. Without it, a typo in the path above would produce a 404
      // that this file would happily have reported as... a 404, and the guard would never
      // have been exercised at all.
      const response = await request(bare).get('/recommendations/definitely-not-a-route');

      expect(response.status).toBe(404);
    });
  });

  it('rejects an out-of-range window before authenticating', async () => {
    // 401 rather than 400: auth runs first. If that order flipped, a stranger could probe
    // query handling against a brand id they cannot read.
    const response = await request(app).get('/api/brands/some-brand/recommendations?days=9999');

    expect(response.status).toBe(401);
  });

  it('does not reveal route shape under the brand prefix to a stranger', async () => {
    const response = await request(app).get('/api/brands/some-brand/recommendations/nope');

    expect(response.status).toBe(401);
    expect(response.headers['content-type']).toMatch(/json/);
  });
});
