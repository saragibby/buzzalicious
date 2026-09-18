/**
 * A complete, valid environment as a plain object.
 *
 * `loadConfig` takes its source as an argument precisely so tests can build invalid
 * environments without mutating `process.env` and leaking that mutation into every
 * subsequent test in the file.
 */
export function validEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://localhost:5432/buzzalicious_test',
    APP_URL: 'http://127.0.0.1:3001',
    WEB_URL: 'http://127.0.0.1:5173',
    SESSION_SECRET: 'test-session-secret-that-is-long-enough-ok',
    GOOGLE_CLIENT_ID: 'test-google-client-id',
    GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
    ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    STORAGE_DRIVER: 'local',
    ...overrides,
  };
}

/** True when a real Postgres is available, so database tests can opt in. */
export const hasTestDatabase = Boolean(process.env.TEST_DATABASE_URL);
