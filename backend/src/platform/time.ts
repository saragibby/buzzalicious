/**
 * Local wall time ↔ UTC instant, for IANA zones.
 *
 * `Post` stores both `scheduledAt` (the UTC instant) and `scheduledLocal` + `scheduledTz`
 * (the intent), because storing only the instant loses what the user meant: "every Tuesday
 * at 9am" silently becomes 8am or 10am after a DST transition and recurring schedules
 * drift (docs/06). Converting between the two correctly is the other half of that, and it
 * is the half that is easy to get subtly wrong.
 *
 * Implemented with `Intl` rather than a date library: Node ships the full IANA database,
 * and a dependency whose zone data can fall out of date is a worse answer than the one the
 * platform already maintains.
 */

const ISO_LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

/** Milliseconds a zone is ahead of UTC at a given instant. Negative west of Greenwich. */
export function zoneOffsetMs(instant: Date, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(instant)) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }

  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    // `hour12: false` renders midnight as 24 in some ICU versions.
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );

  return asUtc - instant.getTime();
}

/**
 * The UTC instant at which `localTime` occurs in `timeZone`.
 *
 * `localTime` is a zoneless wall clock string, `"2026-03-08T09:00"`. Two passes, because
 * the offset depends on the instant we are trying to find: the first guess lands close
 * enough that the second resolves correctly, including across a transition.
 */
export function zonedTimeToUtc(localTime: string, timeZone: string): Date {
  if (!ISO_LOCAL.test(localTime)) {
    throw new RangeError(
      `Expected a zoneless local time like "2026-03-08T09:00", got "${localTime}"`,
    );
  }

  const naive = Date.parse(`${localTime.length === 16 ? `${localTime}:00` : localTime}Z`);
  let instant = naive - zoneOffsetMs(new Date(naive), timeZone);
  instant = naive - zoneOffsetMs(new Date(instant), timeZone);

  return new Date(instant);
}

/** The wall clock reading in `timeZone` at `instant`, as `"YYYY-MM-DDTHH:mm"`. */
export function utcToZonedTime(instant: Date, timeZone: string): string {
  const shifted = new Date(instant.getTime() + zoneOffsetMs(instant, timeZone));
  return shifted.toISOString().slice(0, 16);
}

/** Local hour of day in `timeZone`. The input to daypart bucketing. */
export function zonedHour(instant: Date, timeZone: string): number {
  return Number(utcToZonedTime(instant, timeZone).slice(11, 13));
}

/** Local day of week in `timeZone`, 0 = Sunday. */
export function zonedDayOfWeek(instant: Date, timeZone: string): number {
  const local = utcToZonedTime(instant, timeZone);
  return new Date(`${local}:00Z`).getUTCDay();
}

/** Whether a local date falls on a weekend in `timeZone`. Drives the day-type bucket. */
export function isWeekendInZone(instant: Date, timeZone: string): boolean {
  const day = zonedDayOfWeek(instant, timeZone);
  return day === 0 || day === 6;
}
