import { describe, expect, it } from 'vitest';
import { backoffFor, publishKey } from './publish.service';
import { classifyPlatformError } from './publish.errors';

/**
 * Retry timing and the usage key.
 *
 * `publishKey` is the contract with W10's metering spine and is the single most
 * consequential string in this workstream: it decides whether a client is billed once for
 * a post or once per attempt.
 */

const NOW = new Date('2025-06-01T12:00:00Z');

function minutesFrom(now: Date, at: Date): number {
  return Math.round((at.getTime() - now.getTime()) / 60_000);
}

describe('publishKey', () => {
  it('is derived only from the target id', () => {
    expect(publishKey('target-1')).toBe('publish:target-1');
  });

  it('is identical across attempts', () => {
    // The whole point. A key that varied by attempt would bill a client once per retry —
    // and a flaky platform would look like usage growth.
    expect(publishKey('target-1')).toBe(publishKey('target-1'));
  });

  it('does not end in something W10 reads as an attempt number', () => {
    // W10's `assertAttemptIndependent` rejects /(attempt|retry)[\s:_-]?\d+$/i. Asserting
    // the same rule here means the key is checked at the point it is built, not only when
    // an event is written.
    expect(publishKey('target-1')).not.toMatch(/(attempt|retry)[\s:_-]?\d+$/i);
  });

  it('distinguishes two targets of the same post', () => {
    // Per-target, not per-post: a post fanned out to four platforms is four published
    // posts, and a per-post key would under-count it by three.
    expect(publishKey('target-a')).not.toBe(publishKey('target-b'));
  });
});

describe('backoffFor', () => {
  it('honours a platform-supplied Retry-After above all else', () => {
    const error = classifyPlatformError({
      platform: 'X',
      status: 429,
      message: 'slow down',
      retryAfterSeconds: 90,
    });
    // The platform has told us exactly when it will accept traffic again. Guessing shorter
    // earns a longer ban; guessing longer wastes the window.
    expect(minutesFrom(NOW, backoffFor(3, error, NOW))).toBe(2);
  });

  it('waits an hour on a quota error regardless of attempt', () => {
    const error = classifyPlatformError({
      platform: 'X',
      status: 403,
      message: 'daily post limit reached',
    });
    if (error.errorClass === 'QUOTA') {
      expect(minutesFrom(NOW, backoffFor(1, error, NOW))).toBe(60);
      expect(minutesFrom(NOW, backoffFor(5, error, NOW))).toBe(60);
    }
  });

  it('doubles with each attempt', () => {
    const error = classifyPlatformError({ platform: 'X', status: 503, message: 'down' });
    expect(minutesFrom(NOW, backoffFor(1, error, NOW))).toBe(1);
    expect(minutesFrom(NOW, backoffFor(2, error, NOW))).toBe(2);
    expect(minutesFrom(NOW, backoffFor(3, error, NOW))).toBe(4);
    expect(minutesFrom(NOW, backoffFor(4, error, NOW))).toBe(8);
  });

  it('caps the delay at an hour', () => {
    const error = classifyPlatformError({ platform: 'X', status: 503, message: 'down' });
    // Uncapped doubling reaches "next week" by attempt 12, which is indistinguishable
    // from never for a social post.
    expect(minutesFrom(NOW, backoffFor(12, error, NOW))).toBe(60);
    expect(minutesFrom(NOW, backoffFor(30, error, NOW))).toBe(60);
  });

  it('always returns a time in the future', () => {
    const error = classifyPlatformError({ platform: 'X', status: 503, message: 'down' });
    // Attempt 0 is not expected, but a non-future result would make the sweep re-run the
    // job immediately and turn a transient failure into a hot loop against the platform.
    for (const attempt of [0, 1, 2, 9]) {
      expect(backoffFor(attempt, error, NOW).getTime()).toBeGreaterThan(NOW.getTime());
    }
  });

  it('ignores a zero or negative Retry-After', () => {
    const error = classifyPlatformError({
      platform: 'X',
      status: 503,
      message: 'down',
      retryAfterSeconds: 0,
    });
    // A `Retry-After: 0` would otherwise schedule the retry for now.
    expect(backoffFor(1, error, NOW).getTime()).toBeGreaterThan(NOW.getTime());
  });
});
