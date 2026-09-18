import { Prisma, type Platform, type Post, type PostTarget } from '@prisma/client';
import { NotFoundError, ValidationError } from '../../platform/errors';
import type { ScopedDb } from '../../platform/tenancy';
import {
  SlotSchemaSchema,
  SlotValuesSchema,
  validateSlotValues,
  type SlotValues,
  type TemplateSlotSchema,
} from '../template/template.schemas';
import {
  PLATFORM_SPECS,
  isSupportedPlatform,
  measureCaption,
  type SupportedPlatform,
} from '../template/platform-spec';
import type { CreateDraftInput, UpdateDraftInput } from './post.schemas';

/**
 * Composer drafts.
 *
 * ## Why W5 owns this and not W6
 *
 * A `Post` is the thing the composer is editing, and it exists long before anything is
 * published — M3 ships the whole loop with no platform API involved at all. W6 consumes
 * these rows; it does not create them. The boundary is: **this module never decides
 * anything about publishing.** It writes `PostTarget` rows in `DRAFT` because that is
 * where a per-platform caption lives, and it never sets a status beyond `DRAFT`, never
 * touches `socialAccountId`, and never resolves a credential.
 *
 * ## Tenancy
 *
 * Every function takes a `ScopedDb`. `Post` is scoped by `brandId` and `PostTarget`
 * through `post.brandId` (see `platform/tenancy.ts`), so a draft belonging to another
 * workspace is not findable here — it reads as "not found", which is the correct answer
 * to give someone who should not know it exists.
 */

export interface DraftTargetView {
  platform: SupportedPlatform;
  /** `null` means "inherit the base caption", which is not the same as an empty string. */
  caption: string | null;
}

export interface DraftView {
  id: string;
  brandId: string;
  title: string | null;
  templateId: string | null;
  templateSlug: string | null;
  templateName: string | null;
  templateVersion: number | null;
  slotValues: SlotValues;
  baseCopy: string | null;
  status: string;
  targets: DraftTargetView[];
  updatedAt: Date;
  createdAt: Date;
}

type DraftRow = Post & {
  template: { id: string; slug: string; name: string; version: number } | null;
  targets: Pick<PostTarget, 'platform' | 'caption'>[];
};

const draftInclude = {
  template: { select: { id: true, slug: true, name: true, version: true } },
  targets: { select: { platform: true, caption: true }, orderBy: { platform: 'asc' } },
} as const;

export function toDraftView(post: DraftRow): DraftView {
  return {
    id: post.id,
    brandId: post.brandId,
    title: post.title,
    templateId: post.templateId,
    templateSlug: post.template?.slug ?? null,
    templateName: post.template?.name ?? null,
    templateVersion: post.templateVersion,
    // Re-parsed on the way out rather than cast: this is a JSON column, and a row written
    // before a contract change should fail loudly here instead of inside the renderer.
    slotValues: SlotValuesSchema.parse(post.slotValues ?? {}),
    baseCopy: post.baseCopy,
    status: post.status,
    targets: post.targets
      .filter((target): target is typeof target & { platform: SupportedPlatform } =>
        isSupportedPlatform(target.platform),
      )
      .map((target) => ({ platform: target.platform, caption: target.caption })),
    updatedAt: post.updatedAt,
    createdAt: post.createdAt,
  };
}

/**
 * Start a draft from a template.
 *
 * `templateVersion` is pinned at creation. Performance is attributed to a template
 * version (docs/05), and a draft that silently adopts a newer layout would be compared
 * against posts that rendered differently.
 */
export async function createDraft(
  db: ScopedDb,
  brandId: string,
  input: CreateDraftInput,
): Promise<DraftView> {
  // Templates are platform-global, so this read is not scoped and cannot be: there is no
  // tenant column on `Template` to scope by (ADR-0010).
  const template = await db.template.findFirst({
    where: { slug: input.templateSlug, status: 'PUBLISHED' },
    select: { id: true, version: true, slotSchema: true },
  });

  if (!template) throw new NotFoundError('Template');

  const brand = await db.brand.findFirst({
    where: { id: brandId, deletedAt: null },
    select: { targetPlatforms: true },
  });

  if (!brand) throw new NotFoundError('Brand');

  const post = await db.post.create({
    data: {
      brandId,
      templateId: template.id,
      templateVersion: template.version,
      title: input.title ?? null,
      slotValues: applyTextDefaults(SlotSchemaSchema.parse(template.slotSchema), input.slotValues),
      status: 'DRAFT',
      mediaType: 'IMAGE',
      // Seeded from the brand's declared targets so the composer opens on the platforms
      // this brand actually posts to, rather than on all four for everyone.
      targets: {
        create: supportedTargetsOf(brand.targetPlatforms).map((platform) => ({ platform })),
      },
    },
    include: draftInclude,
  });

  return toDraftView(post);
}

/**
 * Pre-fill text slots that declare a default.
 *
 * The renderer already falls back to `default` when a value is missing, but the composer
 * form shows what is in `slotValues` — so without this the user sees empty boxes while
 * the preview beside them shows text, which reads as a bug.
 */
function applyTextDefaults(
  slotSchema: TemplateSlotSchema,
  provided: SlotValues | undefined,
): SlotValues {
  const values: SlotValues = { ...(provided ?? {}) };

  for (const [name, definition] of Object.entries(slotSchema)) {
    if (definition.type !== 'text') continue;
    if (values[name] !== undefined) continue;
    if (definition.default === undefined) continue;
    values[name] = definition.default;
  }

  return values;
}

function supportedTargetsOf(platforms: readonly Platform[]): SupportedPlatform[] {
  const supported = platforms.filter(isSupportedPlatform);
  // A brand with no declared targets still needs somewhere to write a caption, and an
  // export with zero captions is not an export. Instagram is the v1 wedge's centre of
  // gravity, so it is the honest default rather than an arbitrary one.
  return supported.length > 0 ? supported : ['INSTAGRAM'];
}

export async function getDraft(db: ScopedDb, postId: string): Promise<DraftView> {
  const post = await db.post.findFirst({
    where: { id: postId, deletedAt: null },
    include: draftInclude,
  });

  if (!post) throw new NotFoundError('Draft');
  return toDraftView(post);
}

export async function listDrafts(db: ScopedDb, limit = 50): Promise<DraftView[]> {
  const posts = await db.post.findMany({
    where: { deletedAt: null, status: 'DRAFT' },
    include: draftInclude,
    orderBy: { updatedAt: 'desc' },
    take: Math.min(limit, 200),
  });

  return posts.map(toDraftView);
}

/**
 * Save composer state.
 *
 * Partial by design — the composer autosaves a field at a time, and a PATCH that required
 * the whole draft would make two tabs, or a slow network, overwrite each other's work
 * with whatever the sender last read.
 */
export async function updateDraft(
  db: ScopedDb,
  postId: string,
  input: UpdateDraftInput,
): Promise<DraftView> {
  // Establishes the draft is in scope before any write. The scoped client would refuse a
  // cross-tenant update anyway, but "not found" is a better answer than a Prisma error.
  await getDraft(db, postId);

  const data: Prisma.PostUncheckedUpdateInput = {};
  if (input.title !== undefined) data.title = input.title;
  if (input.slotValues !== undefined) data.slotValues = input.slotValues;
  if (input.baseCopy !== undefined) data.baseCopy = input.baseCopy;

  if (Object.keys(data).length > 0) {
    await db.post.update({ where: { id: postId }, data });
  }

  if (input.platforms !== undefined) {
    await setTargets(db, postId, input.platforms as SupportedPlatform[]);
  }

  if (input.captionOverrides !== undefined) {
    await setCaptionOverrides(db, postId, input.captionOverrides);
  }

  return getDraft(db, postId);
}

/**
 * Replace the set of platforms this draft targets.
 *
 * Removing a platform deletes its `PostTarget`, and with it any caption override written
 * for it. That is the intent — the alternative is an invisible caption that reappears if
 * the platform is re-added, having been edited against copy that has since changed.
 */
async function setTargets(
  db: ScopedDb,
  postId: string,
  platforms: SupportedPlatform[],
): Promise<void> {
  if (platforms.length === 0) {
    throw new ValidationError('A post needs at least one platform to export for');
  }

  const unique = [...new Set(platforms)];

  await db.postTarget.deleteMany({
    where: { postId, platform: { notIn: unique as Platform[] } },
  });

  // `createMany` with `skipDuplicates` rather than a read-then-write: the unique index on
  // (postId, platform) is what actually guarantees this, and checking first would still
  // race with a second tab doing the same thing.
  await db.postTarget.createMany({
    data: unique.map((platform) => ({ postId, platform: platform as Platform })),
    skipDuplicates: true,
  });
}

async function setCaptionOverrides(
  db: ScopedDb,
  postId: string,
  overrides: Partial<Record<string, string | null>>,
): Promise<void> {
  for (const [platform, caption] of Object.entries(overrides)) {
    if (!isSupportedPlatform(platform)) continue;

    // `undefined` reaches here only from an explicit `{ INSTAGRAM: undefined }`, which
    // means the same thing as omitting the key: inherit the base copy.
    const value = caption ?? null;

    if (value !== null) {
      // Counted the way the platform counts, not with `.length` — see `countCaption`.
      const count = measureCaption(platform, value);
      if (count.over) {
        throw new ValidationError(
          `That caption is ${count.used} characters as ${PLATFORM_SPECS[platform].label} ` +
            `counts them, and the limit is ${count.limit}.`,
        );
      }
    }

    // Only updates an existing target. A caption for a platform the draft does not target
    // is a no-op rather than an error: the composer can send a stale tab's edit after the
    // user unticked that platform, and failing the whole save over it loses the rest.
    await db.postTarget.updateMany({
      where: { postId, platform: platform as Platform },
      data: { caption: value },
    });
  }
}

/** Soft delete, matching every other read path's `deletedAt: null` filter. */
export async function deleteDraft(db: ScopedDb, postId: string): Promise<void> {
  await getDraft(db, postId);
  await db.post.update({ where: { id: postId }, data: { deletedAt: new Date() } });
}

/**
 * Whether this draft is renderable, and what is missing if not.
 *
 * Returned rather than thrown, so the composer can grey out Export and *say why* while
 * the user is still typing. Export itself re-checks; this is the friendly half.
 */
export async function draftReadiness(
  db: ScopedDb,
  postId: string,
): Promise<{ ready: boolean; issues: { slot: string; message: string }[] }> {
  const post = await db.post.findFirst({
    where: { id: postId, deletedAt: null },
    include: { template: { select: { slotSchema: true } } },
  });

  if (!post) throw new NotFoundError('Draft');
  if (!post.template) {
    return {
      ready: false,
      issues: [{ slot: '', message: 'The template this draft used has been retired' }],
    };
  }

  const issues = validateSlotValues(
    SlotSchemaSchema.parse(post.template.slotSchema),
    SlotValuesSchema.parse(post.slotValues ?? {}),
  );

  return { ready: issues.length === 0, issues };
}
