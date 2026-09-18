import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config';
import { validEnv } from '../../tests/env';

/**
 * The prototype booted successfully with no `FRONTEND_URL` and redirected users to
 * `https://your-app.herokuapp.com`. These tests exist so that can never happen again:
 * a missing or wrong variable must be a loud, specific, boot-time failure.
 */
describe('loadConfig', () => {
  it('parses a complete environment', () => {
    const config = loadConfig(validEnv());

    expect(config.env).toBe('test');
    expect(config.isProduction).toBe(false);
    expect(config.appUrl).toBe('http://127.0.0.1:3001');
  });

  it.each([
    'DATABASE_URL',
    'APP_URL',
    'WEB_URL',
    'SESSION_SECRET',
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'ENCRYPTION_KEY',
  ])('refuses to start when %s is missing', (name) => {
    expect(() => loadConfig(validEnv({ [name]: undefined }))).toThrow(ConfigError);
  });

  it('names every missing variable, not just the first', () => {
    try {
      loadConfig(validEnv({ APP_URL: undefined, SESSION_SECRET: undefined }));
      expect.unreachable('expected ConfigError');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const problems = (error as ConfigError).problems.join('\n');
      // Reporting one problem per run turns a five-variable misconfiguration into five
      // deploy cycles.
      expect(problems).toContain('APP_URL');
      expect(problems).toContain('SESSION_SECRET');
      expect(problems).toContain('(not set)');
    }
  });

  it('rejects a malformed URL rather than accepting the string', () => {
    expect(() => loadConfig(validEnv({ APP_URL: 'not-a-url' }))).toThrow(ConfigError);
  });

  it('rejects an encryption key that is not 32 bytes', () => {
    expect(() =>
      loadConfig(validEnv({ ENCRYPTION_KEY: Buffer.alloc(16, 1).toString('base64') })),
    ).toThrow(ConfigError);
  });

  it('rejects a session secret short enough to brute force', () => {
    expect(() => loadConfig(validEnv({ SESSION_SECRET: 'short' }))).toThrow(ConfigError);
  });

  it('derives exactly one Google callback URL from APP_URL', () => {
    const config = loadConfig(validEnv({ APP_URL: 'https://buzz.example.com' }));
    // The prototype derived this in three files. Redirect URIs must match byte for byte
    // between the authorize and token-exchange legs, so there can only be one source.
    expect(config.google.callbackUrl).toBe('https://buzz.example.com/auth/google/callback');
  });

  it('refuses the local storage driver in production', () => {
    // Heroku's filesystem is ephemeral: local storage in production silently loses files
    // on the next dyno cycle, which is worse than not booting.
    expect(() =>
      loadConfig(
        validEnv({
          NODE_ENV: 'production',
          STORAGE_DRIVER: 'local',
        }),
      ),
    ).toThrow(/ephemeral/);
  });

  it('requires the R2 variables when the R2 driver is selected', () => {
    expect(() => loadConfig(validEnv({ STORAGE_DRIVER: 'r2' }))).toThrow(/R2_BUCKET/);
  });

  it('accepts the R2 driver when its variables are present', () => {
    const config = loadConfig(
      validEnv({
        STORAGE_DRIVER: 'r2',
        R2_ENDPOINT: 'https://account.r2.cloudflarestorage.com',
        R2_BUCKET: 'buzz-media',
        R2_ACCESS_KEY_ID: 'key',
        R2_SECRET_ACCESS_KEY: 'secret',
      }),
    );

    expect(config.storage.driver).toBe('r2');
    expect(config.storage.r2.bucket).toBe('buzz-media');
  });
});
