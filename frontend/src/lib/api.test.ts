import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch, getBackendUrl } from './api';

describe('getBackendUrl', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function withLocation(hostname: string, origin: string) {
    vi.stubGlobal('window', { ...window, location: { hostname, origin } });
  }

  it('uses the explicit port locally', () => {
    withLocation('127.0.0.1', 'http://127.0.0.1:5173');
    // The SPA and the API are on different ports in development, so the origin is wrong.
    expect(getBackendUrl()).toBe('http://127.0.0.1:3001');
  });

  it('treats localhost the same as 127.0.0.1 for the API host', () => {
    withLocation('localhost', 'http://localhost:5173');
    expect(getBackendUrl()).toBe('http://127.0.0.1:3001');
  });

  it('falls back to the page origin in a deployed environment', () => {
    withLocation('buzz.example.com', 'https://buzz.example.com');
    // Vite inlines import.meta.env at build time, so on Heroku a runtime config var
    // genuinely cannot reach the bundle. Same-origin is the correct answer, not a hack.
    expect(getBackendUrl()).toBe('https://buzz.example.com');
  });
});

describe('apiFetch', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('always sends credentials', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    await apiFetch('/api/health');

    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect(init?.credentials).toBe('include');
  });

  it('turns an API error body into a typed ApiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { code: 'VALIDATION_FAILED', message: 'Caption is required', requestId: 'r1' },
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    await expect(apiFetch('/api/posts')).rejects.toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
      message: 'Caption is required',
      requestId: 'r1',
    });
  });

  it('still throws an ApiError when the body is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('<html>502</html>', { status: 502 })),
    );

    // A proxy or platform error page is HTML. Parsing must not throw a SyntaxError that
    // hides the real status.
    await expect(apiFetch('/api/posts')).rejects.toBeInstanceOf(ApiError);
  });
});
