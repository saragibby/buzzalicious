import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from './app';

/**
 * Smoke tests for the assembled application.
 *
 * These do not need a database: `/api/health` is deliberately cheap and never touches
 * Postgres, and the 401 path never reaches a query. That is the point — a health check
 * that fails when the database is slow turns a degradation into an outage.
 */
describe('app', () => {
  const app = createApp();

  it('serves health without authentication', async () => {
    const response = await request(app).get('/api/health');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  it('requires a session for /auth/me', async () => {
    const response = await request(app).get('/auth/me');
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('returns JSON, not the SPA, for an unknown API route', async () => {
    // Otherwise a mistyped endpoint returns index.html with a 200 and the client tries
    // to parse HTML as JSON.
    const response = await request(app).get('/api/does-not-exist');
    expect(response.status).toBe(404);
    expect(response.headers['content-type']).toMatch(/json/);
    expect(response.body.error.code).toBe('NOT_FOUND');
  });

  it('returns JSON for an unknown auth route', async () => {
    const response = await request(app).get('/auth/nope');
    expect(response.status).toBe(404);
    expect(response.headers['content-type']).toMatch(/json/);
  });

  it('redirects sign-in to Google', async () => {
    const response = await request(app).get('/auth/google');
    expect(response.status).toBe(302);
    expect(response.headers.location).toContain('accounts.google.com');
  });

  it('uses one canonical callback URL in the authorize request', async () => {
    const response = await request(app).get('/auth/google');
    const redirectUri = new URL(response.headers.location).searchParams.get('redirect_uri');

    // Redirect URIs must match byte for byte between the authorize and token-exchange
    // legs. See docs/reference/platform-quirks.md.
    expect(redirectUri).toBe('http://127.0.0.1:3001/auth/google/callback');
  });

  it('does not advertise the server implementation', async () => {
    const response = await request(app).get('/api/health');
    expect(response.headers['x-powered-by']).toBeUndefined();
  });
});
