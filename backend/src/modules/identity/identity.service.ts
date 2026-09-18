import type { User } from '@prisma/client';
import { getConfig } from '../../platform/config';
import { getPrisma } from '../../platform/db';
import { getLogger } from '../../platform/logger';
import { createFirstWorkspace } from './onboarding';

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
 * On first login the user also gets a `Workspace`, an owning `Membership` and a default
 * `Brand` (`onboarding.ts`). That is the seam M1 documented and could not fill, because
 * the models did not exist until W2 wrote them.
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

    // An account can predate its workspace: a user invited by email, or one created
    // before this ran. Sign-in is the only moment we are certain to have their identity,
    // so it is also the only reliable place to repair it.
    await ensureWorkspace(user);

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

  const { workspace } = await createFirstWorkspace(prisma, user);

  getLogger().info(
    { userId: user.id, workspaceId: workspace.id },
    'Created user, workspace and default brand on first Google sign-in',
  );

  return { user, isNewUser: true };
}

/**
 * Give a user a workspace if they somehow have none.
 *
 * Signing in successfully and landing in a product with nothing reachable is a worse
 * failure than being refused, and it is not self-healing: nothing else in the system
 * notices a user with zero memberships.
 */
async function ensureWorkspace(user: User): Promise<void> {
  const prisma = getPrisma();
  const existing = await prisma.membership.findFirst({ where: { userId: user.id } });
  if (existing) return;

  const { workspace } = await createFirstWorkspace(prisma, user);
  getLogger().info(
    { userId: user.id, workspaceId: workspace.id },
    'Created a workspace for a user who had none',
  );
}

export async function findUserById(id: string): Promise<User | null> {
  return getPrisma().user.findUnique({ where: { id } });
}
