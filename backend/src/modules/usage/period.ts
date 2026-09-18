/**
 * Billing periods.
 *
 * One UTC calendar month, and deliberately not the workspace's local month. A period
 * boundary that moved with a brand's timezone would make two workspaces' "September"
 * different windows, and a rollup rebuilt on a machine in another zone would disagree with
 * the incrementally maintained one — which is a billing error, not a display bug.
 */

/** First instant of the UTC calendar month containing `instant`. */
export function periodStartFor(instant: Date): Date {
  return new Date(Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), 1, 0, 0, 0, 0));
}

/** First instant of the *next* UTC month — the exclusive end of the period. */
export function periodEndFor(instant: Date): Date {
  return new Date(Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth() + 1, 1, 0, 0, 0, 0));
}

/** `2026-09` for the period containing `instant`. The admin view's query parameter. */
export function periodKeyFor(instant: Date): string {
  const month = String(instant.getUTCMonth() + 1).padStart(2, '0');
  return `${instant.getUTCFullYear()}-${month}`;
}

/**
 * Parse a `YYYY-MM` period key back to its start instant.
 *
 * Returns `null` rather than throwing, so a caller maps a bad query parameter to its own
 * validation error instead of a 500.
 */
export function parsePeriodKey(key: string): Date | null {
  const match = /^(\d{4})-(\d{2})$/.exec(key);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;

  return new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
}
