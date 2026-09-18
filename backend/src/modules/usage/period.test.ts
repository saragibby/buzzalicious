import { describe, expect, it } from 'vitest';
import { parsePeriodKey, periodEndFor, periodKeyFor, periodStartFor } from './period';

/**
 * Period math.
 *
 * Every one of these is a UTC assertion with an explicit expected instant, not a
 * round-trip through the same helper being tested. A test that says
 * `periodStartFor(periodStartFor(d))` equals itself passes for a helper that returns its
 * argument.
 *
 * The reason periods are UTC calendar months rather than a workspace's local month is
 * reproducibility: a rebuild has to produce the same totals on a developer's laptop in
 * Eastern time and on a Heroku dyno in UTC, and "which month is this event in" must not
 * have two answers.
 */
describe('usage periods', () => {
  it('starts a period at midnight UTC on the first of the month', () => {
    expect(periodStartFor(new Date('2026-03-17T22:41:09.412Z')).toISOString()).toBe(
      '2026-03-01T00:00:00.000Z',
    );
  });

  it('ends a period at the first instant of the next month', () => {
    expect(periodEndFor(new Date('2026-03-17T22:41:09.412Z')).toISOString()).toBe(
      '2026-04-01T00:00:00.000Z',
    );
  });

  it('rolls December into the next year', () => {
    expect(periodEndFor(new Date('2026-12-31T23:59:59.999Z')).toISOString()).toBe(
      '2027-01-01T00:00:00.000Z',
    );
  });

  it('puts a late-UTC-evening instant in the UTC month, not a local one', () => {
    // 2026-03-31T23:30Z is 19:30 on 31 March in New York and 01:30 on 1 April in Berlin.
    // Only the UTC answer is stable, and this is the case that breaks if someone
    // "helpfully" switches to a local calendar.
    expect(periodStartFor(new Date('2026-03-31T23:30:00.000Z')).toISOString()).toBe(
      '2026-03-01T00:00:00.000Z',
    );
    expect(periodStartFor(new Date('2026-04-01T00:30:00.000Z')).toISOString()).toBe(
      '2026-04-01T00:00:00.000Z',
    );
  });

  it('handles February in a leap year', () => {
    expect(periodEndFor(new Date('2028-02-29T12:00:00.000Z')).toISOString()).toBe(
      '2028-03-01T00:00:00.000Z',
    );
  });

  it('formats a period key as YYYY-MM with a padded month', () => {
    expect(periodKeyFor(new Date('2026-01-05T00:00:00.000Z'))).toBe('2026-01');
    expect(periodKeyFor(new Date('2026-11-05T00:00:00.000Z'))).toBe('2026-11');
  });

  it('parses a period key to the period start', () => {
    expect(parsePeriodKey('2026-07')?.toISOString()).toBe('2026-07-01T00:00:00.000Z');
  });

  it('returns null for malformed keys instead of throwing', () => {
    // A bad `?period=` from a URL is a 400, not a 500 — so this returns null and the route
    // decides. `2026-13` is the one that would silently become January 2027 if this were
    // implemented by handing the string to `new Date()`.
    for (const bad of ['', '2026', '2026-13', '2026-00', 'July 2026', '2026-7', 'x']) {
      expect(parsePeriodKey(bad), bad).toBeNull();
    }
  });

  it('round-trips every month of a year', () => {
    for (let month = 1; month <= 12; month += 1) {
      const key = `2026-${String(month).padStart(2, '0')}`;
      const parsed = parsePeriodKey(key);
      expect(parsed).not.toBeNull();
      expect(periodKeyFor(parsed!)).toBe(key);
    }
  });
});
