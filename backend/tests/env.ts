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

/**
 * Establish a complete, valid environment for a test process.
 *
 * Config is validated at boot and the tests exercise real code paths through it, so this
 * has to run before anything imports `platform/config`. The values are fixed fakes: no
 * test should ever depend on a real credential, and a suite that reads developer `.env`
 * files passes or fails differently per machine.
 *
 * Called from both `setup.ts` (per test file) and `global-setup.ts` (once, before
 * migrating and seeding), which is why it is a function rather than import side effects.
 */
export function applyTestEnv(): void {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL ??= 'postgresql://localhost:5432/buzzalicious_test';
  // A database test connects through the ordinary application client, so pointing
  // DATABASE_URL at the throwaway test database is what makes `getPrisma()` safe to use.
  if (process.env.TEST_DATABASE_URL) {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  }
  process.env.APP_URL ??= 'http://127.0.0.1:3001';
  process.env.WEB_URL ??= 'http://127.0.0.1:5173';
  process.env.SESSION_SECRET ??= 'test-session-secret-that-is-long-enough-ok';
  process.env.GOOGLE_CLIENT_ID ??= 'test-google-client-id';
  process.env.GOOGLE_CLIENT_SECRET ??= 'test-google-client-secret';
  // 32 zero bytes, base64. Fixed so ciphertext in assertions is reproducible.
  process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
  process.env.ENCRYPTION_KEY_ID ??= 'k1';
  process.env.STORAGE_DRIVER ??= 'local';
  process.env.LOG_LEVEL ??= 'silent';
}
