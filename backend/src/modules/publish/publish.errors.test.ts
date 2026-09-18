import { describe, expect, it } from 'vitest';
import { classifyPlatformError, isPlatformError, policyFor } from './publish.errors';
import { backoffFor } from './publish.service';

/**
 * The classification taxonomy.
 *
 * Every assertion here protects a *decision*, not a mapping table. The reason to be
 * careful is that a wrong class is silent: a CREDENTIAL problem classified as AUTH tells
 * the client to reconnect their account, which cannot fix it, and they will do it anyway
 * and report that the product is broken.
 */
describe('classifyPlatformError', () => {
  it('classifies X read-only refusal as CREDENTIAL despite it being a 403', () => {
    // The load-bearing case. A 403 defaults to AUTH, and X returns 403 for "your app is
    // configured read-only" — an app-level setting the client fixes once, not a per-
    // account reconnect. If message rules ever run *after* status rules this flips to
    // AUTH and the specific rule becomes dead code.
    const error = classifyPlatformError({
      platform: 'X',
      status: 403,
      message: 'Read-only application cannot POST',
    });

    expect(error.errorClass).toBe('CREDENTIAL');
    // Control: a 403 with any other message must still be AUTH, so this test cannot pass
    // by the rule matching everything.
    expect(
      classifyPlatformError({ platform: 'X', status: 403, message: 'Unauthorized' }).errorClass,
    ).toBe('AUTH');
  });

  it('treats 429 as TRANSIENT even when the body says something else', () => {
    const error = classifyPlatformError({
      platform: 'INSTAGRAM',
      status: 429,
      message: 'Content violates community guidelines',
    });

    // The message rule would say POLICY. A 429 overriding it is deliberate: the platform
    // is telling us to slow down, and permanently failing the post over a rate limit
    // would discard content that is perfectly publishable.
    expect(error.errorClass).toBe('TRANSIENT');
    // Control: the same message without the 429 really is POLICY.
    expect(
      classifyPlatformError({
        platform: 'INSTAGRAM',
        status: 400,
        message: 'Content violates community guidelines',
      }).errorClass,
    ).toBe('POLICY');
  });

  it('separates QUOTA from TRANSIENT', () => {
    const quota = classifyPlatformError({
      platform: 'INSTAGRAM',
      status: 400,
      message: 'The user has reached the daily publishing limit',
    });

    expect(quota.errorClass).toBe('QUOTA');
    expect(policyFor(quota.errorClass).retryable).toBe(true);

    // The distinction that justifies a separate class is the *delay*, which lives in the
    // pipeline's backoff rather than the policy record. A daily quota clears at a window
    // boundary, so a QUOTA deferral must be far longer than a transient backoff —
    // otherwise the retries are spent hammering a limit that has not moved.
    const now = new Date('2031-01-01T00:00:00.000Z');
    const transient = classifyPlatformError({ platform: 'INSTAGRAM', status: 503 });
    expect(backoffFor(1, quota, now).getTime()).toBeGreaterThan(
      backoffFor(1, transient, now).getTime(),
    );
  });

  it('never returns an upstream body to the client except for POLICY', () => {
    const auth = classifyPlatformError({
      platform: 'FACEBOOK',
      status: 401,
      message: 'OAuthException: token for app 123456 signed with secret abcdef is invalid',
    });

    // The upstream text can carry app ids and token fragments. It belongs in the log,
    // which `message` feeds, and never in `clientMessage`.
    expect(auth.clientMessage).not.toContain('abcdef');
    expect(auth.clientMessage).not.toContain('123456');
    expect(auth.message).toContain('abcdef');
  });

  it('passes the platform message through for POLICY, where it is the useful part', () => {
    const policy = classifyPlatformError({
      platform: 'INSTAGRAM',
      status: 400,
      message: 'This image violates our community guidelines',
    });

    // The one deliberate exception: only the platform knows which rule was broken, and
    // paraphrasing it helps nobody.
    expect(policy.clientMessage).toContain('violates our community guidelines');
  });

  it('defaults an unrecognised failure to TRANSIENT rather than failing the post', () => {
    const unknown = classifyPlatformError({ platform: 'THREADS' });
    expect(unknown.errorClass).toBe('TRANSIENT');
    expect(policyFor(unknown.errorClass).retryable).toBe(true);
  });

  it('marks VALIDATION and POLICY as non-retryable', () => {
    expect(policyFor('VALIDATION').retryable).toBe(false);
    expect(policyFor('POLICY').retryable).toBe(false);
    // Control: the classes that *are* retryable, so this is not asserting a constant false.
    expect(policyFor('TRANSIENT').retryable).toBe(true);
    expect(policyFor('QUOTA').retryable).toBe(true);
  });

  it('does not expose platform errors through the HTTP error handler', () => {
    const error = classifyPlatformError({ platform: 'X', status: 500, message: 'boom' });
    expect(isPlatformError(error)).toBe(true);
    // `expose = false` keeps the generic 500 body. A platform error reaching a client
    // verbatim is the leak path docs/10 closes.
    expect(error.expose).toBe(false);
  });
});
