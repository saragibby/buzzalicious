import { describe, expect, it } from 'vitest';
import {
  isWeekendInZone,
  utcToZonedTime,
  zoneOffsetMs,
  zonedDayOfWeek,
  zonedHour,
  zonedTimeToUtc,
} from './time';

const NEW_YORK = 'America/New_York';
const CHICAGO = 'America/Chicago';

describe('zonedTimeToUtc', () => {
  it('resolves a summer instant at the DST offset', () => {
    expect(zonedTimeToUtc('2026-07-04T09:00', NEW_YORK).toISOString()).toBe(
      '2026-07-04T13:00:00.000Z',
    );
  });

  it('resolves a winter instant at the standard offset', () => {
    expect(zonedTimeToUtc('2026-01-15T09:00', NEW_YORK).toISOString()).toBe(
      '2026-01-15T14:00:00.000Z',
    );
  });

  it('keeps 9am local as 9am local across a spring-forward boundary', () => {
    // The whole reason Post stores scheduledLocal + scheduledTz beside the UTC instant.
    // US DST began 2026-03-08: the same wall time maps to different instants either side,
    // and a schedule stored only as an instant would silently shift by an hour.
    const before = zonedTimeToUtc('2026-03-07T09:00', NEW_YORK);
    const after = zonedTimeToUtc('2026-03-09T09:00', NEW_YORK);

    expect(before.toISOString()).toBe('2026-03-07T14:00:00.000Z');
    expect(after.toISOString()).toBe('2026-03-09T13:00:00.000Z');
    expect(zonedHour(before, NEW_YORK)).toBe(9);
    expect(zonedHour(after, NEW_YORK)).toBe(9);
  });

  it('keeps 9am local as 9am local across a fall-back boundary', () => {
    // US DST ended 2025-11-02.
    const before = zonedTimeToUtc('2025-11-01T09:00', NEW_YORK);
    const after = zonedTimeToUtc('2025-11-03T09:00', NEW_YORK);

    expect(before.toISOString()).toBe('2025-11-01T13:00:00.000Z');
    expect(after.toISOString()).toBe('2025-11-03T14:00:00.000Z');
    expect(zonedHour(after, NEW_YORK)).toBe(9);
  });

  it('separates two zones that share a wall clock reading', () => {
    const eastern = zonedTimeToUtc('2026-05-12T12:00', NEW_YORK);
    const central = zonedTimeToUtc('2026-05-12T12:00', CHICAGO);
    expect(central.getTime() - eastern.getTime()).toBe(60 * 60 * 1000);
  });

  it('accepts seconds and rejects anything carrying a zone of its own', () => {
    expect(zonedTimeToUtc('2026-05-12T12:00:30', NEW_YORK).toISOString()).toBe(
      '2026-05-12T16:00:30.000Z',
    );
    // A string with a Z or an offset is not a wall clock reading, and silently treating it
    // as one would apply the zone twice.
    expect(() => zonedTimeToUtc('2026-05-12T12:00:00Z', NEW_YORK)).toThrow(RangeError);
    expect(() => zonedTimeToUtc('2026-05-12', NEW_YORK)).toThrow(RangeError);
  });
});

describe('utcToZonedTime', () => {
  it('round-trips a wall time through the instant and back', () => {
    for (const local of ['2026-03-09T09:00', '2025-11-03T18:30', '2026-07-04T05:15']) {
      expect(utcToZonedTime(zonedTimeToUtc(local, NEW_YORK), NEW_YORK)).toBe(local);
    }
  });

  it('renders midnight as hour 00, not 24', () => {
    expect(utcToZonedTime(zonedTimeToUtc('2026-02-01T00:00', NEW_YORK), NEW_YORK)).toBe(
      '2026-02-01T00:00',
    );
  });
});

describe('zoneOffsetMs', () => {
  it('reports the summer and winter offsets for Eastern time', () => {
    expect(zoneOffsetMs(new Date('2026-07-04T16:00:00Z'), NEW_YORK)).toBe(-4 * 3600_000);
    expect(zoneOffsetMs(new Date('2026-01-04T16:00:00Z'), NEW_YORK)).toBe(-5 * 3600_000);
  });
});

describe('day typing', () => {
  it('reports the local day, not the UTC day', () => {
    // 8pm Saturday in New York is already Sunday in UTC. Bucketing on the UTC day would
    // file a Saturday-evening post as a Sunday post and score the wrong slot.
    const saturdayEvening = zonedTimeToUtc('2026-05-16T20:00', NEW_YORK);
    expect(saturdayEvening.getUTCDay()).toBe(0);
    expect(zonedDayOfWeek(saturdayEvening, NEW_YORK)).toBe(6);
    expect(isWeekendInZone(saturdayEvening, NEW_YORK)).toBe(true);
  });

  it('treats weekdays as weekdays', () => {
    expect(isWeekendInZone(zonedTimeToUtc('2026-05-13T12:00', NEW_YORK), NEW_YORK)).toBe(false);
  });
});
