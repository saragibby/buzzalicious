import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app';

/**
 * Auth boundaries on the trend routes.
 *
 * No database needed: every case here is rejected before a query runs, which is itself
 * worth pinning — an authorization check that only happens after a lookup leaks the
 * existence of rows to callers who should not know about them.
 */
describe('trend routes', () => {
  const app = createApp();

  it('requires a session for a brand feed', async () => {
    const response = await request(app).get('/api/trends/brands/some-brand/feed');

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('requires a session before the curation allow list is even consulted', async () => {
    const response = await request(app).get('/api/admin/trends');

    expect(response.status).toBe(401);
  });

  it('refuses curation writes without a session', async () => {
    // These endpoints write platform-global rows that every workspace reads. A missing
    // guard here is not a per-tenant bug, it is a cross-tenant one.
    for (const path of ['/api/admin/trends/observations', '/api/admin/trends/rescore']) {
      const response = await request(app).post(path).send({});
      expect(response.status).toBe(401);
    }
  });

  it('returns JSON rather than the SPA for an unknown trend route', async () => {
    const response = await request(app).get('/api/trends/nope');

    expect(response.status).toBe(404);
    expect(response.headers['content-type']).toMatch(/json/);
  });
});
