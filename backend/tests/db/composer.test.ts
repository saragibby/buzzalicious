import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { brandId as seedBrandId, userId, workspaceId } from '../../prisma/seed/workspaces';
import { createApp } from '../../src/http/app';
import { requireBrandAccess } from '../../src/modules/identity/authorization';
import {
  createDraft,
  deleteDraft,
  draftReadiness,
  getDraft,
  listDrafts,
  updateDraft,
} from '../../src/modules/post/post.service';
import { streamExportBundle } from '../../src/modules/post/export.service';
import { disconnectPrisma, getPrisma, type Db } from '../../src/platform/db';
import { NotFoundError, ValidationError } from '../../src/platform/errors';
import type { ScopedDb } from '../../src/platform/tenancy';
import { hasTestDatabase } from '../env';

/** Which seeded user the HTTP tests below are signed in as. Hoisted for `vi.mock`. */
const auth = vi.hoisted(() => ({ userId: '' }));

vi.mock('../../src/http/middleware/require-auth', () => ({
  requireAuth: (req: { user?: { id: string; email: string } }, _res: unknown, next: () => void) => {
    req.user = { id: auth.userId, email: 'composer@buzzalicious.test' };
    next();
  },
}));

/**
 * The composer's backend, against a real database.
 *
 * Runs on W2's seed, applied once by `tests/global-setup.ts` — do not seed here and do not
 * assume a file ordering. Vitest orders files by size, so an ordering assumption passes on
 * one machine and fails on another.
 *
 * Two boundaries matter enough to be asserted rather than assumed:
 *
 *  - **tenancy.** A draft in another workspace must read as *not found*, never as an empty
 *    result. An empty result is also what a broken filter returns, so asserting absence
 *    proves nothing.
 *  - **the wire.** The export response is binary and the draft response contains dates.
 *    Both are asserted against the real HTTP body, because a serialization failure happens
 *    *after* the handler succeeds — a `status === 200` assertion sails straight past it.
 */

const RISE = {
  workspaceId: workspaceId('rise-and-shore'),
  brandId: seedBrandId('rise-and-shore'),
  ownerId: userId('owner@riseandshore.example'),
};

const TAXDEDUX = {
  brandId: seedBrandId('taxdedux'),
  ownerId: userId('owner@taxdedux.example'),
};

/** Collects a stream into one Buffer, so the zip can be inspected rather than trusted. */
class BufferSink extends Writable {
  readonly chunks: Buffer[] = [];

  _write(chunk: Buffer, _encoding: string, callback: () => void): void {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }

  get buffer(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

describe.skipIf(!hasTestDatabase)('composer backend', () => {
  let db: Db;
  let rise: ScopedDb;
  let taxdedux: ScopedDb;

  beforeAll(async () => {
    db = getPrisma();
    rise = (await requireBrandAccess(RISE.ownerId, RISE.brandId)).db;
    taxdedux = (await requireBrandAccess(TAXDEDUX.ownerId, TAXDEDUX.brandId)).db;
  }, 120_000);

  afterAll(async () => {
    await disconnectPrisma();
  });

  describe('drafts', () => {
    it('pins the template version at creation', async () => {
      // Performance is attributed to a template version (docs/05). A draft that silently
      // adopted a newer layout would be compared against posts that rendered differently.
      const template = await db.template.findFirstOrThrow({
        where: { slug: 'big-number' },
        select: { version: true },
      });

      const draft = await createDraft(rise, RISE.brandId, { templateSlug: 'big-number' });

      expect(draft.templateVersion).toBe(template.version);
      expect(draft.templateSlug).toBe('big-number');

      await deleteDraft(rise, draft.id);
    });

    it('seeds targets from the brand’s chosen platforms', async () => {
      const brand = await db.brand.findUniqueOrThrow({
        where: { id: RISE.brandId },
        select: { targetPlatforms: true },
      });

      const draft = await createDraft(rise, RISE.brandId, { templateSlug: 'big-number' });

      expect(draft.targets.map((target) => target.platform).sort()).toEqual(
        [...brand.targetPlatforms].sort(),
      );

      await deleteDraft(rise, draft.id);
    });

    it('refuses a caption over the platform’s limit, counted that platform’s way', async () => {
      const draft = await createDraft(rise, RISE.brandId, { templateSlug: 'big-number' });

      // 141 CJK characters is 141 by String.length and 282 by X's weighting. A naive
      // length check accepts this and X rejects the post.
      await expect(
        updateDraft(rise, draft.id, {
          platforms: ['X'],
          captionOverrides: { X: 'あ'.repeat(141) },
        }),
      ).rejects.toBeInstanceOf(ValidationError);

      // The same number of plain characters is comfortably inside the limit, which is what
      // makes the weighting the thing being tested rather than the count.
      await expect(
        updateDraft(rise, draft.id, { captionOverrides: { X: 'a'.repeat(141) } }),
      ).resolves.toBeTruthy();

      await deleteDraft(rise, draft.id);
    });

    it('keeps an emptied caption empty instead of inheriting the base again', async () => {
      const draft = await createDraft(rise, RISE.brandId, { templateSlug: 'big-number' });

      await updateDraft(rise, draft.id, {
        platforms: ['X'],
        baseCopy: 'the shared caption',
        captionOverrides: { X: '' },
      });

      const reread = await getDraft(rise, draft.id);
      const target = reread.targets.find((candidate) => candidate.platform === 'X');

      // `''` is a deliberate clearing; `null` is inheritance. Collapsing them republishes
      // copy someone removed on purpose.
      expect(target?.caption).toBe('');
      expect(target?.caption).not.toBeNull();

      await deleteDraft(rise, draft.id);
    });

    it('drops targets the user unticks', async () => {
      const draft = await createDraft(rise, RISE.brandId, { templateSlug: 'big-number' });

      const updated = await updateDraft(rise, draft.id, { platforms: ['THREADS'] });

      expect(updated.targets.map((target) => target.platform)).toEqual(['THREADS']);

      await deleteDraft(rise, draft.id);
    });

    it('reports what is missing rather than refusing to save it', async () => {
      const draft = await createDraft(rise, RISE.brandId, { templateSlug: 'big-number' });

      const readiness = await draftReadiness(rise, draft.id);

      // Saving a half-typed post must work; exporting one must not. Readiness is how the
      // composer greys out Export and says why while the user is still typing.
      expect(readiness.ready).toBe(false);
      expect(readiness.issues.length).toBeGreaterThan(0);

      await deleteDraft(rise, draft.id);
    });

    it('hides a soft-deleted draft from the list and from reads', async () => {
      const draft = await createDraft(rise, RISE.brandId, { templateSlug: 'big-number' });
      await deleteDraft(rise, draft.id);

      const listed = await listDrafts(rise);
      expect(listed.map((item) => item.id)).not.toContain(draft.id);

      await expect(getDraft(rise, draft.id)).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('tenancy', () => {
    it('reports another workspace’s draft as not found, not as an empty result', async () => {
      const draft = await createDraft(rise, RISE.brandId, { templateSlug: 'big-number' });

      // A thrown NotFoundError and an empty list are indistinguishable from the caller's
      // side, and in production the difference is whether another client's post is
      // readable. So this asserts the throw.
      await expect(getDraft(taxdedux, draft.id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(updateDraft(taxdedux, draft.id, { title: 'stolen' })).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await expect(deleteDraft(taxdedux, draft.id)).rejects.toBeInstanceOf(NotFoundError);

      // Positive control: without it, the denials above could pass because the fixture is
      // broken rather than because the boundary works.
      await expect(getDraft(rise, draft.id)).resolves.toMatchObject({ id: draft.id });

      await deleteDraft(rise, draft.id);
    });

    it('does not leak another workspace’s drafts into a list', async () => {
      const draft = await createDraft(rise, RISE.brandId, { templateSlug: 'big-number' });

      const theirs = await listDrafts(taxdedux);
      expect(theirs.map((item) => item.id)).not.toContain(draft.id);

      const ours = await listDrafts(rise);
      expect(ours.map((item) => item.id)).toContain(draft.id);

      await deleteDraft(rise, draft.id);
    });
  });

  describe('export', () => {
    it('produces a zip containing a PNG per ratio, the captions and a readme', async () => {
      const draft = await createDraft(rise, RISE.brandId, {
        templateSlug: 'big-number',
        title: 'Guests who rebook',
      });

      await updateDraft(rise, draft.id, {
        slotValues: { stat: '68%', context: 'of guests book again within the year.' },
        baseCopy: 'Most of our guests come back.',
        platforms: ['INSTAGRAM'],
      });

      const sink = new BufferSink();
      const summary = await streamExportBundle(rise, db, draft.id, sink, {
        aspectRatios: ['SQUARE_1_1'],
      });

      const zip = sink.buffer;

      // A real zip, not an empty stream that resolved. `PK\x03\x04` is the local file
      // header every zip starts with.
      expect(zip.subarray(0, 4).toString('latin1')).toBe('PK\u0003\u0004');

      // Filenames live in the central directory as plain bytes, so they are findable
      // without unzipping — enough to prove the entries exist and are named for humans.
      const raw = zip.toString('latin1');
      expect(raw).toContain('square-1x1.png');
      expect(raw).toContain('captions.txt');
      expect(raw).toContain('README.txt');

      expect(summary.renditions).toHaveLength(1);
      expect(summary.renditions[0]).toMatchObject({ width: 1080, height: 1080 });
      expect(summary.filename).toBe('guests-who-rebook-buzzalicious.zip');

      await deleteDraft(rise, draft.id);
    }, 60_000);

    it('refuses to export an unfinished post, and says what is missing', async () => {
      const draft = await createDraft(rise, RISE.brandId, { templateSlug: 'big-number' });

      const sink = new BufferSink();

      // Refused *before* anything is written. A partially-written zip that looks like a
      // successful download is worse than an error.
      await expect(streamExportBundle(rise, db, draft.id, sink)).rejects.toBeInstanceOf(
        ValidationError,
      );
      expect(sink.buffer).toHaveLength(0);

      await deleteDraft(rise, draft.id);
    });

    it('will not export another workspace’s post', async () => {
      const draft = await createDraft(rise, RISE.brandId, { templateSlug: 'big-number' });
      const sink = new BufferSink();

      // The scope check runs before the unscoped client reaches renderPost, which is the
      // whole reason `streamExportBundle` takes both clients.
      await expect(streamExportBundle(taxdedux, db, draft.id, sink)).rejects.toBeInstanceOf(
        NotFoundError,
      );
      expect(sink.buffer).toHaveLength(0);

      await deleteDraft(rise, draft.id);
    });
  });

  describe('over HTTP', () => {
    /**
     * Only the authentication middleware is replaced, and only to choose *which* seeded
     * user is signed in — the same seam `usage-admin-serialization.test.ts` uses. Tenancy,
     * the read layer and Express's own `res.json` are all real, which is the point: the
     * risks here are serialization and scoping, and neither is exercised by a fake.
     */
    async function signedIn(userId: string) {
      auth.userId = userId;
      return request(createApp());
    }

    it('serialises a draft without throwing during JSON encoding', async () => {
      const client = await signedIn(RISE.ownerId);

      const created = await client
        .post(`/api/brands/${RISE.brandId}/posts`)
        .send({ templateSlug: 'big-number' })
        .expect(201);

      // Asserted on the actual body, not on the service return value: a BigInt or Decimal
      // throws during `JSON.stringify`, which happens after the handler has already
      // succeeded — a status assertion alone would never see it.
      expect(created.body.draft).toMatchObject({ templateSlug: 'big-number' });
      expect(typeof created.body.draft.updatedAt).toBe('string');

      const read = await client
        .get(`/api/brands/${RISE.brandId}/posts/${created.body.draft.id}`)
        .expect(200);

      expect(read.body.readiness).toMatchObject({ ready: false });

      await client.delete(`/api/brands/${RISE.brandId}/posts/${created.body.draft.id}`).expect(204);
    });

    it('answers 404 for a draft in another workspace', async () => {
      const created = await (
        await signedIn(RISE.ownerId)
      )
        .post(`/api/brands/${RISE.brandId}/posts`)
        .send({ templateSlug: 'big-number' })
        .expect(201);

      const postId = created.body.draft.id;

      // 404 rather than 403, deliberately: a 403 confirms the id exists and turns any
      // brand id into an enumeration oracle. Signing in is re-asserted before each
      // request because the mocked session is process-wide, not per-agent.
      await (
        await signedIn(TAXDEDUX.ownerId)
      )
        .get(`/api/brands/${TAXDEDUX.brandId}/posts/${postId}`)
        .expect(404);

      await (
        await signedIn(RISE.ownerId)
      )
        .delete(`/api/brands/${RISE.brandId}/posts/${postId}`)
        .expect(204);
    });

    it('returns a JSON error, not zip bytes, when the post is not ready', async () => {
      const client = await signedIn(RISE.ownerId);
      const created = await client
        .post(`/api/brands/${RISE.brandId}/posts`)
        .send({ templateSlug: 'big-number' })
        .expect(201);

      const response = await client
        .post(`/api/brands/${RISE.brandId}/posts/${created.body.draft.id}/export`)
        .send({})
        .expect(400);

      // The headers are set inside `onBeforeStream` precisely so this case is still a
      // readable error rather than a corrupt download.
      expect(response.headers['content-type']).toMatch(/json/);
      expect(response.body.error.message).toMatch(/not ready/i);

      await client.delete(`/api/brands/${RISE.brandId}/posts/${created.body.draft.id}`).expect(204);
    });

    it('serves the platform spec table the composer counts against', async () => {
      const client = await signedIn(RISE.ownerId);
      const response = await client.get('/api/platforms').expect(200);

      const instagram = response.body.platforms.find(
        (spec: { platform: string }) => spec.platform === 'INSTAGRAM',
      );

      // The frontend must not hard-code a limit. This is the endpoint that makes that
      // possible, so the field has to survive the wire.
      expect(instagram).toMatchObject({
        captionMaxLength: 2200,
        captionCountUnit: 'codepoints',
        linkBehavior: 'bio-only',
      });
    });
  });

  describe('AI safety', () => {
    it('never reaches a provider from this suite', async () => {
      // The suite was recently making live billable OpenAI calls because a test restored
      // real credentials. `tests/env.ts` forces fakes; this asserts the consequence rather
      // than trusting it, because the hole was invisible until the bill arrived.
      expect(process.env.OPENAI_API_KEY ?? '').not.toMatch(/^sk-[A-Za-z0-9]{20,}$/);

      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      const draft = await createDraft(rise, RISE.brandId, { templateSlug: 'big-number' });
      await updateDraft(rise, draft.id, { slotValues: { stat: '68%' } });

      // With a fake key the provider call fails; what matters is that nothing left the
      // machine for a real endpoint.
      const { generateCaption } = await import('../../src/modules/post/caption.service');
      await generateCaption(rise, draft.id, {}).catch(() => undefined);

      for (const call of fetchSpy.mock.calls) {
        const url = String(call[0]);
        expect(url).not.toMatch(/api\.openai\.com|api\.anthropic\.com/);
      }

      fetchSpy.mockRestore();
      await deleteDraft(rise, draft.id);
    });
  });
});
