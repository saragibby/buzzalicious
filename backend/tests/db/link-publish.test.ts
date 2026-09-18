import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectPrisma, getPrisma, type Db } from '../../src/platform/db';
import { publishTarget } from '../../src/modules/publish/publish.service';
import type { AdapterRegistry } from '../../src/modules/publish/adapter.registry';
import type { PlatformAdapter, PublishInput } from '../../src/modules/publish/adapter.types';
import { X_SPEC } from '../../src/modules/publish/x/x.adapter';
import { shortLinkUrl } from '../../src/modules/link/shortlink.service';
import { isValidSlug } from '../../src/modules/link/slug';
import { LINK_MARKER } from '../../src/modules/post/post.schemas';
import { hasTestDatabase } from '../env';

/**
 * What the platform actually receives.
 *
 * Every assertion in this file reads the caption **captured from the adapter call**,
 * never a string this file recomputed. A test that rebuilt the expected caption with the
 * same helper the code uses would be a tautology: it would agree with the implementation
 * whatever the implementation did, including doing nothing. The captured value is the
 * only evidence that injection actually ran.
 */

/** Records every publish input. No test here may reach a social platform. */
function capturingRegistry(): { registry: AdapterRegistry; inputs: PublishInput[] } {
  const inputs: PublishInput[] = [];

  const make = (platform: string): PlatformAdapter =>
    ({
      platform,
      specs: X_SPEC,
      getAuthUrl: async () => 'https://example.test/auth',
      connect: async () => [],
      refresh: async (_c: unknown, a: { tokens: unknown }) => a.tokens,
      validate: async () => ({ status: 'ACTIVE' as const, checkedAt: new Date() }),
      introspect: async () => ({
        status: 'ACTIVE' as const,
        grantedScopes: [],
        capabilities: {},
        summary: 'ok',
        checkedAt: new Date(),
      }),
      publish: async (_credential: unknown, input: PublishInput) => {
        inputs.push(input);
        return {
          externalPostId: `ext-${randomUUID()}`,
          externalUrl: 'https://example.test/p/1',
          publishedAt: new Date(),
        };
      },
      fetchMetrics: async () => ({ collectedAt: new Date() }),
    }) as unknown as PlatformAdapter;

  return {
    registry: {
      X: make('X'),
      FACEBOOK: make('FACEBOOK'),
      INSTAGRAM: make('INSTAGRAM'),
      THREADS: make('THREADS'),
    } as unknown as AdapterRegistry,
    inputs,
  };
}

describe.skipIf(!hasTestDatabase)('link injection at publish', () => {
  let db: Db;
  const workspaceIds: string[] = [];

  async function makeBrand(website: string | null): Promise<{
    workspaceId: string;
    brandId: string;
    accountIds: Record<string, string>;
  }> {
    const workspaceId = randomUUID();
    const brandId = randomUUID();

    await db.workspace.create({
      data: { id: workspaceId, slug: `lnk-${workspaceId.slice(0, 8)}`, name: 'Link tests' },
    });
    workspaceIds.push(workspaceId);

    await db.brand.create({
      data: {
        id: brandId,
        workspaceId,
        name: 'Link brand',
        slug: `lb-${brandId.slice(0, 8)}`,
        website,
        palette: {},
        typography: {},
        voiceGuide: {},
      },
    });

    const accountIds: Record<string, string> = {};
    for (const platform of ['X', 'FACEBOOK', 'INSTAGRAM', 'THREADS'] as const) {
      const credential = await db.platformCredential.create({
        data: {
          workspaceId,
          brandId,
          platform,
          mode: 'CLIENT_APP',
          label: `${platform} app`,
          appId: `app-${platform}-${brandId.slice(0, 6)}`,
          appSecret: 'secret',
          redirectUri: 'https://example.test/cb',
          grantedScopes: [],
          requiredScopes: [],
          status: 'ACTIVE',
        },
      });
      const account = await db.socialAccount.create({
        data: {
          brandId,
          platform,
          externalId: `${platform}-${brandId.slice(0, 6)}`,
          handle: 'brand',
          accessToken: 'token',
          tokenSecret: 'tsecret',
          scopes: [],
          credentialId: credential.id,
          status: 'ACTIVE',
        },
      });
      accountIds[platform] = account.id;
    }

    return { workspaceId, brandId, accountIds };
  }

  async function makePost(brandId: string, baseCopy: string | null): Promise<string> {
    const post = await db.post.create({
      data: { brandId, title: 'Link post', status: 'READY', baseCopy },
    });
    return post.id;
  }

  async function makeTarget(
    postId: string,
    platform: 'X' | 'FACEBOOK' | 'INSTAGRAM' | 'THREADS',
    accountId: string,
    caption: string | null,
  ): Promise<string> {
    const target = await db.postTarget.create({
      data: {
        postId,
        platform,
        socialAccountId: accountId,
        caption,
        status: 'SCHEDULED',
        scheduledFor: new Date(Date.now() - 1000),
      },
    });
    return target.id;
  }

  beforeAll(() => {
    db = getPrisma();
  });

  afterAll(async () => {
    for (const id of workspaceIds) {
      await db.workspace.deleteMany({ where: { id } });
    }
    await disconnectPrisma();
  });

  describe('caption inheritance', () => {
    /**
     * The bug this protects against shipped: `buildPublishInput` read
     * `target.caption ?? ''`, which publishes an **empty post** for every target the user
     * never gave a per-platform override — the ordinary case for a draft written once and
     * sent everywhere. No existing test caught it because every fixture set a caption.
     */
    it('publishes the base copy when the target caption is null', async () => {
      const brand = await makeBrand(null);
      const postId = await makePost(brand.brandId, 'inherited base copy');
      const targetId = await makeTarget(postId, 'X', brand.accountIds.X!, null);

      const { registry, inputs } = capturingRegistry();
      const outcome = await publishTarget(db, { targetId, actor: 'test', registry });

      expect(outcome.kind).toBe('published');
      expect(inputs).toHaveLength(1);
      expect(inputs[0]!.caption).toBe('inherited base copy');
    });

    it('publishes an empty caption when the user deliberately cleared it', async () => {
      const brand = await makeBrand(null);
      const postId = await makePost(brand.brandId, 'base copy that must NOT appear');
      const targetId = await makeTarget(postId, 'X', brand.accountIds.X!, '');

      const { registry, inputs } = capturingRegistry();
      await publishTarget(db, { targetId, actor: 'test', registry });

      // `''` is a deliberate clear, `null` is inheritance. Flattening the two would make
      // the test above pass for the wrong reason.
      expect(inputs[0]!.caption).toBe('');
    });
  });

  describe('short link injection', () => {
    it('replaces the marker with a working short link and records the destination', async () => {
      const brand = await makeBrand('https://brand.example.test/offer');
      const postId = await makePost(brand.brandId, null);
      const targetId = await makeTarget(
        postId,
        'X',
        brand.accountIds.X!,
        `Read more: ${LINK_MARKER}`,
      );

      const { registry, inputs } = capturingRegistry();
      await publishTarget(db, { targetId, actor: 'test', registry });

      const published = inputs[0]!.caption;

      // The marker must be gone, and what replaced it must be the link we actually stored
      // — not merely "some URL", which a hardcoded string would also satisfy.
      expect(published).not.toContain(LINK_MARKER);

      const links = await db.shortLink.findMany({ where: { postId } });
      expect(links).toHaveLength(1);
      expect(links[0]!.platform).toBe('X');
      expect(links[0]!.destinationUrl).toBe('https://brand.example.test/offer');
      expect(isValidSlug(links[0]!.slug)).toBe(true);
      expect(published).toBe(`Read more: ${shortLinkUrl(links[0]!.slug)}`);
    });

    it('gives each platform its own link, which is what makes attribution per-platform', async () => {
      const brand = await makeBrand('https://brand.example.test/');
      const postId = await makePost(brand.brandId, `One post: ${LINK_MARKER}`);

      const xTarget = await makeTarget(postId, 'X', brand.accountIds.X!, null);
      const fbTarget = await makeTarget(postId, 'FACEBOOK', brand.accountIds.FACEBOOK!, null);

      const { registry, inputs } = capturingRegistry();
      await publishTarget(db, { targetId: xTarget, actor: 'test', registry });
      await publishTarget(db, { targetId: fbTarget, actor: 'test', registry });

      const links = await db.shortLink.findMany({ where: { postId }, orderBy: { platform: 'asc' } });
      expect(links.map((l) => l.platform)).toEqual(['FACEBOOK', 'X']);

      const slugs = new Set(links.map((l) => l.slug));
      expect(slugs.size).toBe(2);

      // Each caption carries its OWN slug. If both platforms shared one link the click
      // stream would merge and per-platform attribution — the entire point — would be
      // silently wrong while every count still looked plausible.
      const xLink = links.find((l) => l.platform === 'X')!;
      const fbLink = links.find((l) => l.platform === 'FACEBOOK')!;
      expect(inputs[0]!.caption).toContain(shortLinkUrl(xLink.slug));
      expect(inputs[0]!.caption).not.toContain(shortLinkUrl(fbLink.slug));
      expect(inputs[1]!.caption).toContain(shortLinkUrl(fbLink.slug));
      expect(inputs[1]!.caption).not.toContain(shortLinkUrl(xLink.slug));
    });

    it('creates an Instagram link row but spends no caption budget on a dead URL', async () => {
      const brand = await makeBrand('https://brand.example.test/');
      const postId = await makePost(brand.brandId, null);
      const targetId = await makeTarget(
        postId,
        'INSTAGRAM',
        brand.accountIds.INSTAGRAM!,
        `Link in bio ${LINK_MARKER}`,
      );

      const { registry, inputs } = capturingRegistry();
      await publishTarget(db, { targetId, actor: 'test', registry });

      // The row must exist: Instagram clicks arrive through the profile link, and with no
      // ShortLink there would be nothing for them to resolve to.
      const links = await db.shortLink.findMany({ where: { postId } });
      expect(links).toHaveLength(1);
      expect(links[0]!.platform).toBe('INSTAGRAM');

      // But Instagram does not linkify caption URLs, so injecting one spends characters
      // to produce text nobody can click.
      expect(inputs[0]!.caption).not.toContain(LINK_MARKER);
      expect(inputs[0]!.caption).not.toContain(shortLinkUrl(links[0]!.slug));
      expect(inputs[0]!.caption).toBe('Link in bio');
    });

    it('never lets a literal marker reach a live post when the brand has no website', async () => {
      const brand = await makeBrand(null);
      const postId = await makePost(brand.brandId, null);
      const targetId = await makeTarget(
        postId,
        'X',
        brand.accountIds.X!,
        `See ${LINK_MARKER} today`,
      );

      const { registry, inputs } = capturingRegistry();
      await publishTarget(db, { targetId, actor: 'test', registry });

      // Visible to the audience and permanent — the worst available outcome.
      expect(inputs[0]!.caption).not.toContain(LINK_MARKER);
      expect(inputs[0]!.caption).not.toContain('{{');
      expect(inputs[0]!.caption).toBe('See today');

      // And nothing was created to point at a destination that does not exist.
      expect(await db.shortLink.count({ where: { postId } })).toBe(0);
    });
  });
});
