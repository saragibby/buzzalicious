import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AspectRatio, MediaType, PostStatus } from '@prisma/client';
import { disconnectPrisma, getPrisma, type Db } from '../../src/platform/db';
import { getStorage } from '../../src/platform/storage';
import { categoryId } from '../../prisma/seed/taxonomy';
import { renderOne, renderPost, cacheKeyFor } from '../../src/modules/render/render.service';
import { rankTemplates } from '../../src/modules/template/relevance';
import { hasTestDatabase } from '../env';

/**
 * The parts of W4 that only exist against a database: the rendition cache, the text-only
 * path, and industry relevance ranking.
 *
 * These run against W2's seed, which `tests/global-setup.ts` applies to
 * `TEST_DATABASE_URL` before any test file runs — do not seed locally here, and do not
 * assume a particular file ordering. Without a database the file skips; `npm test` has to
 * pass on a clean clone with no Postgres (docs/12).
 */

describe.skipIf(!hasTestDatabase)('render service', () => {
  let db: Db;
  let brandId: string;
  let workspaceId: string;
  let templateId: string;
  let templateVersion: number;

  beforeAll(async () => {
    db = getPrisma();

    const brand = await db.brand.findFirstOrThrow({ select: { id: true, workspaceId: true } });
    brandId = brand.id;
    workspaceId = brand.workspaceId;

    const template = await db.template.findFirstOrThrow({
      where: { slug: 'big-number' },
      select: { id: true, version: true },
    });
    templateId = template.id;
    templateVersion = template.version;
  });

  afterAll(async () => {
    await disconnectPrisma();
  });

  const request = {
    templateId: '',
    templateVersion: 0,
    brandId: '',
    slotValues: { stat: '68%', context: 'of guests book again within the year.' },
    aspectRatio: AspectRatio.SQUARE_1_1,
  };

  const build = () => ({ ...request, templateId, templateVersion, brandId });

  it('renders and stores a rendition', async () => {
    const result = await renderOne(db, workspaceId, build(), { force: true });

    expect(result.cached).toBe(false);
    expect(result.width).toBe(1080);
    expect(result.height).toBe(1080);
    await expect(getStorage().exists(result.storageKey)).resolves.toBe(true);
  });

  it('reuses a stored rendition for identical inputs', async () => {
    const first = await renderOne(db, workspaceId, build(), { force: true });

    // `renderOne` does not persist — `renderPost` does — so the row this cache reads has
    // to exist for the lookup to be exercised at all.
    const post = await db.post.create({
      data: {
        brandId,
        templateId,
        templateVersion,
        mediaType: MediaType.IMAGE,
        status: PostStatus.DRAFT,
        slotValues: build().slotValues,
        renditions: {
          create: {
            aspectRatio: first.aspectRatio,
            storageKey: first.storageKey,
            width: first.width,
            height: first.height,
            bytes: first.bytes,
            rendererMeta: first.meta,
          },
        },
      },
    });

    const second = await renderOne(db, workspaceId, build());

    expect(second.cached).toBe(true);
    expect(second.storageKey).toBe(first.storageKey);

    await db.post.delete({ where: { id: post.id } });
  });

  it('re-renders when the slot values change', async () => {
    const changed = { ...build(), slotValues: { ...build().slotValues, stat: '71%' } };

    expect(cacheKeyFor(changed)).not.toBe(cacheKeyFor(build()));

    const result = await renderOne(db, workspaceId, changed);
    expect(result.cached).toBe(false);
  });

  it('returns no renditions for a text-only post', async () => {
    // Seeded by W2 precisely so this path cannot be assumed away: a plain X or Threads
    // post has no image, and asking for its renditions is not an error.
    const post = await db.post.findFirstOrThrow({
      where: { mediaType: MediaType.TEXT },
      select: { id: true },
    });

    await expect(renderPost(db, post.id)).resolves.toEqual([]);
    await expect(db.rendition.count({ where: { postId: post.id } })).resolves.toBe(0);
  });

  it('renders every supported ratio of an image post and persists each one', async () => {
    const post = await db.post.create({
      data: {
        brandId,
        templateId,
        templateVersion,
        mediaType: MediaType.IMAGE,
        status: PostStatus.DRAFT,
        slotValues: build().slotValues,
      },
    });

    const rendered = await renderPost(db, post.id, { force: true });

    expect(rendered.length).toBeGreaterThan(1);
    await expect(db.rendition.count({ where: { postId: post.id } })).resolves.toBe(rendered.length);

    // One render per ratio, shared by every platform using it — renditions hang off the
    // post, not off a target.
    const ratios = rendered.map((item) => item.aspectRatio);
    expect(new Set(ratios).size).toBe(ratios.length);

    await db.post.delete({ where: { id: post.id } });
  });
});

describe.skipIf(!hasTestDatabase)('template relevance', () => {
  let db: Db;

  beforeAll(() => {
    db = getPrisma();
  });

  afterAll(async () => {
    await disconnectPrisma();
  });

  it('ranks differently for two different industries', async () => {
    // The whole differentiator. If a coffee shop and a plumber see the same order, the
    // ranking is decorative.
    const coffee = await rankTemplates(db, { categoryId: categoryId('coffee-shop') });
    const plumber = await rankTemplates(db, { categoryId: categoryId('plumber') });

    expect(coffee.length).toBeGreaterThan(0);
    expect(plumber.length).toBeGreaterThan(0);
    expect(coffee.map((item) => item.slug)).not.toEqual(plumber.map((item) => item.slug));
  });

  it('inherits a parent category weight when the leaf has no direct tag', async () => {
    const ranked = await rankTemplates(db, { categoryId: categoryId('juice-smoothie-bar') });
    const inherited = ranked.filter((item) => item.inherited);

    expect(inherited.length).toBeGreaterThan(0);
    // An inherited match always names the ancestor it came from: `inherited` and
    // `matchedCategoryId` are what the UI turns into "popular in your industry", and a
    // claim of inheritance with nothing to point at is a label on a guess.
    expect(inherited.every((item) => item.matchedCategoryId !== null)).toBe(true);

    // Inheritance is discounted, so a direct tag outranks an inherited one of equal
    // weight and the discounted scores stay below the undiscounted ones.
    const direct = ranked.filter((item) => !item.inherited && item.matchedCategoryId);
    if (direct.length > 0) {
      expect(Math.max(...direct.map((item) => item.score))).toBeGreaterThan(
        Math.min(...inherited.map((item) => item.score)),
      );
    }
  });

  it('returns everything, stably, for a brand with no category yet', async () => {
    const first = await rankTemplates(db, {});
    const second = await rankTemplates(db, {});

    expect(first.length).toBeGreaterThan(0);
    expect(first.map((item) => item.slug)).toEqual(second.map((item) => item.slug));
  });

  it('only offers templates that support the ratios asked for', async () => {
    const ranked = await rankTemplates(db, {
      categoryId: categoryId('coffee-shop'),
      aspectRatios: [AspectRatio.LANDSCAPE_16_9],
    });

    for (const item of ranked) {
      expect(item.supportedRatios).toContain(AspectRatio.LANDSCAPE_16_9);
    }
  });

  it('honours the limit', async () => {
    const ranked = await rankTemplates(db, { categoryId: categoryId('bakery'), limit: 3 });

    expect(ranked.length).toBeLessThanOrEqual(3);
  });
});
