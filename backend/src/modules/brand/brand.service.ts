import { Platform, Prisma, type Brand } from '@prisma/client';
import { z } from 'zod';
import { NotFoundError, ValidationError } from '../../platform/errors';
import type { ScopedDb } from '../../platform/tenancy';
import {
  DEFAULT_PALETTE,
  DEFAULT_TARGET_PLATFORMS,
  DEFAULT_TYPOGRAPHY,
  DEFAULT_VOICE_GUIDE,
  slugify,
  uniqueSlug,
} from '../identity/onboarding';
import {
  BrandGoalsSchema,
  BrandPaletteSchema,
  BrandTypographySchema,
  BrandVoiceGuideSchema,
} from './brand.schemas';
import { describeTypographyProblem } from './fonts';

/**
 * Brand kit reads and writes.
 *
 * Every function here takes a `ScopedDb` — never `Db`, and certainly never `PrismaClient`.
 * That is not a style preference: `PrismaClient` skips the encryption extension, and an
 * unscoped `Db` skips the tenant filter. Both type-check and both are wrong.
 *
 * The JSON columns are validated against W2's schemas in `brand.schemas.ts`. There are no
 * validators of our own here — a second definition of "what a valid voice guide is" is a
 * contract with two sources of truth, which is worse than none.
 */

/**
 * IANA zone, never a UTC offset: an offset changes twice a year and the schedule drifts.
 *
 * Validated by asking `Intl` to use it, which is the only check that matches what the
 * scheduler will actually do with the value.
 */
export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

const TimezoneSchema = z.string().refine(isValidTimeZone, {
  message: 'Expected an IANA time zone name such as "America/New_York"',
});

const PlatformSchema = z.nativeEnum(Platform);

/**
 * Typography is checked in two steps because it fails for two different reasons: a
 * malformed shape, and a well-formed shape naming a font the renderer cannot draw with.
 * Satori has no system font fallback, so the second renders a blank image rather than
 * raising — which is exactly why it is rejected here instead.
 */
const RenderableTypographySchema = BrandTypographySchema.superRefine((typography, ctx) => {
  const problem = describeTypographyProblem(typography);
  if (problem) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
  }
});

export const CreateBrandSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    website: z.string().url().max(2048).optional().nullable(),
    categoryId: z.string().uuid().optional().nullable(),
    palette: BrandPaletteSchema.optional(),
    typography: RenderableTypographySchema.optional(),
    voiceGuide: BrandVoiceGuideSchema.optional(),
    goals: BrandGoalsSchema.optional().nullable(),
    targetPlatforms: z.array(PlatformSchema).max(4).optional(),
    timezone: TimezoneSchema.optional(),
  })
  .strict();

export type CreateBrandInput = z.infer<typeof CreateBrandSchema>;

/**
 * Every field optional, but `.strict()` so an unknown key is an error rather than a silent
 * no-op. A typo'd field name that returns 200 and changes nothing is the kind of bug that
 * gets diagnosed as "the save button is broken".
 */
export const UpdateBrandSchema = CreateBrandSchema.partial().strict();

export type UpdateBrandInput = z.infer<typeof UpdateBrandSchema>;

/** What the API returns. An explicit projection, so a new column is never leaked by default. */
export interface BrandView {
  id: string;
  workspaceId: string;
  name: string;
  slug: string;
  website: string | null;
  categoryId: string | null;
  logoAssetId: string | null;
  palette: unknown;
  typography: unknown;
  voiceGuide: unknown;
  goals: unknown;
  targetPlatforms: Platform[];
  timezone: string;
  createdAt: Date;
  updatedAt: Date;
}

export function toBrandView(brand: Brand): BrandView {
  return {
    id: brand.id,
    workspaceId: brand.workspaceId,
    name: brand.name,
    slug: brand.slug,
    website: brand.website,
    categoryId: brand.categoryId,
    logoAssetId: brand.logoAssetId,
    palette: brand.palette,
    typography: brand.typography,
    voiceGuide: brand.voiceGuide,
    goals: brand.goals,
    targetPlatforms: brand.targetPlatforms,
    timezone: brand.timezone,
    createdAt: brand.createdAt,
    updatedAt: brand.updatedAt,
  };
}

/**
 * Every brand in scope.
 *
 * `deletedAt: null` is not optional anywhere in this module: a soft-deleted brand that
 * reappears in a list is indistinguishable from a failed delete.
 */
export async function listBrands(db: ScopedDb): Promise<Brand[]> {
  return db.brand.findMany({
    where: { deletedAt: null },
    orderBy: { name: 'asc' },
  });
}

export async function getBrand(db: ScopedDb, brandId: string): Promise<Brand> {
  const brand = await db.brand.findFirst({ where: { id: brandId, deletedAt: null } });
  if (!brand) throw new NotFoundError('Brand');
  return brand;
}

/**
 * Confirm a category exists before pointing a brand at it.
 *
 * `BusinessCategory` is global (ADR-0010), so this is read through the scoped client
 * without a tenant filter — that is correct, not an omission.
 */
async function assertCategoryExists(db: ScopedDb, categoryId: string): Promise<void> {
  const category = await db.businessCategory.findUnique({ where: { id: categoryId } });
  if (!category) {
    throw new ValidationError('That business category does not exist', {
      details: { field: 'categoryId' },
    });
  }
}

export async function createBrand(
  db: ScopedDb,
  workspaceId: string,
  input: CreateBrandInput,
): Promise<Brand> {
  if (input.categoryId) await assertCategoryExists(db, input.categoryId);

  const slug = await uniqueSlug(slugify(input.name) || 'brand', async (candidate) => {
    // Unique per workspace, so the scoped client's filter is what makes this correct.
    const existing = await db.brand.findFirst({ where: { slug: candidate } });
    return existing !== null;
  });

  // Defaults come from onboarding so a brand created through the API and one created at
  // first login are the same object, rather than two subtly different ones.
  return db.brand.create({
    data: {
      workspaceId,
      name: input.name,
      slug,
      website: input.website ?? null,
      categoryId: input.categoryId ?? null,
      palette: (input.palette ?? DEFAULT_PALETTE) as Prisma.InputJsonValue,
      typography: (input.typography ?? DEFAULT_TYPOGRAPHY) as Prisma.InputJsonValue,
      voiceGuide: (input.voiceGuide ?? DEFAULT_VOICE_GUIDE) as Prisma.InputJsonValue,
      goals: (input.goals ?? undefined) as Prisma.InputJsonValue | undefined,
      targetPlatforms: input.targetPlatforms ?? DEFAULT_TARGET_PLATFORMS,
      ...(input.timezone ? { timezone: input.timezone } : {}),
    },
  });
}

export async function updateBrand(
  db: ScopedDb,
  brandId: string,
  input: UpdateBrandInput,
): Promise<Brand> {
  await getBrand(db, brandId);

  if (input.categoryId) await assertCategoryExists(db, input.categoryId);

  const data: Prisma.BrandUpdateInput = {};

  if (input.name !== undefined) data.name = input.name;
  if (input.website !== undefined) data.website = input.website;
  if (input.palette !== undefined) data.palette = input.palette as Prisma.InputJsonValue;
  if (input.typography !== undefined) data.typography = input.typography as Prisma.InputJsonValue;
  if (input.voiceGuide !== undefined) data.voiceGuide = input.voiceGuide as Prisma.InputJsonValue;
  if (input.targetPlatforms !== undefined) data.targetPlatforms = input.targetPlatforms;
  if (input.timezone !== undefined) data.timezone = input.timezone;

  // `null` clears the relation; `undefined` means "not mentioned in this request". They
  // must not be collapsed, or clearing a category becomes impossible.
  if (input.categoryId !== undefined) {
    data.category = input.categoryId ? { connect: { id: input.categoryId } } : { disconnect: true };
  }

  if (input.goals !== undefined) {
    data.goals = (input.goals ?? Prisma.DbNull) as Prisma.InputJsonValue;
  }

  return db.brand.update({ where: { id: brandId }, data });
}

/**
 * Soft delete.
 *
 * A brand carries posts, metrics, short links and credentials, so a hard delete is a
 * decision nobody should be able to make by misclicking. Offboarding a whole client is a
 * workspace-level operation and cascades properly (ADR-0010); this is not that.
 */
export async function deleteBrand(db: ScopedDb, brandId: string): Promise<void> {
  await getBrand(db, brandId);
  await db.brand.update({ where: { id: brandId }, data: { deletedAt: new Date() } });
}

/** Point a brand at one of its own assets as the logo. */
export async function setBrandLogo(
  db: ScopedDb,
  brandId: string,
  assetId: string | null,
): Promise<Brand> {
  await getBrand(db, brandId);

  if (assetId) {
    // Scoped, so an asset id belonging to another brand simply is not found — the check
    // and the tenancy boundary are the same query.
    const asset = await db.asset.findFirst({ where: { id: assetId } });
    if (!asset) throw new NotFoundError('Asset');
  }

  return db.brand.update({
    where: { id: brandId },
    data: { logoAssetId: assetId },
  });
}
