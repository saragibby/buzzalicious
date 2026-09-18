import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../platform/config';
import { validEnv } from '../../../tests/env';

/**
 * The curation allow list is a security boundary, not a convenience: these routes write
 * platform-global rows that every workspace reads. The fail-closed default is the whole
 * reason this variable exists separately from `ALLOWED_EMAILS`, so it gets its own test.
 */
describe('TREND_ADMIN_EMAILS', () => {
  it('defaults to an empty list, which denies everyone', () => {
    // The inverse of ALLOWED_EMAILS on purpose. If an unset variable meant "anyone", a
    // fresh deploy would hand every signed-in user write access to every tenant's feed.
    const config = loadConfig(validEnv());
    expect(config.trend.adminEmails).toEqual([]);
  });

  it('parses a comma-separated list and trims it', () => {
    const config = loadConfig(
      validEnv({ TREND_ADMIN_EMAILS: 'curator@buzzalicious.test, second@buzzalicious.test' }),
    );

    expect(config.trend.adminEmails).toEqual([
      'curator@buzzalicious.test',
      'second@buzzalicious.test',
    ]);
  });
});
