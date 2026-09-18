# `http/` — the transport layer

Express: routing, middleware, serialization, status codes. Nothing else.

## Boundaries

- `http/` may import `modules/` and `platform/`. **`modules/` must never import `http/`.**
- A route handler should read as: validate input, call one module function, shape the
  response. When a handler grows a `try`/`catch` with business meaning, or a Prisma query,
  the logic has landed in the wrong layer.
- No handler talks to Prisma directly. That is a module's job.
- Errors are thrown, never hand-serialized. `errorHandler` owns the response shape, so
  there is one place that decides what is safe to tell a client.

## Layout

| Path | What it holds |
|------|---------------|
| `app.ts` | The application factory — middleware order, mounted routers |
| `middleware/error-handler.ts` | 404 and the single error boundary |
| `middleware/require-auth.ts` | Session guard |
| `routes/auth.routes.ts` | Google sign-in, sign-out, `/auth/me` |
| `routes/health.routes.ts` | Liveness and readiness |
| `routes/files.routes.ts` | Signed-URL file serving, local driver only |

## Middleware order is load-bearing

```
trust proxy → request logging → parsers → session → passport → routers
            → static SPA → 404 → error handler
```

- **`trust proxy` first.** Heroku's router terminates TLS and forwards HTTP. Without it
  Express refuses to set a `secure` cookie and `req.ip` is the proxy, so sign-in fails
  silently and every user shares one rate-limit bucket.
- **The error handler is last, always.** Express identifies it by arity and by position;
  registered before a router, it never runs.
- **404s for `/api` and `/auth` are raised before the SPA fallback.** Otherwise a mistyped
  endpoint returns `index.html` with a 200 and the client tries to parse HTML as JSON.

## `createApp` is separate from `index.ts` on purpose

Tests mount the app with Supertest without binding a port, connecting a worker, or
installing signal handlers.
