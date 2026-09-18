import type { Db } from '../../platform/db';
import { getConfig } from '../../platform/config';
import { ForbiddenError, NotFoundError } from '../../platform/errors';

/**
 * Authorization for the trend surfaces.
 *
 * > **W3 seam.** Workspace membership checks belong in `modules/identity/`, which W3 is
 * > building in parallel. `require-auth.ts` deliberately answers only "is there a
 * > session?", and W9 needs "may this user read this brand's feed" — so this is the
 * > narrowest possible version of that check, isolated in one file so W3 can delete it and
 * > point the two call sites at the real helper. It is not a second permission system.
 */

/**
 * Asserts the user belongs to the workspace that owns the brand.
 *
 * Both failures return 404, not 403. Telling an outsider that a brand id exists but is not
 * theirs turns the endpoint into an oracle for enumerating other tenants' brands, and the
 * brand's existence is itself the information worth protecting.
 */
export async function assertBrandAccess(db: Db, userId: string, brandId: string): Promise<void> {
  const brand = await db.brand.findFirst({
    where: { id: brandId, deletedAt: null },
    select: { workspaceId: true },
  });

  if (!brand) throw new NotFoundError('Brand');

  const membership = await db.membership.findFirst({
    where: { userId, workspaceId: brand.workspaceId },
    select: { id: true },
  });

  if (!membership) throw new NotFoundError('Brand');
}

/**
 * Whether an email may curate the global trend feed.
 *
 * **Fail-closed, and deliberately the inverse of `ALLOWED_EMAILS`.** An empty sign-in
 * allow list means "anyone with a Google account", which is the right default for a
 * product with public signup. An empty curation list means *nobody*: curation writes
 * platform-global rows that every workspace reads, so an unset variable must not silently
 * hand every signed-in user a write surface over every tenant's feed.
 */
export function isTrendAdmin(email: string | undefined | null): boolean {
  if (!email) return false;

  const allowed = getConfig().trend.adminEmails;
  if (allowed.length === 0) return false;

  const normalized = email.trim().toLowerCase();
  return allowed.some((candidate) => candidate.trim().toLowerCase() === normalized);
}

export function assertTrendAdmin(email: string | undefined | null): void {
  if (!isTrendAdmin(email)) {
    throw new ForbiddenError('Trend curation is restricted to platform administrators');
  }
}
