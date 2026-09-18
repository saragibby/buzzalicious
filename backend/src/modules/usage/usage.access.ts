import { getConfig } from '../../platform/config';
import { ForbiddenError } from '../../platform/errors';

/**
 * Who may read platform-wide usage.
 *
 * Its own list, not `TREND_ADMIN_EMAILS`. The two grant different things: trend curation
 * writes global content rows, this reads every client's spend. Reusing one variable for
 * both would mean a content curator quietly gains visibility of every tenant's costs, and
 * separating them later means auditing which of the two a name was added for.
 *
 * **Fail-closed**, for the same reason `isTrendAdmin` is: an unset variable must never
 * resolve to "everyone signed in".
 */
export function isPlatformAdmin(email: string | undefined | null): boolean {
  if (!email) return false;

  const allowed = getConfig().platform.adminEmails;
  if (allowed.length === 0) return false;

  const normalized = email.trim().toLowerCase();
  return allowed.some((candidate) => candidate.trim().toLowerCase() === normalized);
}

export function assertPlatformAdmin(email: string | undefined | null): void {
  if (!isPlatformAdmin(email)) {
    throw new ForbiddenError('Usage administration is restricted to platform administrators');
  }
}
