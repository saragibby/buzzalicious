import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AuthError,
  ExternalServiceError,
  NotFoundError,
  ValidationError,
} from '../../platform/errors';
import { errorHandler, notFoundHandler } from './error-handler';
import { requireAuth } from './require-auth';

/**
 * The error boundary is the one place that decides what a client is told. These tests
 * are about the boundary holding, not about any particular route.
 */
function appThrowing(error: unknown) {
  const app = express();
  app.get('/boom', (_req, _res, next) => next(error));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

describe('errorHandler', () => {
  it('returns a validation error with its message and code', async () => {
    const response = await request(appThrowing(new ValidationError('Caption is required'))).get(
      '/boom',
    );

    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({
      code: 'VALIDATION_FAILED',
      message: 'Caption is required',
    });
  });

  it('returns 401 for an auth error', async () => {
    const response = await request(appThrowing(new AuthError())).get('/boom');
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('returns 404 for an unmatched route', async () => {
    const response = await request(appThrowing(new ValidationError('unused'))).get('/nope');
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
  });

  it('does not leak an upstream provider message', async () => {
    const leaky = new ExternalServiceError(
      'x',
      'X API rejected oauth_token=SECRET_VALUE_12345 for app key AKIA_EXAMPLE',
    );

    const response = await request(appThrowing(leaky)).get('/boom');

    // Upstream bodies echo the request back, and for OAuth calls the request is a
    // credential. This is the single most important assertion in the file.
    expect(response.status).toBe(502);
    expect(JSON.stringify(response.body)).not.toContain('SECRET_VALUE_12345');
    expect(JSON.stringify(response.body)).not.toContain('AKIA_EXAMPLE');
  });

  it('does not leak an unexpected error message or stack', async () => {
    const response = await request(
      appThrowing(new TypeError("Cannot read properties of undefined (reading 'accessSecret')")),
    ).get('/boom');

    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toContain('accessSecret');
    expect(response.body.error.stack).toBeUndefined();
    expect(response.body.error.code).toBe('INTERNAL_ERROR');
  });

  it('never includes a stack trace, even for exposed errors', async () => {
    const response = await request(appThrowing(new NotFoundError('Brand'))).get('/boom');
    expect(response.body.error).not.toHaveProperty('stack');
    expect(response.body.error).not.toHaveProperty('cause');
  });

  it('returns a single consistent body shape', async () => {
    for (const error of [new ValidationError('x'), new AuthError(), new TypeError('x')]) {
      const response = await request(appThrowing(error)).get('/boom');
      expect(Object.keys(response.body)).toEqual(['error']);
      expect(response.body.error).toHaveProperty('code');
      expect(response.body.error).toHaveProperty('message');
    }
  });
});

/**
 * A `ZodError` is what every router throws for a malformed body, and it is not an
 * `AppError` — so before this it fell through to the generic branch and became a **500
 * logged at error level**. That is wrong in three ways at once: it blames the server for
 * the client's mistake, tells the client nothing it can act on, and buries genuine faults
 * under noise from ordinary bad input.
 *
 * This is deliberately tested at the boundary rather than per-route, because the boundary
 * is what makes it true for all nine routers that call `Schema.parse`.
 */
describe('errorHandler and schema validation', () => {
  const schema = z.object({ title: z.string() }).strict();

  it('turns a rejected body into a 400 that names the offending field', async () => {
    const response = await request(appThrowing(schema.safeParse({ title: 1 }).error)).get('/boom');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');

    // Naming the path is the point. A 400 saying only "invalid" leaves the client
    // guessing, which in practice means a support ticket.
    expect(response.body.error.details.issues[0]).toMatchObject({ path: 'title' });
  });

  it('reports an unknown key as unrecognized rather than swallowing it', async () => {
    const response = await request(
      appThrowing(schema.safeParse({ title: 'ok', ttile: 'typo' }).error),
    ).get('/boom');

    expect(response.status).toBe(400);
    expect(response.body.error.details.issues[0].code).toBe('unrecognized_keys');
    expect(JSON.stringify(response.body.error.details)).toContain('ttile');
  });

  it('still returns an opaque 500 for a genuine server fault', async () => {
    // The control that keeps the conversion honest: it must catch Zod specifically, not
    // downgrade every unrecognised error to a 400 and hide real faults from the logs.
    const response = await request(appThrowing(new TypeError('cannot read x of undefined'))).get(
      '/boom',
    );

    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toContain('cannot read x');
  });

  it('never echoes the rejected value back, only the path and the reason', async () => {
    // `details` is returned to the client, so this conversion is an exposure path that did
    // not exist before. docs/10 is absolute that a credential secret is never returned
    // "not even to the client that sent it" — and a body carrying one can certainly fail
    // validation. Only `path`, `code` and Zod's own message are mapped; `received` is
    // deliberately dropped, and no secret field is an enum or literal, which are the only
    // Zod issue kinds whose message embeds the value.
    const secretish = z.object({ appSecret: z.string().max(5) }).strict();
    const response = await request(
      appThrowing(secretish.safeParse({ appSecret: 'super-secret-token' }).error),
    ).get('/boom');

    expect(response.status).toBe(400);
    expect(response.body.error.details.issues[0].path).toBe('appSecret');
    expect(JSON.stringify(response.body)).not.toContain('super-secret-token');
  });
});

describe('requireAuth', () => {
  function appWithAuth(authenticated: boolean) {
    const app = express();
    app.use((req, _res, next) => {
      (req as unknown as { isAuthenticated: () => boolean }).isAuthenticated = () => authenticated;
      next();
    });
    app.get('/private', requireAuth, (_req, res) => res.json({ ok: true }));
    app.use(errorHandler);
    return app;
  }

  it('allows an authenticated request through', async () => {
    const response = await request(appWithAuth(true)).get('/private');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
  });

  it('rejects an unauthenticated request with 401, not 403', async () => {
    // The SPA needs to tell "sign in" apart from "you may not do that".
    const response = await request(appWithAuth(false)).get('/private');
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHENTICATED');
  });
});
