import { Platform, Role, type Brand, type Membership, type Workspace } from '@prisma/client';
import type { Db } from '../../platform/db';
import {
  BrandGoalsSchema,
  BrandPaletteSchema,
  BrandTypographySchema,
  BrandVoiceGuideSchema,
} from '../brand/brand.schemas';

/**
 * What a brand new account starts with.
 *
 * A first-login brand has to be *valid*, not empty: `Brand.palette`, `typography` and
 * `voiceGuide` are non-nullable, and every render path assumes they parse. So the defaults
 * below are deliberately neutral but complete — the user edits them, rather than being
 * asked to author a brand kit before the product will show them anything.
 *
 * Everything here is parsed through W2's Zod schemas rather than written as a literal. A
 * default that silently stopped matching the schema would only surface when a template
 * tried to render it.
 */

/**
 * Greyscale with a single blue accent. Chosen to look obviously like a placeholder: a
 * plausible-looking brand palette invites the user to leave it alone, which is the
 * opposite of what onboarding needs.
 */
export const DEFAULT_PALETTE = BrandPaletteSchema.parse({
  primary: '#1f2937',
  secondary: '#4b5563',
  accent: '#2563eb',
  neutral: '#9ca3af',
  background: '#ffffff',
  text: '#111827',
});

/**
 * Inter for both roles. It is the one family the seed already uses for both heading and
 * body, so a default brand renders with fonts the pipeline definitely has — Satori has no
 * system font fallback and a missing family renders a blank image rather than an error.
 */
export const DEFAULT_TYPOGRAPHY = BrandTypographySchema.parse({
  headingFamily: 'Inter',
  bodyFamily: 'Inter',
  headingWeight: 700,
  bodyWeight: 400,
  headingTransform: 'none',
});

export const DEFAULT_VOICE_GUIDE = BrandVoiceGuideSchema.parse({
  summary:
    'Describe how this brand sounds — who it talks to, what it sounds like at its best, ' +
    'and what it would never say. The more specific this is, the better the drafts get.',
  toneAttributes: ['clear', 'friendly'],
  doSay: [],
  dontSay: [],
  vocabulary: [],
  sampleCopy: [],
  readingLevel: 'standard',
  emojiPolicy: 'sparing',
  bannedOpeners: [],
});

export const DEFAULT_GOALS = BrandGoalsSchema.parse({
  primaryGoal: 'awareness',
  targetAudience: 'Describe who this brand is trying to reach.',
  callsToAction: [],
});

/** Image-first by default; the seed's text-first mix is a deliberate per-brand choice. */
export const DEFAULT_TARGET_PLATFORMS: Platform[] = [Platform.INSTAGRAM, Platform.FACEBOOK];

/**
 * A URL-safe slug, or a stable fallback.
 *
 * Returns `''` when nothing survives normalization — a name written entirely in a
 * non-Latin script, for instance. The caller substitutes a generated slug rather than
 * producing `-` or `--`, both of which are legal strings and terrible URLs.
 */
export function slugify(value: string): string {
  return (
    value
      .normalize('NFKD')
      // Strip combining marks so "Café" becomes "cafe" rather than losing the letter.
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48)
      .replace(/-+$/g, '')
  );
}

/**
 * Find a slug nothing has taken yet.
 *
 * Suffixes rather than failing, because this runs during sign-in: a second user called
 * "Dana" must not be met with an error they cannot act on. The loop is bounded because an
 * unbounded retry against a unique constraint is a hang, not a fallback.
 */
export async function uniqueSlug(
  base: string,
  isTaken: (candidate: string) => Promise<boolean>,
  randomSuffix: () => string = () => Math.random().toString(36).slice(2, 8),
): Promise<string> {
  const root = base || 'workspace';

  if (!(await isTaken(root))) return root;

  for (let attempt = 2; attempt <= 10; attempt += 1) {
    const candidate = `${root}-${attempt}`;
    if (!(await isTaken(candidate))) return candidate;
  }

  return `${root}-${randomSuffix()}`;
}

/**
 * Derive a workspace name from whatever Google gave us.
 *
 * `name` can be absent; the email local part is the next best thing and is always
 * present, because sign-in refuses a profile without an email.
 */
export function defaultWorkspaceName(profile: { name?: string | null; email: string }): string {
  const trimmed = profile.name?.trim();
  if (trimmed) return `${trimmed}'s workspace`;

  const localPart = profile.email.split('@')[0];
  return `${localPart}'s workspace`;
}

export interface Onboarded {
  workspace: Workspace;
  membership: Membership;
  brand: Brand;
}

/**
 * Give a new user a workspace, an owning membership, and a brand to edit.
 *
 * One transaction. Half of this — a workspace with no membership, or a membership with no
 * brand — is worse than none: the user signs in successfully and lands in a product with
 * nothing they can reach, and no code path ever retries it because the user is no longer
 * new.
 */
export async function createFirstWorkspace(
  db: Db,
  user: { id: string; email: string; name?: string | null },
): Promise<Onboarded> {
  const workspaceName = defaultWorkspaceName(user);

  const workspaceSlug = await uniqueSlug(
    slugify(workspaceName.replace(/'s workspace$/, '')),
    async (candidate) => (await db.workspace.findUnique({ where: { slug: candidate } })) !== null,
  );

  const brandName = user.name?.trim() || user.email.split('@')[0];

  return db.$transaction(async (tx) => {
    const workspace = await tx.workspace.create({
      data: { name: workspaceName, slug: workspaceSlug },
    });

    const membership = await tx.membership.create({
      data: { userId: user.id, workspaceId: workspace.id, role: Role.OWNER },
    });

    // Brand slug is unique per workspace, and the workspace was just created, so nothing
    // can collide here.
    const brand = await tx.brand.create({
      data: {
        workspaceId: workspace.id,
        name: brandName,
        slug: slugify(brandName) || 'brand',
        palette: DEFAULT_PALETTE,
        typography: DEFAULT_TYPOGRAPHY,
        voiceGuide: DEFAULT_VOICE_GUIDE,
        goals: DEFAULT_GOALS,
        targetPlatforms: DEFAULT_TARGET_PLATFORMS,
      },
    });

    return { workspace, membership, brand };
  });
}
