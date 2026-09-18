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

  /** Opt-in Postgres for DB-backed integration tests. See docs/12-testing.md. */
  TEST_DATABASE_URL: z.string().optional(),
});

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
      azure: {
        apiKey: env.AZURE_OPENAI_API_KEY,
        endpoint: env.AZURE_OPENAI_ENDPOINT,
        deployment: env.AZURE_OPENAI_DEPLOYMENT,
        apiVersion: env.AZURE_OPENAI_API_VERSION,
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
