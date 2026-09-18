import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectPrisma, getPrisma, type Db } from '../../src/platform/db';
import { withTenantScope } from '../../src/platform/tenancy';
import { scheduleTargets } from '../../src/modules/publish/schedule.service';
import { hasTestDatabase } from '../env';

/**
 * That the caption gate is actually **wired into scheduling**.
 *
 * This file exists because of a hole found by mutation testing, and the hole is worth
 * recording. `caption-gate.ts` had fourteen unit tests covering every platform's counting
 * unit and every over-length message — and commenting out the single
 * `await assertCaptionsFit(...)` line inside `scheduleTargets` broke **none of them**.
 * Fourteen green tests for a gate that was not, as far as the suite could tell, connected
 * to anything.
 *
 * A unit test of a guard proves the guard works. Only a test that goes through the real
 * entry point proves the guard is *reached*. So everything here calls `scheduleTargets`,
 * and the assertions are on the persisted row afterwards — an over-length target must
 * still be `DRAFT`, because the whole point is that the user finds out now rather than
 * when the job runs.
 */

describe.skipIf(!hasTestDatabase)('caption length is gated at schedule time', () => {
  let db: Db;
  const workspaceIds: string[] = [];

  async function makeBrand(): Promise<{ workspaceId: string; brandId: string }> {
    const workspaceId = randomUUID();
    await db.workspace.create({
      data: { id: workspaceId, slug: `cap-${workspaceId.slice(0, 8)}`, name: 'Caption gate' },
    });
    workspaceIds.push(workspaceId);

    const brandId = randomUUID();
    await db.brand.create({
      data: {
        id: brandId,
        workspaceId,
        name: 'Caption gate brand',
        slug: `cb-${brandId.slice(0, 8)}`,
        palette: {},
        typography: {},
        voiceGuide: {},
      },
    });
    return { workspaceId, brandId };
  }

  async function makeTarget(options: {
    platform: 'X' | 'THREADS' | 'INSTAGRAM' | 'FACEBOOK';
    baseCopy: string | null;
    caption?: string | null;
  }): Promise<{ workspaceId: string; brandId: string; targetId: string }> {
    const { workspaceId, brandId } = await makeBrand();

    const account = await db.socialAccount.create({
      data: {
        brandId,
        platform: options.platform,
        externalId: `ext-${randomUUID().slice(0, 8)}`,
        accessToken: 'fake-token',
        scopes: [],
        status: 'ACTIVE',
      },
    });

    const post = await db.post.create({
      data: { brandId, title: 'Caption gate', status: 'READY', baseCopy: options.baseCopy },
    });

    const target = await db.postTarget.create({
      data: {
        postId: post.id,
        platform: options.platform,
        socialAccountId: account.id,
        caption: options.caption ?? null,
        status: 'DRAFT',
      },
    });

    return { workspaceId, brandId, targetId: target.id };
  }

  function scopedFor(workspaceId: string, brandId: string) {
    return withTenantScope(db, { kind: 'brand', workspaceId, brandId });
  }

  const statusOf = async (targetId: string) =>
    (await db.postTarget.findUniqueOrThrow({ where: { id: targetId } })).status;

  const soon = () => new Date(Date.now() + 60 * 60 * 1000);

  beforeAll(() => {
    db = getPrisma();
  });

  afterAll(async () => {
    for (const id of workspaceIds) {
      await db.workspace.delete({ where: { id } }).catch(() => undefined);
    }
    await disconnectPrisma();
  });

  it('refuses to schedule an over-length caption, and leaves the row untouched', async () => {
    const { workspaceId, brandId, targetId } = await makeTarget({
      platform: 'THREADS',
      baseCopy: 'x'.repeat(600),
    });

    await expect(
      scheduleTargets(scopedFor(workspaceId, brandId), {
        targetIds: [targetId],
        scheduledFor: soon(),
      }),
    ).rejects.toThrow(/Threads/);

    // The status assertion is the one that matters. A gate that threw *after* the
    // `updateMany` would satisfy `rejects.toThrow` while having already scheduled the post.
    expect(await statusOf(targetId)).toBe('DRAFT');
  });

  it('schedules a caption that fits', async () => {
    // The positive control. Without it, a gate that rejected *everything* would pass the
    // test above and look correct.
    const { workspaceId, brandId, targetId } = await makeTarget({
      platform: 'THREADS',
      baseCopy: 'Short and well within five hundred bytes.',
    });

    await scheduleTargets(scopedFor(workspaceId, brandId), {
      targetIds: [targetId],
      scheduledFor: soon(),
    });

    expect(await statusOf(targetId)).toBe('SCHEDULED');
  });

  it('gates X on its own weighting, not on raw length', async () => {
    // The 314/233 case from `main`: a caption that is over 280 by `.length` but under it
    // once t.co's flat 23-character billing is applied. Pinned *in the gap*, so it fails
    // under a naive `.length` check and passes under the real one. A caption that is
    // simply over both limits proves nothing.
    const caption = `${'a'.repeat(210)} https://example.test/${'b'.repeat(80)}`;
    expect(caption.length).toBeGreaterThan(280);

    const { workspaceId, brandId, targetId } = await makeTarget({
      platform: 'X',
      baseCopy: caption,
    });

    await scheduleTargets(scopedFor(workspaceId, brandId), {
      targetIds: [targetId],
      scheduledFor: soon(),
    });

    expect(await statusOf(targetId)).toBe('SCHEDULED');
  });

  it('measures the per-target override rather than the base copy', async () => {
    // A target whose base copy fits and whose override does not. Gating the base copy
    // would schedule this happily and fail at publish time — the exact bug, one level down.
    const { workspaceId, brandId, targetId } = await makeTarget({
      platform: 'THREADS',
      baseCopy: 'This base copy is short.',
      caption: 'y'.repeat(600),
    });

    await expect(
      scheduleTargets(scopedFor(workspaceId, brandId), {
        targetIds: [targetId],
        scheduledFor: soon(),
      }),
    ).rejects.toThrow(/Threads/);
    expect(await statusOf(targetId)).toBe('DRAFT');
  });

  it('inherits the base copy when the override is null', async () => {
    const { workspaceId, brandId, targetId } = await makeTarget({
      platform: 'THREADS',
      baseCopy: 'z'.repeat(600),
      caption: null,
    });

    await expect(
      scheduleTargets(scopedFor(workspaceId, brandId), {
        targetIds: [targetId],
        scheduledFor: soon(),
      }),
    ).rejects.toThrow(/Threads/);
  });

  it('rejects the whole batch when one target of several is over', async () => {
    // Deliberate: partially scheduling a multi-platform post means the user believes it
    // went out everywhere. Better to refuse the batch and name the platform at fault.
    const { workspaceId, brandId } = await makeBrand();

    const mk = async (platform: 'X' | 'THREADS', copy: string) => {
      const account = await db.socialAccount.create({
        data: {
          brandId,
          platform,
          externalId: `ext-${randomUUID().slice(0, 8)}`,
          accessToken: 'fake-token',
          scopes: [],
          status: 'ACTIVE',
        },
      });
      const post = await db.post.create({
        data: { brandId, title: 'Batch', status: 'READY', baseCopy: copy },
      });
      const target = await db.postTarget.create({
        data: {
          postId: post.id,
          platform,
          socialAccountId: account.id,
          status: 'DRAFT',
        },
      });
      return target.id;
    };

    const fine = await mk('X', 'Perfectly fine.');
    const over = await mk('THREADS', 'q'.repeat(600));

    await expect(
      scheduleTargets(scopedFor(workspaceId, brandId), {
        targetIds: [fine, over],
        scheduledFor: soon(),
      }),
    ).rejects.toThrow(/Threads/);

    expect(await statusOf(fine)).toBe('DRAFT');
    expect(await statusOf(over)).toBe('DRAFT');
  });
});
