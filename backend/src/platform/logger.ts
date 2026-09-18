import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import pino, { type Logger } from 'pino';
import pinoHttp from 'pino-http';
import { getConfig } from './config';

/**
 * Structured logging. Replaces the prototype's `console.log`, which among other things
 * printed session IDs and OAuth authorize URLs.
 *
 * The redaction posture here is deliberately paranoid. docs/10-credentials-and-security.md
 * says to allow-list rather than deny-list, and the serializers below do exactly that:
 * a request logs its method, URL and a handful of safe headers, and nothing else. The
 * `redact` list is a second layer for anything that reaches the logger through an
 * arbitrary object — an error payload from a platform API, say.
 *
 * `req.ip` and `remoteAddress` are redacted too. They are PII, and first-party click
 * tracking stores salted hashes rather than addresses (docs/06).
 */

/** Deny-list backstop. Applies at any depth via the `*.` wildcards. */
const REDACT_PATHS = [
  'password',
  'secret',
  'token',
  'accessToken',
  'accessSecret',
  'refreshToken',
  'appSecret',
  'apiKey',
  'authorization',
  'cookie',
  'email',
  'ip',
  '*.password',
  '*.secret',
  '*.token',
  '*.accessToken',
  '*.accessSecret',
  '*.refreshToken',
  '*.appSecret',
  '*.apiKey',
  '*.authorization',
  '*.cookie',
  '*.email',
  '*.ip',
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
];

/**
 * Query strings carry `oauth_token`, `code`, and `state`. None of them belong in a log
 * line, and the path alone is what makes a log useful.
 */
function safeUrl(raw: string | undefined): string | undefined {
  if (!raw) return raw;
  const queryStart = raw.indexOf('?');
  return queryStart === -1 ? raw : `${raw.slice(0, queryStart)}?<redacted>`;
}

export function createLogger(): Logger {
  const config = getConfig();

  return pino({
    level: config.logLevel,
    base: { env: config.env },
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    formatters: {
      level: (label) => ({ level: label }),
    },
    // Human-readable locally; JSON everywhere a log aggregator reads it.
    transport:
      config.isProduction || config.isTest
        ? undefined
        : {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
          },
  });
}

let cached: Logger | undefined;

export function getLogger(): Logger {
  cached ??= createLogger();
  return cached;
}

/** Test-only. */
export function resetLoggerForTests(): void {
  cached = undefined;
}

/**
 * Request logging plus request IDs. The ID is echoed as `x-request-id` so a user can
 * quote it from an error page, and is carried into job payloads so a publish failure
 * can be traced back to the request that scheduled it.
 */
export function createHttpLogger() {
  return pinoHttp({
    logger: getLogger(),
    genReqId: (req: IncomingMessage, res: ServerResponse) => {
      const existing = req.headers['x-request-id'];
      const id = (Array.isArray(existing) ? existing[0] : existing) ?? randomUUID();
      res.setHeader('x-request-id', id);
      return id;
    },
    customLogLevel: (_req, res, err) => {
      if (err || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    // Allow-list serializers: only these fields are ever emitted.
    serializers: {
      req: (req) => ({
        id: req.id,
        method: req.method,
        url: safeUrl(req.url),
      }),
      res: (res) => ({ statusCode: res.statusCode }),
      err: (err) => ({
        type: err.type,
        message: err.message,
        code: (err as { code?: string }).code,
        stack: err.stack,
      }),
    },
    // Health checks at info level drown out everything else.
    autoLogging: {
      ignore: (req) => req.url === '/api/health',
    },
  });
}

export type { Logger };
