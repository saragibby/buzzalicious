import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetConfigForTests } from '../../platform/config';
import { resolveCollectorCredential, resolveCredential } from './credential.resolver';

/**
 * A trend collector must use Buzzalicious's own app and never a client's (docs/07,
 * ADR-0009). Before `resolveCollectorCredential` existed, that rule lived only in prose
 * while `resolveCredential` — the obvious function to reach for — fell back through
 * brand → workspace → platform. The first automated collector would have borrowed a
 * client's app silently.
 *
 * ## What these tests are actually pinning
 *
 * Not "the happy path returns an app". The property that matters is the *negative* one:
 * a collector **cannot reach a client credential**. Per docs/12, a test whose subject is
 * an absence has to be able to tell "this didn't happen" from "this didn't run" — so the
 * suite below pairs each guard with a positive control that fails if the fixture never
 * exercised the path.
 *
 * The strongest assertion here is the signature test. `resolveCollectorCredential` takes
 * no `Db`, so borrowing a client credential is not a rule to remember but an impossible
 * call to write. A boolean option would be one `true` away from the bug.
 */

const ORIGINAL = process.env;

beforeEach(() => {
  resetConfigForTests();
  process.env = {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://localhost:5432/buzzalicious_test',
    APP_URL: 'http://127.0.0.1:3001',
    WEB_URL: 'http://127.0.0.1:5173',
    SESSION_SECRET: 'test-session-secret-that-is-long-enough-ok',
    GOOGLE_CLIENT_ID: 'test-google-client-id',
    GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
    ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    STORAGE_DRIVER: 'local',
    PLATFORM_APP_META_ID: 'buzzalicious-meta-app',
    PLATFORM_APP_META_SECRET: 'buzzalicious-meta-secret',
  };
});

afterEach(() => {
  process.env = ORIGINAL;
  resetConfigForTests();
});

describe('resolveCollectorCredential', () => {
  it('returns Buzzalicious own app, in PLATFORM_APP mode', () => {
    const credential = resolveCollectorCredential('INSTAGRAM');

    expect(credential.mode).toBe('PLATFORM_APP');
    expect(credential.appId).toBe('buzzalicious-meta-app');
    expect(credential.appSecret).toBe('buzzalicious-meta-secret');
  });

  it('cannot be handed a database, so it cannot reach a client credential', () => {
    // The guard is the *arity*, not a branch inside the function. A collector that cannot
    // be given a `Db` cannot query `platformCredential` however it is called, and no
    // future edit can reintroduce a fallback without changing this signature first.
    //
    // Positive control: `resolveCredential` is the tenant-scoped resolver and does take a
    // `Db`. If both were 1, this assertion would be measuring nothing.
    expect(resolveCollectorCredential).toHaveLength(1);
    expect(resolveCredential.length).toBeGreaterThan(1);
  });

  it('refuses rather than falling back when we have no app of our own', () => {
    delete process.env.PLATFORM_APP_META_ID;
    delete process.env.PLATFORM_APP_META_SECRET;
    resetConfigForTests();

    // The failure mode this protects against is not an exception — it is a *success*
    // carrying someone else's credential. So assert the throw, then assert the reason,
    // so a future "helpful" fallback cannot satisfy this test by throwing for an
    // unrelated cause.
    expect(() => resolveCollectorCredential('INSTAGRAM')).toThrowError(
      /no INSTAGRAM app configured/,
    );

    // Positive control: with the app present the same call succeeds, proving the throw
    // above came from the missing config and not from a broken fixture.
    process.env.PLATFORM_APP_META_ID = 'buzzalicious-meta-app';
    process.env.PLATFORM_APP_META_SECRET = 'buzzalicious-meta-secret';
    resetConfigForTests();
    expect(resolveCollectorCredential('INSTAGRAM').appId).toBe('buzzalicious-meta-app');
  });

  it('says why it will not borrow, so the next reader does not add a fallback', () => {
    delete process.env.PLATFORM_APP_META_ID;
    delete process.env.PLATFORM_APP_META_SECRET;
    resetConfigForTests();

    // The message is load-bearing: someone hitting this error with a client credential
    // sitting right there in the database needs to know the omission is deliberate.
    expect(() => resolveCollectorCredential('INSTAGRAM')).toThrowError(/ADR-0009/);
  });

  it('will not resolve a platform Meta does not cover', () => {
    // `platformAppKey` returns null for platforms with no Buzzalicious app. That must
    // refuse, not fall through to undefined and hand back a credential with no appId.
    expect(() => resolveCollectorCredential('X')).toThrowError(/no X app configured/);
  });
});
