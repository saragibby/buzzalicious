import { afterEach, describe, expect, it } from 'vitest';

import { applyTestEnv } from './env';

/**
 * `applyTestEnv` is the only thing standing between the suite and a third-party API.
 *
 * `backend/.env` is gitignored and loaded before the tests run, so on a developer machine
 * it supplies real provider credentials while CI has none. That divergence is invisible
 * until it bites: `tests/db/trend.test.ts` drives `mapTrend` → `classifyWithLlm`, which
 * calls a provider for real. With a live `OPENAI_API_KEY` that file took 41s and timed
 * out two tests; with fakes it takes 3s and passes — and every run in between was issuing
 * billable requests.
 *
 * The bug was that these keys were defaulted with `??=`, which defers to whatever is
 * already set. So this asserts the opposite of the usual "provides a default" behaviour:
 * a credential that is *already present* must be **overwritten**.
 */
describe('applyTestEnv', () => {
  const PROVIDER_KEYS = [
    'OPENAI_API_KEY',
    'GEMINI_API_KEY',
    'AZURE_OPENAI_API_KEY',
    'AZURE_OPENAI_ENDPOINT',
    'AZURE_OPENAI_DEPLOYMENT',
    'AZURE_OPENAI_API_VERSION',
  ] as const;

  afterEach(() => {
    // Deliberately does not restore the previous values. Backend test files share one
    // process, so putting a developer's real key back would re-poison every file that runs
    // after this one — the exact bug these tests exist to prevent, reintroduced by the
    // tests themselves. Re-applying the fakes is the only safe exit.
    applyTestEnv();
  });

  it('overwrites a real-looking provider credential rather than deferring to it', () => {
    const realistic = 'sk-proj-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH';
    process.env.OPENAI_API_KEY = realistic;
    process.env.GEMINI_API_KEY = 'AIzaSyAAAABBBBCCCCDDDDEEEEFFFFGGGG';

    applyTestEnv();

    expect(process.env.OPENAI_API_KEY).not.toBe(realistic);
    expect(process.env.OPENAI_API_KEY).toContain('test-fake');
    expect(process.env.GEMINI_API_KEY).toContain('test-fake');
  });

  it('leaves no provider credential unset or real', () => {
    for (const key of PROVIDER_KEYS) process.env[key] = 'pretend-this-is-real';

    applyTestEnv();

    for (const key of PROVIDER_KEYS) {
      expect(process.env[key], `${key} must be replaced with a fake`).not.toBe(
        'pretend-this-is-real',
      );
      expect(process.env[key], `${key} must be set`).toBeTruthy();
    }
  });

  it('keeps the Azure endpoint a valid, unroutable URL', () => {
    // It is validated with `z.string().url()`, so a bare marker string would fail config
    // parsing. Unroutable so a missed stub fails fast instead of reaching something real.
    process.env.AZURE_OPENAI_ENDPOINT = 'https://real-tenant.openai.azure.com';

    applyTestEnv();

    const endpoint = process.env.AZURE_OPENAI_ENDPOINT!;
    expect(() => new URL(endpoint)).not.toThrow();
    expect(endpoint).not.toContain('azure.com');
    expect(new URL(endpoint).hostname).toBe('127.0.0.1');
  });
});
