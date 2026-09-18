import { z } from 'zod';

/**
 * Every environment variable the backend reads, in one place, validated once at boot.
 *
 * Two rules, both learned from the prototype (see docs/reference/platform-quirks.md):
 *
 *  1. No silent fallbacks. The old code defaulted to `'your-secret-key'` and
 *     `'https://your-app.herokuapp.com'`, which meant a misconfigured deploy booted
 *     happily and redirected real users to a domain that does not exist. Anything
 *     required is required; the process refuses to start without it.
 *  2. No `process.env` reads outside this file. A URL derived in three places drifts in
 *     three places.
 */

const nodeEnv = z.enum(['development', 'test', 'production']);

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const url = z
  .string()
  .url()
  .transform((v) => v.replace(/\/+$/, ''));

/** 32 bytes of base64 — the AES-256 key. Generate with `openssl rand -base64 32`. */
const encryptionKey = z.string().refine((v) => {
  try {
    return Buffer.from(v, 'base64').length === 32;
  } catch {
    return false;
  }
}, 'must be 32 bytes encoded as base64 (try: openssl rand -base64 32)');

const csv = z
  .string()
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.string()));

/**
 * A USD amount, kept as a string.
 *
 * Money never becomes a JavaScript number in this codebase: `z.coerce.number()` here would
 * turn a config ceiling into a binary float and then compare it against a `Decimal`
 * column, which is exactly the Float-in-billing-arithmetic that ADR-0011 forbids. The
 * string is handed to `Prisma.Decimal` at the point of use.
 */
const usdAmount = z
  .string()
  .regex(/^\d+(\.\d{1,6})?$/, 'must be a positive USD amount such as "25.00"')
  .refine((v) => Number(v) > 0, 'must be greater than zero');

const baseSchema = z.object({
  NODE_ENV: nodeEnv.default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.string().min(1),

  /** Public origin of the deployed app. In production this serves both API and SPA. */
  APP_URL: url,
  /** Where the SPA is served. Same as APP_URL in production; the Vite dev server locally. */
  WEB_URL: url,

  SESSION_SECRET: z.string().min(32, 'must be at least 32 characters'),
  SESSION_MAX_AGE_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(7 * 24 * 60 * 60 * 1000),

  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),

  /** Optional sign-in allow lists. Empty means anyone with a Google account. */
  ALLOWED_EMAILS: csv.default(''),
  ALLOWED_DOMAINS: csv.default(''),

  /**
   * Key encryption key. Supplied by a Heroku config var for v1 (Q14); the KeyProvider
   * seam in crypto.ts is what lets a managed KMS replace it later.
   */
  ENCRYPTION_KEY: encryptionKey,
  /** Identifies which key encrypted a given ciphertext, so rotation is incremental. */
  ENCRYPTION_KEY_ID: z
    .string()
    .regex(/^[a-z0-9_-]+$/i, 'must be alphanumeric, dashes or underscores')
    .default('k1'),

  /** Run pg-boss consumers in this process. False on web dynos once a worker dyno exists. */
  WORKER_ENABLED: bool.default('false'),

  STORAGE_DRIVER: z.enum(['local', 'r2']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('.storage'),
  STORAGE_SIGNED_URL_TTL_SECONDS: z.coerce.number().int().positive().default(3600),

  R2_ENDPOINT: z.string().url().optional(),
  R2_BUCKET: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_REGION: z.string().default('auto'),

  OPENAI_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  AZURE_OPENAI_API_KEY: z.string().optional(),
  AZURE_OPENAI_ENDPOINT: z.string().url().optional(),
  AZURE_OPENAI_DEPLOYMENT: z.string().optional(),
  AZURE_OPENAI_API_VERSION: z.string().optional(),

  /**
   * Who may curate the global trend feed (W9). Deliberately the inverse of
   * `ALLOWED_EMAILS`: empty denies everyone rather than allowing everyone. Trend curation
   * writes platform-global rows that every workspace reads, so an unset variable must fail
   * closed — the cost of a wrong default here is one client's typo reaching every tenant.
   */
  TREND_ADMIN_EMAILS: csv.default(''),

  /**
   * Who may read the cross-tenant usage and spend view (W10). Fail-closed like
   * `TREND_ADMIN_EMAILS` and deliberately separate from it: curating the global trend feed
   * and reading every client's spend are different privileges, and collapsing them would
   * hand one to whoever was granted the other.
   */
  PLATFORM_ADMIN_EMAILS: csv.default(''),

  /**
   * Default monthly AI provider-cost ceiling per workspace, in USD (ADR-0011).
   * Overridable per workspace by `Workspace.aiMonthlyCeilingUsd`.
   *
   * A string, not a number, and kept one all the way to `Prisma.Decimal`: binary floats
   * do not represent money, and this value is compared against a `Decimal` column. It is
   * a conservative fuse rating, not a price — pricing is Q13 and is not decided here.
   */
  AI_MONTHLY_CEILING_USD: usdAmount.default('25.00'),

  /** Opt-in Postgres for DB-backed integration tests. See docs/12-testing.md. */
  TEST_DATABASE_URL: z.string().optional(),

  /**
   * `PLATFORM_APP` mode — Buzzalicious's own platform apps (docs/10, ADR-0009).
   *
   * **Config vars, never the application database.** That asymmetry is deliberate: a
   * database compromise then exposes client credentials but not the platform-wide app
   * that every `PLATFORM_APP` client would depend on.
   *
   * All optional. Unset simply means that tier of the resolver has nothing to offer, and
   * a client without their own app gets an actionable "connect credentials" error rather
   * than a half-configured authorization that fails at the callback.
   *
   * Meta's three networks share one app; X and Threads have their own.
   */
  PLATFORM_APP_X_KEY: z.string().optional(),
  PLATFORM_APP_X_SECRET: z.string().optional(),
  PLATFORM_APP_META_ID: z.string().optional(),
  PLATFORM_APP_META_SECRET: z.string().optional(),
  PLATFORM_APP_THREADS_ID: z.string().optional(),
  PLATFORM_APP_THREADS_SECRET: z.string().optional(),

  /** How long a started OAuth authorization stays completable. */
  OAUTH_HANDSHAKE_TTL_SECONDS: z.coerce.number().int().positive().default(600),

  /** Refresh a token this many days before it expires. */
  TOKEN_REFRESH_LEAD_DAYS: z.coerce.number().int().positive().default(7),

  /** Attempts per publish job before a target is marked FAILED. */
  PUBLISH_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
});

/**
 * A pair of app credentials, or nothing.
 *
 * Half a `PLATFORM_APP` is worse than none: an app id with no secret produces an
 * authorize URL the user can complete and a callback that cannot exchange the code, so
 * the failure lands after the client has already granted permission. One value present
 * without the other is treated as "not configured" so the resolver falls through to its
 * actionable error instead.
 */
function appOrUndefined(
  appId: string | undefined,
  appSecret: string | undefined,
): { appId: string; appSecret: string } | undefined {
  return appId && appSecret ? { appId, appSecret } : undefined;
}

const schema = baseSchema
  .superRefine((env, ctx) => {
    if (env.STORAGE_DRIVER === 'r2') {
      for (const key of [
        'R2_ENDPOINT',
        'R2_BUCKET',
        'R2_ACCESS_KEY_ID',
        'R2_SECRET_ACCESS_KEY',
      ] as const) {
        if (!env[key]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: 'is required when STORAGE_DRIVER=r2',
          });
        }
      }
    }

    // Heroku's filesystem is ephemeral: anything written to local disk is gone on the
    // next dyno cycle. Failing at boot is far kinder than losing renditions silently.
    if (env.NODE_ENV === 'production' && env.STORAGE_DRIVER === 'local') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['STORAGE_DRIVER'],
        message:
          'cannot be "local" in production — the dyno filesystem is ephemeral, so stored files would not survive a restart. Use "r2".',
      });
    }
  })
  .transform((env) => ({
    env: env.NODE_ENV,
    isProduction: env.NODE_ENV === 'production',
    isTest: env.NODE_ENV === 'test',
    port: env.PORT,
    logLevel: env.LOG_LEVEL,

    databaseUrl: env.DATABASE_URL,
    testDatabaseUrl: env.TEST_DATABASE_URL,

    appUrl: env.APP_URL,
    webUrl: env.WEB_URL,

    session: {
      secret: env.SESSION_SECRET,
      maxAgeMs: env.SESSION_MAX_AGE_MS,
    },

    google: {
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      /** Single canonical callback URL, derived once. See docs/reference/platform-quirks.md. */
      callbackUrl: `${env.APP_URL}/auth/google/callback`,
      allowedEmails: env.ALLOWED_EMAILS,
      allowedDomains: env.ALLOWED_DOMAINS,
    },

    crypto: {
      keyId: env.ENCRYPTION_KEY_ID,
      key: env.ENCRYPTION_KEY,
    },

    workerEnabled: env.WORKER_ENABLED,

    trend: {
      /** Empty means nobody. See the note on TREND_ADMIN_EMAILS above. */
      adminEmails: env.TREND_ADMIN_EMAILS,
    },

    platform: {
      /** Empty means nobody. See the note on PLATFORM_ADMIN_EMAILS above. */
      adminEmails: env.PLATFORM_ADMIN_EMAILS,
    },

    storage: {
      driver: env.STORAGE_DRIVER,
      localDir: env.STORAGE_LOCAL_DIR,
      signedUrlTtlSeconds: env.STORAGE_SIGNED_URL_TTL_SECONDS,
      r2: {
        endpoint: env.R2_ENDPOINT,
        bucket: env.R2_BUCKET,
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
        region: env.R2_REGION,
      },
    },

    ai: {
      openaiApiKey: env.OPENAI_API_KEY,
      geminiApiKey: env.GEMINI_API_KEY,
      /** Default per-workspace monthly ceiling, as a string. See `usdAmount` above. */
      monthlyCeilingUsd: env.AI_MONTHLY_CEILING_USD,
      azure: {
        apiKey: env.AZURE_OPENAI_API_KEY,
        endpoint: env.AZURE_OPENAI_ENDPOINT,
        deployment: env.AZURE_OPENAI_DEPLOYMENT,
        apiVersion: env.AZURE_OPENAI_API_VERSION,
      },
    },

    publish: {
      /** Single canonical callback URL per platform. Clients register one URL, once. */
      callbackUrl: (platform: string) => `${env.APP_URL}/auth/${platform.toLowerCase()}/callback`,
      handshakeTtlSeconds: env.OAUTH_HANDSHAKE_TTL_SECONDS,
      tokenRefreshLeadDays: env.TOKEN_REFRESH_LEAD_DAYS,
      maxAttempts: env.PUBLISH_MAX_ATTEMPTS,
      /**
       * Our own apps, by resolver key. `undefined` means that tier is not configured, and
       * the resolver must say so rather than proceeding with a blank app id.
       */
      platformApps: {
        X: appOrUndefined(env.PLATFORM_APP_X_KEY, env.PLATFORM_APP_X_SECRET),
        META: appOrUndefined(env.PLATFORM_APP_META_ID, env.PLATFORM_APP_META_SECRET),
        THREADS: appOrUndefined(env.PLATFORM_APP_THREADS_ID, env.PLATFORM_APP_THREADS_SECRET),
      },
    },
  }));

export type Config = z.infer<typeof schema>;

/** Thrown by `loadConfig`. Carries the per-variable problems so boot can print them. */
export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

/**
 * Parse a raw environment. Pure — takes its source as an argument so tests can exercise
 * failure cases without mutating `process.env`.
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const result = schema.safeParse(source);

  if (!result.success) {
    const problems = result.error.issues.map((issue) => {
      const name = issue.path.join('.') || '(root)';
      const present = source[name] !== undefined;
      const suffix = present ? '' : ' (not set)';
      return `${name}: ${issue.message}${suffix}`;
    });
    throw new ConfigError([...new Set(problems)].sort());
  }

  return result.data;
}

let cached: Config | undefined;

/** Memoized config for application code. Parsed on first call, then reused. */
export function getConfig(): Config {
  cached ??= loadConfig();
  return cached;
}

/** Test-only. Drops the memoized value so the next `getConfig()` re-parses. */
export function resetConfigForTests(): void {
  cached = undefined;
}
