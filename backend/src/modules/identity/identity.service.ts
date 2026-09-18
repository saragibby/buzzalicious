import type { User } from '@prisma/client';
import { getConfig } from '../../platform/config';
import { getPrisma } from '../../platform/db';
import { getLogger } from '../../platform/logger';

/**
 * Identity: who is signed in, and what they belong to.
 *
 * Ported from the prototype's `auth.ts`, with the env reads replaced by config and the
 * `console.log` of denied emails removed — an email address is PII and had no business
 * in a log line (docs/10-credentials-and-security.md).
 */

export interface GoogleProfileInput {
  googleId: string;
  email: string;
  name?: string;
  picture?: string;
}

/**
 * Optional sign-in allow list. Empty lists mean "anyone with a Google account", which is
 * the correct default for a product with public signup; the lists exist because the
 * dogfooding period is invite-only.
 */
export function isSignInAllowed(email: string): boolean {
  const { allowedEmails, allowedDomains } = getConfig().google;

  if (allowedEmails.length === 0 && allowedDomains.length === 0) return true;

  const normalized = email.toLowerCase();
  if (allowedEmails.some((allowed) => allowed.toLowerCase() === normalized)) return true;
  return allowedDomains.some((domain) => normalized.endsWith(`@${domain.toLowerCase()}`));
}

/**
 * Find or create the user behind a Google profile.
 *
 * Links by `googleId` first, then falls back to `email` so that a user who existed before
 * Google sign-in — or who is re-linking — is updated rather than duplicated.
 *
 * > **W3 seam.** This must also create a `Workspace` and an owning `Membership` on first
 * > login (docs/03-teardown.md, docs/tasks/W3-identity-brand.md). It cannot be done here
 * > yet: those models do not exist until W2 writes the schema, and W2 owns
 * > `prisma/schema.prisma` exclusively. The hook point is the `isNewUser` branch below.
 */
export async function findOrCreateGoogleUser(
  profile: GoogleProfileInput,
): Promise<{ user: User; isNewUser: boolean }> {
  const prisma = getPrisma();

  const existingByGoogleId = await prisma.user.findUnique({
    where: { googleId: profile.googleId },
  });

  if (existingByGoogleId) {
    return { user: existingByGoogleId, isNewUser: false };
  }

  const existingByEmail = await prisma.user.findUnique({ where: { email: profile.email } });

  if (existingByEmail) {
    const user = await prisma.user.update({
      where: { id: existingByEmail.id },
      data: {
        googleId: profile.googleId,
        picture: profile.picture,
        name: profile.name ?? existingByEmail.name,
      },
    });
    return { user, isNewUser: false };
  }

  const user = await prisma.user.create({
    data: {
      googleId: profile.googleId,
      email: profile.email,
      name: profile.name,
      picture: profile.picture,
    },
  });

  // W3: create the user's Workspace + owning Membership here.
  getLogger().info({ userId: user.id }, 'Created user on first Google sign-in');

  return { user, isNewUser: true };
}

export async function findUserById(id: string): Promise<User | null> {
  return getPrisma().user.findUnique({ where: { id } });
}
