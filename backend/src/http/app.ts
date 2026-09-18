import path from 'node:path';
import connectPgSimple from 'connect-pg-simple';
import cors from 'cors';
import express, { type Application } from 'express';
import session from 'express-session';
import { getConfig } from '../platform/config';
import { createHttpLogger } from '../platform/logger';
import { configurePassport } from '../modules/identity/passport';
import { errorHandler, notFoundHandler } from './middleware/error-handler';
import { createAuthRouter } from './routes/auth.routes';
import { createBrandRouter, multerErrorHandler } from './routes/brand.routes';
import { createHealthRouter } from './routes/health.routes';
import { createFilesRouter, shouldMountFilesRouter } from './routes/files.routes';
import { createTemplatesRouter } from './routes/templates.routes';
import { createTrendRouter } from './routes/trend.routes';
import { createTrendAdminRouter } from './routes/trend-admin.routes';
import { createUsageAdminRouter } from './routes/usage-admin.routes';
import { createWorkspaceRouter } from './routes/workspace.routes';
import { createCredentialRouter } from './routes/credential.routes';
import { createOAuthRouter } from './routes/oauth.routes';
import { createPublishRouter } from './routes/publish.routes';

/**
 * Builds the Express application. Deliberately separate from `index.ts` so tests can
 * mount it with Supertest without opening a port or starting a worker.
 *
 * Ordering matters and is not arbitrary:
 *   trust proxy -> request logging -> parsers -> session -> passport -> routes
 *   -> static SPA -> 404 -> error handler (last, always)
 */
export function createApp(): Application {
  const config = getConfig();
  const app = express();

  // Heroku terminates TLS at the router and forwards HTTP to the dyno. Without this,
  // `req.ip` is the proxy (breaking rate limiting) and Express refuses to set a `secure`
  // cookie (breaking sign-in, silently). See docs/reference/platform-quirks.md.
  if (config.isProduction) {
    app.set('trust proxy', 1);
  }

  app.disable('x-powered-by');
  app.use(createHttpLogger());

  // Same-origin in production, so CORS is only needed for the Vite dev server.
  if (!config.isProduction) {
    app.use(cors({ origin: config.webUrl, credentials: true }));
  }

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  const PgSession = connectPgSimple(session);

  app.use(
    session({
      name: 'buzz.sid',
      // Postgres-backed, so sessions survive a restart and work across dynos. The old
      // MemoryStore lost every session on deploy and could not work on more than one dyno.
      store: new PgSession({
        conString: config.databaseUrl,
        tableName: 'session',
        createTableIfMissing: true,
      }),
      secret: config.session.secret,
      resave: false,
      saveUninitialized: false,
      cookie: {
        // These two are only ever correct as a pair: `secure` requires `trust proxy`
        // behind Heroku's router, and setting it without that drops the cookie silently.
        secure: config.isProduction,
        httpOnly: true,
        sameSite: 'lax',
        maxAge: config.session.maxAgeMs,
      },
    }),
  );

  const passport = configurePassport();
  app.use(passport.initialize());
  app.use(passport.session());

  app.use('/api/health', createHealthRouter());
  app.use('/api/templates', createTemplatesRouter());
  app.use('/auth', createAuthRouter(passport));
  app.use('/api/workspaces', createWorkspaceRouter());
  app.use('/api/brands', createBrandRouter());

  // W9. The feed is per-brand and read-only; curation writes platform-global rows and is
  // gated separately by TREND_ADMIN_EMAILS inside its own router.
  app.use('/api/trends', createTrendRouter());
  app.use('/api/admin/trends', createTrendAdminRouter());
  app.use('/api/admin/usage', createUsageAdminRouter());

  // W6. Credentials are workspace-level; scheduling and publishing are per brand. The
  // OAuth router is mounted last and outside `/api` because its callback leg is a browser
  // redirect from a platform, not an XHR — see its own comment for why it cannot require
  // a session.
  app.use('/api/workspaces/:workspaceId/credentials', createCredentialRouter());
  app.use('/api/brands/:brandId/publishing', createPublishRouter());
  app.use('/oauth', createOAuthRouter());

  if (shouldMountFilesRouter()) {
    app.use('/api/files', createFilesRouter());
  }

  // Unmatched API and auth paths are errors, not SPA routes — otherwise a typo'd
  // endpoint returns `index.html` with a 200 and the client parses HTML as JSON.
  app.use('/api', notFoundHandler);
  app.use('/auth', notFoundHandler);

  if (config.isProduction) {
    const spaPath = path.join(__dirname, '../../../frontend/dist');
    app.use(express.static(spaPath, { index: false }));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(spaPath, 'index.html'));
    });
  }

  app.use(multerErrorHandler);
  app.use(errorHandler);

  return app;
}
