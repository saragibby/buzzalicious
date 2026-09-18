import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/http/app';
import { disconnectPrisma, getPrisma, type Db } from '../../src/platform/db';
import {
  getOrCreateShortLink,
  resolveSlug,
  shortLinkLength,
} from '../../src/modules/link/shortlink.service';
import { recordClick } from '../../src/modules/link/click.service';
import { hasTestDatabase } from '../env';

/**
 * The redirector and click ingest, against a real database.
 *
 * Grouped here because every assertion needs a real row: the redirect reads one, the
 * ingest writes one, and the properties that matter (the 302, the absence of an address,
 * the per-platform uniqueness) are only observable end to end.
 */
describe.skipIf(!hasTestDatabase)('short links and click ingest', () => {
  let db: Db;
  let app: ReturnType<typeof createApp>;

  /**
   * A real, routable-looking address used as a tracer.
   *
   * Everything that could leak an address is checked against this exact string. It is
   * from TEST-NET-3 (RFC 5737), so it can never collide with anything incidental.
   */
  const SENTINEL_IP = '203.0.113.201';

  const BROWSER_UA =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  interface Tenant {
    workspaceId: string;
    brandId: string;
    postId: string;
  }

  /**
   * Every workspace this file creates, so `afterAll` can remove them.
   *
   * Cleaning up is not politeness here. Several other suites reach for a brand with an
   * unfiltered `findFirstOrThrow()`, so rows left behind by this file become *their*
   * fixture and fail them with an error that points nowhere near the cause. Leaving the
   * database as we found it is what keeps those failures honest.
   */
  const createdWorkspaceIds: string[] = [];

  async function makeTenant(name: string): Promise<Tenant> {
    const workspaceId = randomUUID();
    const brandId = randomUUID();
    createdWorkspaceIds.push(workspaceId);

    await db.workspace.create({
      data: { id: workspaceId, slug: `w7-${name}-${workspaceId.slice(0, 8)}`, name },
    });
    await db.brand.create({
      data: {
        id: brandId,
        workspaceId,
        name: `${name} brand`,
        slug: `b-${brandId.slice(0, 8)}`,
        palette: {},
        typography: {},
        voiceGuide: {},
      },
    });
    const post = await db.post.create({
      data: { brandId, title: `${name} post`, status: 'READY' },
    });

    return { workspaceId, brandId, postId: post.id };
  }

  async function makeLink(tenant: Tenant, overrides: Record<string, unknown> = {}) {
    return db.shortLink.create({
      data: {
        slug: randomUUID().replace(/-/g, '').slice(0, 7),
        brandId: tenant.brandId,
        postId: tenant.postId,
        platform: 'X',
        destinationUrl: 'https://example.test/landing',
        ...overrides,
      },
    });
  }

  /** Wait for the post-response click write to land. */
  async function clicksFor(shortLinkId: string, expected: number) {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const rows = await db.linkClick.findMany({
        where: { shortLinkId },
        orderBy: { occurredAt: 'asc' },
      });
      if (rows.length >= expected) return rows;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return db.linkClick.findMany({ where: { shortLinkId }, orderBy: { occurredAt: 'asc' } });
  }

  beforeAll(() => {
    db = getPrisma();
    app = createApp();
  });

  afterAll(async () => {
    // The workspace cascade takes brands, posts, targets, short links and clicks with it.
    for (const workspaceId of createdWorkspaceIds) {
      await db.workspace.deleteMany({ where: { id: workspaceId } });
    }
    await disconnectPrisma();
  });

  describe('the redirect itself', () => {
    /**
     * The single most consequential line in this workstream.
     *
     * A 301 is cached by the browser, so every click after the first would bypass us
     * entirely and never be recorded. The visitor still lands correctly, so nothing looks
     * broken — the numbers just quietly stop counting, and it would surface months later
     * as traffic that inexplicably decayed.
     */
    it('redirects with 302 and forbids caching', async () => {
      const tenant = await makeTenant('redirect');
      const link = await makeLink(tenant);

      const response = await request(app).get(`/s/${link.slug}`).set('user-agent', BROWSER_UA);

      expect(response.status).toBe(302);
      expect(response.status).not.toBe(301);
      expect(response.headers.location).toBe('https://example.test/landing');
      expect(response.headers['cache-control']).toContain('no-store');
    });

    it('404s an unknown slug', async () => {
      const response = await request(app).get('/s/zzzzzzz').set('user-agent', BROWSER_UA);
      expect(response.status).toBe(404);
    });

    it('404s a malformed slug without touching the database', async () => {
      // The outcome (404) is identical either way, so asserting only the status would
      // pass with the shape check removed — a mutation run proved exactly that. What the
      // check actually buys is refusing a scan *before* a database round-trip, on a
      // public unauthenticated endpoint. So that is what this asserts.
      //
      // Wrapped by hand rather than with `vi.spyOn`, because Prisma's delegate methods
      // are not own properties: `mockRestore()` *deletes* the method instead of putting
      // it back, which breaks the client for every later test in the file.
      const original = db.shortLink.findUnique;
      const calls: unknown[] = [];
      (db.shortLink as any).findUnique = (...args: unknown[]) => {
        calls.push(args);
        return (original as any).apply(db.shortLink, args);
      };

      try {
        const response = await request(app).get('/s/not%2Fa%2Fslug').set('user-agent', BROWSER_UA);

        expect(response.status).toBe(404);
        expect(calls).toHaveLength(0);

        // Positive control: the wrapper is on the client the route really uses, so
        // "not called" above means the query was skipped rather than that this was
        // watching the wrong object.
        const tenant = await makeTenant('probe-control');
        const link = await makeLink(tenant);
        await request(app).get(`/s/${link.slug}`).set('user-agent', BROWSER_UA);
        expect(calls.length).toBeGreaterThan(0);
      } finally {
        (db.shortLink as any).findUnique = original;
      }
    });

    /**
     * 410 rather than 404 is the whole reason `expiresAt` is distinguishable from a
     * missing row: the link was real, and it is over.
     */
    it('410s an expired link', async () => {
      const tenant = await makeTenant('expired');
      const link = await makeLink(tenant, { expiresAt: new Date(Date.now() - 60_000) });

      const response = await request(app).get(`/s/${link.slug}`).set('user-agent', BROWSER_UA);

      expect(response.status).toBe(410);
      expect(response.headers.location).toBeUndefined();
    });

    it('still redirects a link whose expiry is in the future', async () => {
      const tenant = await makeTenant('not-yet-expired');
      const link = await makeLink(tenant, { expiresAt: new Date(Date.now() + 600_000) });

      const response = await request(app).get(`/s/${link.slug}`).set('user-agent', BROWSER_UA);

      expect(response.status).toBe(302);
    });

    /**
     * Our own domain must never become an open redirect. `assertSafeDestination` blocks
     * this at write time; this proves the read-time check catches a row that got past it
     * — which is the case that actually matters, since the write-time check cannot
     * retroactively clean rows written before it existed.
     */
    it('refuses to redirect to a non-http destination', async () => {
      const tenant = await makeTenant('open-redirect');
      // Written directly, bypassing the service, to simulate exactly that history.
      const link = await makeLink(tenant, {
        destinationUrl: 'javascript:alert(document.cookie)',
      });

      const response = await request(app).get(`/s/${link.slug}`).set('user-agent', BROWSER_UA);

      expect(response.status).toBe(404);
      expect(response.headers.location).toBeUndefined();
    });
  });

  describe('click ingest', () => {
    it('records a genuine click as not-a-bot', async () => {
      const tenant = await makeTenant('human-click');
      const link = await makeLink(tenant);

      await request(app)
        .get(`/s/${link.slug}`)
        .set('user-agent', BROWSER_UA)
        .set('accept', 'text/html')
        .set('referer', 'https://x.com/someone/status/1')
        .set('cf-ipcountry', 'gb');

      const [click] = await clicksFor(link.id, 1);

      expect(click).toBeDefined();
      expect(click!.isBot).toBe(false);
      expect(click!.botReason).toBeNull();
      expect(click!.country).toBe('GB');
      expect(click!.referrer).toBe('https://x.com/someone/status/1');
      expect(click!.deviceType).toBe('desktop');
    });

    /**
     * The load-bearing one. Unfiltered, these outnumber real readers on a fresh post and
     * the recommender learns that unread posts were the successful ones.
     *
     * Flagged, never dropped — so the row must still exist.
     */
    it('flags a link-preview crawler but still stores the row', async () => {
      const tenant = await makeTenant('crawler-click');
      const link = await makeLink(tenant);

      await request(app)
        .get(`/s/${link.slug}`)
        .set(
          'user-agent',
          'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
        )
        .set('accept', 'text/html');

      const [click] = await clicksFor(link.id, 1);

      expect(click).toBeDefined();
      expect(click!.isBot).toBe(true);
      expect(click!.botReason).toBe('ua-crawler');
    });

    it('flags a HEAD request and still serves the redirect', async () => {
      const tenant = await makeTenant('head-click');
      const link = await makeLink(tenant);

      const response = await request(app).head(`/s/${link.slug}`).set('user-agent', BROWSER_UA);
      expect(response.status).toBe(302);

      const [click] = await clicksFor(link.id, 1);
      expect(click!.isBot).toBe(true);
      expect(click!.botReason).toBe('head-request');
    });

    /**
     * Deduplication has to be able to tell two people apart, so this asserts the *second*
     * click is flagged while the first is not — not merely that "a duplicate exists".
     */
    it('flags a repeat click from the same pseudonym within the window', async () => {
      const tenant = await makeTenant('dupe-click');
      const link = await makeLink(tenant);

      for (let i = 0; i < 2; i += 1) {
        await request(app)
          .get(`/s/${link.slug}`)
          .set('user-agent', BROWSER_UA)
          .set('accept', 'text/html')
          .set('x-forwarded-for', SENTINEL_IP);
      }

      const clicks = await clicksFor(link.id, 2);

      expect(clicks).toHaveLength(2);
      expect(clicks[0]!.isBot).toBe(false);
      expect(clicks[1]!.isBot).toBe(true);
      expect(clicks[1]!.botReason).toBe('duplicate');
    });

    /**
     * A null pseudonym is not an identity.
     *
     * `isDuplicate` returns early on a null `ipHash`, and a mutation run showed nothing
     * was holding that: every other test here sends an address, so the null path was
     * never exercised. Without the guard, `where: { ipHash: null }` matches every other
     * address-less click and collapses all of them into one visitor — so the first
     * request is counted and every subsequent one is discarded as a repeat.
     *
     * Driven through `recordClick` rather than HTTP because a real socket always has an
     * address; `req.ip` is only undefined in the edge cases this guard exists for.
     */
    it('does not treat two address-less clicks as the same person', async () => {
      const tenant = await makeTenant('null-ip');
      const link = await makeLink(tenant);
      const resolved = await resolveSlug(link.slug);

      for (let i = 0; i < 2; i += 1) {
        await recordClick(resolved!, {
          method: 'GET',
          ip: undefined,
          headers: { 'user-agent': BROWSER_UA, accept: 'text/html' },
        });
      }

      const clicks = await clicksFor(link.id, 2);

      expect(clicks).toHaveLength(2);
      expect(clicks.map((click) => click.ipHash)).toEqual([null, null]);
      // Neither is a duplicate of the other: they are two unknown people, not one.
      expect(clicks.map((click) => click.botReason)).toEqual([null, null]);
      expect(clicks.every((click) => click.isBot === false)).toBe(true);
    });
  });

  describe('the privacy acceptance criterion', () => {
    /**
     * **No raw IP address is stored, anywhere.**
     *
     * This does not inspect the columns it expects to be clean — it serialises the entire
     * row and searches it. A future migration that adds a well-meaning `ipAddress` column
     * would go red here without anyone remembering to update this test, which is the
     * whole point: the assertion is about the row, not about the fields I happened to
     * think of.
     *
     * The positive control comes first. Without it, a test that never reached the ingest
     * at all would find no address and pass — the exact "didn't happen versus didn't run"
     * confusion docs/12 warns about.
     */
    it('never stores the raw address in any column', async () => {
      const tenant = await makeTenant('privacy');
      const link = await makeLink(tenant);

      await request(app)
        .get(`/s/${link.slug}`)
        .set('user-agent', BROWSER_UA)
        .set('accept', 'text/html')
        .set('x-forwarded-for', SENTINEL_IP);

      const [click] = await clicksFor(link.id, 1);

      // Positive control: the ingest genuinely ran and genuinely saw this request.
      expect(click).toBeDefined();
      expect(click!.userAgent).toBe(BROWSER_UA);

      // And it produced a pseudonym, so an address *was* observed and processed rather
      // than silently never arriving.
      expect(click!.ipHash).toMatch(/^[0-9a-f]{64}$/);

      const serialised = JSON.stringify(click);
      expect(serialised).not.toContain(SENTINEL_IP);
      // Also no partial: an octet-truncated address is still an address.
      expect(serialised).not.toContain('203.0.113');
    });

    /**
     * The same guarantee at the table level rather than the row level. If any code path
     * anywhere in the ingest wrote an address into any column of any click, this finds it.
     */
    it('has no raw address anywhere in the click table', async () => {
      const tenant = await makeTenant('privacy-table');
      const link = await makeLink(tenant);

      await request(app)
        .get(`/s/${link.slug}`)
        .set('user-agent', BROWSER_UA)
        .set('accept', 'text/html')
        .set('x-forwarded-for', SENTINEL_IP);

      await clicksFor(link.id, 1);

      const everything = await db.linkClick.findMany({ where: { shortLinkId: link.id } });
      expect(everything.length).toBeGreaterThan(0);
      expect(JSON.stringify(everything)).not.toContain(SENTINEL_IP);
    });
  });

  describe('one short link per (post, platform)', () => {
    /**
     * This invariant *is* the per-platform attribution mechanism. A second row for one
     * pairing splits the post's click stream and under-reports both halves.
     */
    it('returns the same link for a repeated request', async () => {
      const tenant = await makeTenant('get-or-create');

      const first = await getOrCreateShortLink({
        brandId: tenant.brandId,
        postId: tenant.postId,
        platform: 'X',
        destinationUrl: 'https://example.test/a',
      });
      const second = await getOrCreateShortLink({
        brandId: tenant.brandId,
        postId: tenant.postId,
        platform: 'X',
        destinationUrl: 'https://example.test/a',
      });

      expect(second.id).toBe(first.id);
      expect(second.slug).toBe(first.slug);
    });

    /**
     * The race is real: pg-boss is at-least-once, so the publish path and a retry reach
     * this concurrently. Asserting on the set of distinct ids rather than on a count,
     * because one row created twice and two rows created once both give "2 results".
     */
    it('creates exactly one row under concurrent callers', async () => {
      const tenant = await makeTenant('race');

      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          getOrCreateShortLink({
            brandId: tenant.brandId,
            postId: tenant.postId,
            platform: 'X',
            destinationUrl: 'https://example.test/race',
          }),
        ),
      );

      const distinctIds = new Set(results.map((row) => row.id));
      expect(distinctIds.size).toBe(1);

      const stored = await db.shortLink.findMany({
        where: { postId: tenant.postId, platform: 'X' },
      });
      expect(stored).toHaveLength(1);
    });

    it('gives each platform its own link, which is what makes attribution per-platform', async () => {
      const tenant = await makeTenant('per-platform');

      const x = await getOrCreateShortLink({
        brandId: tenant.brandId,
        postId: tenant.postId,
        platform: 'X',
        destinationUrl: 'https://example.test/same',
      });
      const threads = await getOrCreateShortLink({
        brandId: tenant.brandId,
        postId: tenant.postId,
        platform: 'THREADS',
        destinationUrl: 'https://example.test/same',
      });

      expect(threads.id).not.toBe(x.id);
      expect(threads.slug).not.toBe(x.slug);
    });

    it('refuses to create a link to a non-http destination', async () => {
      const tenant = await makeTenant('unsafe-create');

      await expect(
        getOrCreateShortLink({
          brandId: tenant.brandId,
          postId: tenant.postId,
          platform: 'X',
          destinationUrl: 'javascript:alert(1)',
        }),
      ).rejects.toThrow(/http or https/i);

      const stored = await db.shortLink.findMany({ where: { postId: tenant.postId } });
      expect(stored).toHaveLength(0);
    });
  });

  describe('resolveSlug', () => {
    /**
     * `ShortLink.postId` is nullable with `onDelete: SetNull`, so an orphaned link is a
     * shape that genuinely occurs — a deleted post leaves its links behind. Every consumer
     * needs a fixture for it, and this is where the redirector's version lives.
     */
    it('resolves a link whose post has been detached', async () => {
      const tenant = await makeTenant('orphan');
      const link = await makeLink(tenant, { postId: null, platform: null });

      const resolved = await resolveSlug(link.slug);

      expect(resolved).not.toBeNull();
      expect(resolved!.postId).toBeNull();
      expect(resolved!.publishedAt).toBeNull();

      const response = await request(app).get(`/s/${link.slug}`).set('user-agent', BROWSER_UA);
      expect(response.status).toBe(302);
    });

    it('reads publishedAt from the matching platform target, not another platform', async () => {
      const tenant = await makeTenant('published-at');
      const xPublished = new Date('2026-01-02T03:04:05.000Z');

      await db.postTarget.create({
        data: {
          postId: tenant.postId,
          platform: 'X',
          status: 'PUBLISHED',
          publishedAt: xPublished,
        },
      });
      // A different platform, published at a very different time. If the lookup ignored
      // the platform it could pick this one up.
      await db.postTarget.create({
        data: {
          postId: tenant.postId,
          platform: 'THREADS',
          status: 'PUBLISHED',
          publishedAt: new Date('2026-06-06T06:06:06.000Z'),
        },
      });

      const link = await makeLink(tenant, { platform: 'X' });
      const resolved = await resolveSlug(link.slug);

      expect(resolved!.publishedAt?.toISOString()).toBe(xPublished.toISOString());
    });

    it('returns null for an unknown slug', async () => {
      expect(await resolveSlug('qqqqqqq')).toBeNull();
    });
  });

  describe('shortLinkLength', () => {
    /**
     * The number the caption gate trusts. If it disagreed with reality by even one
     * character, a caption could pass the composer and be rejected at publish — the exact
     * class of bug this project has already shipped once.
     */
    it('matches the real length of a real link', async () => {
      const tenant = await makeTenant('length');
      const link = await getOrCreateShortLink({
        brandId: tenant.brandId,
        postId: tenant.postId,
        platform: 'X',
        destinationUrl: 'https://example.test/length',
      });

      const actual = `${process.env.APP_URL}/s/${link.slug}`;
      expect(actual.length).toBe(shortLinkLength());
    });
  });
});
