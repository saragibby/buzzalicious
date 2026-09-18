/**
 * Backend test environment.
 *
 * Config is validated at boot and the tests exercise real code paths through it, so a
 * complete, valid environment has to exist before anything imports `platform/config`.
 * These are fixed fake values: no test should ever depend on a real credential, and a
 * suite that reads developer `.env` files passes or fails differently per machine.
 */
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
