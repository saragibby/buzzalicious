import type { Platform } from '@prisma/client';
import {
  buildAdapterSpec,
  type CapabilityReport,
  type ConnectedAccount,
  type MetricsTarget,
  type OAuthCallback,
  type PlatformMetrics,
  type PlatformSpec,
  type PublishInput,
  type PublishResult,
  type ResolvedCredential,
  type StoredAccount,
} from '../adapter.types';
import type { GraphClientOptions } from './graph.client';
import {
  MetaAdapterBase,
  classifyMetaResponse,
  localRejection,
  rethrowMeta,
  type MetaPlatform,
} from './meta.adapter.base';
import { buildCapabilityReport, IG_SCOPES } from './meta.capabilities';

/**
 * Instagram Business accounts, reached through the Pages they are linked to.
 *
 * Two things about Instagram shape this file and neither is obvious:
 *
 * 1. **There is no Instagram login here.** An Instagram Business account is discovered by
 *    listing the user's Facebook Pages and reading each Page's linked IG account. A client
 *    with a personal Instagram account cannot be connected at all, and telling them that
 *    clearly at connect time is most of this adapter's value.
 *
 * 2. **Publishing is two calls, and the gap between them is real.** A container is created
 *    and then published; Instagram fetches the image from our URL during the first call,
 *    asynchronously. Treating the container id as a post id yields an id that looks fine
 *    and resolves to nothing.
 */

const IG_SPEC: PlatformSpec = buildAdapterSpec('INSTAGRAM', {
  // A carousel holds ten.
  maxMediaCount: 10,
  supportsScheduling: false,
  requiredScopes: {
    publish_text: ['instagram_content_publish'],
    publish_image: ['instagram_content_publish'],
    publish_carousel: ['instagram_content_publish'],
    publish_video: ['instagram_content_publish'],
    read_insights: ['instagram_manage_insights'],
    read_hashtags: ['instagram_basic'],
  },
});

/** How long to wait for Instagram to finish fetching media before giving up. */
const CONTAINER_READY_TIMEOUT_MS = 60_000;
const CONTAINER_POLL_INTERVAL_MS = 2_000;

interface PageWithInstagram {
  id?: string;
  name?: string;
  access_token?: string;
  instagram_business_account?: { id?: string; username?: string; name?: string };
}

export class InstagramAdapter extends MetaAdapterBase {
  readonly platform: Platform = 'INSTAGRAM';
  readonly specs = IG_SPEC;
  protected readonly metaPlatform: MetaPlatform = 'INSTAGRAM';
  protected readonly authorizeUrl = 'https://www.facebook.com/v23.0/dialog/oauth';
  protected readonly authScopes = IG_SCOPES;

  constructor(
    options: GraphClientOptions = {},
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
  ) {
    super(options, 'INSTAGRAM');
  }

  protected async exchangeForLongLived(
    cred: ResolvedCredential,
    shortLivedToken: string,
  ): Promise<{ accessToken: string; expiresAt: Date | null }> {
    const body = (await this.graph.call({
      path: 'oauth/access_token',
      unversioned: true,
      accessToken: '',
      query: {
        grant_type: 'fb_exchange_token',
        client_id: cred.appId,
        client_secret: cred.appSecret,
        fb_exchange_token: shortLivedToken,
      },
    })) as { access_token?: string; expires_in?: number };

    if (typeof body.access_token !== 'string') {
      throw localRejection(
        'Instagram did not return a long-lived token',
        'CREDENTIAL',
        'INSTAGRAM',
      );
    }

    return {
      accessToken: body.access_token,
      expiresAt:
        typeof body.expires_in === 'number' && body.expires_in > 0
          ? new Date(Date.now() + body.expires_in * 1000)
          : null,
    };
  }

  protected healthPath(account: StoredAccount): string {
    return account.externalId;
  }

  async connect(cred: ResolvedCredential, callback: OAuthCallback): Promise<ConnectedAccount[]> {
    if (!callback.code) {
      throw localRejection('Missing OAuth authorization code', 'VALIDATION', 'INSTAGRAM');
    }

    try {
      const userToken = await this.exchangeCodeForLongLivedToken(cred, callback.code);

      const response = (await this.graph.call({
        path: 'me/accounts',
        accessToken: userToken.accessToken,
        query: {
          fields: 'id,name,access_token,instagram_business_account{id,username,name}',
          limit: 100,
        },
      })) as { data?: PageWithInstagram[] };

      const pages = response.data ?? [];
      const linked = pages.filter((page) => page.instagram_business_account?.id);

      if (linked.length === 0) {
        // The single most common support case for Instagram, and it is not a bug: the
        // client has a personal or creator account, or has one but never linked it. Named
        // precisely so the answer is a setting they can change, not "it didn't work".
        throw localRejection(
          pages.length === 0
            ? 'No Facebook Pages were found. Instagram publishing requires a Business account linked to a Page.'
            : 'None of these Facebook Pages has a linked Instagram Business account. Convert the Instagram account to Business or Creator and link it to a Page, then reconnect.',
          'CREDENTIAL',
          'INSTAGRAM',
        );
      }

      return linked.map((page) => {
        const ig = page.instagram_business_account!;
        return {
          platform: 'INSTAGRAM' as const,
          externalId: String(ig.id),
          handle: ig.username,
          displayName: ig.name ?? ig.username,
          tokens: {
            // The Page token authorizes the IG account. There is no separate IG token,
            // which is why revoking the Page connection revokes Instagram too.
            accessToken: String(page.access_token),
            expiresAt: null,
            scopes: cred.grantedScopes,
          },
          platformMeta: {
            instagramUserId: String(ig.id),
            facebookPageId: String(page.id),
            facebookPageName: page.name,
          },
        };
      });
    } catch (error) {
      rethrowMeta(error, 'INSTAGRAM');
    }
  }

  async introspect(cred: ResolvedCredential): Promise<CapabilityReport> {
    const checkedAt = new Date();
    const token = cred.directToken ?? cred.systemUserToken;

    if (!token) {
      return {
        status: 'INVALID',
        grantedScopes: cred.grantedScopes,
        capabilities: {},
        summary:
          'No Instagram token is available to check. Connect an account or supply a direct token first.',
        checkedAt,
      };
    }

    const response = await this.graph.raw({
      path: 'debug_token',
      accessToken: `${cred.appId}|${cred.appSecret}`,
      query: { input_token: token },
    });

    if (!response.ok) {
      const error = classifyMetaResponse('INSTAGRAM', response.status, response.body);
      return {
        status: error.errorClass === 'CREDENTIAL' ? 'INSUFFICIENT' : 'INVALID',
        grantedScopes: [],
        capabilities: {},
        summary: error.clientMessage,
        checkedAt,
      };
    }

    const debug = (response.body as { data?: { scopes?: string[]; is_valid?: boolean } }).data;

    if (debug?.is_valid === false) {
      return {
        status: 'INVALID',
        grantedScopes: [],
        capabilities: {},
        summary: 'Instagram reports this token is no longer valid. The connection must be renewed.',
        checkedAt,
      };
    }

    return buildCapabilityReport({
      platform: 'Instagram',
      grantedScopes: debug?.scopes ?? [],
      requiredScopes: IG_SPEC.requiredScopes,
      unsupported: {
        publish_text:
          'Instagram requires an image or video on every post; text-only posts are not possible.',
      },
      checkedAt,
    });
  }

  async publish(_cred: ResolvedCredential, input: PublishInput): Promise<PublishResult> {
    this.assertCaptionFits(input.caption);
    // `mediaRequired` is true in the shared table, so this is where a text-only Instagram
    // post is refused — and it is refused locally rather than by a Graph error that reads
    // like a parameter problem.
    this.assertMediaAcceptable(input);

    const igUserId = String(
      input.account.platformMeta?.instagramUserId ?? input.account.externalId,
    );
    const token = input.account.tokens.accessToken;

    try {
      const containerId =
        input.media.length === 1
          ? await this.createSingleContainer(igUserId, token, input)
          : await this.createCarouselContainer(igUserId, token, input);

      await this.waitForContainer(token, containerId);

      const published = (await this.graph.call({
        path: `${igUserId}/media_publish`,
        method: 'POST',
        accessToken: token,
        body: { creation_id: containerId },
      })) as { id?: string };

      const mediaId = String(published.id);
      const permalink = await this.permalinkFor(mediaId, token);

      return {
        externalPostId: mediaId,
        externalUrl: permalink,
        publishedAt: new Date(),
        // Kept because a container id is the only handle on a publish that half-completed,
        // and a human debugging a stuck post has nothing else to go on.
        platformMeta: { instagramContainerId: containerId },
      };
    } catch (error) {
      rethrowMeta(error, 'INSTAGRAM');
    }
  }

  private async createSingleContainer(
    igUserId: string,
    token: string,
    input: PublishInput,
  ): Promise<string> {
    const container = (await this.graph.call({
      path: `${igUserId}/media`,
      method: 'POST',
      accessToken: token,
      body: { image_url: input.media[0]!.url, caption: input.caption },
    })) as { id?: string };
    return String(container.id);
  }

  private async createCarouselContainer(
    igUserId: string,
    token: string,
    input: PublishInput,
  ): Promise<string> {
    const childIds: string[] = [];

    for (const media of input.media) {
      const child = (await this.graph.call({
        path: `${igUserId}/media`,
        method: 'POST',
        accessToken: token,
        // `is_carousel_item` and no caption: a child carrying a caption is rejected.
        body: { image_url: media.url, is_carousel_item: 'true' },
      })) as { id?: string };
      childIds.push(String(child.id));
    }

    const container = (await this.graph.call({
      path: `${igUserId}/media`,
      method: 'POST',
      accessToken: token,
      body: {
        media_type: 'CAROUSEL',
        children: childIds.join(','),
        caption: input.caption,
      },
    })) as { id?: string };

    return String(container.id);
  }

  /**
   * Wait for Instagram to finish fetching the media.
   *
   * Publishing a container that is still `IN_PROGRESS` fails, and the failure is a generic
   * parameter error that gives no hint that the answer is simply to wait. Polling
   * `status_code` turns that into either a success or a specific message.
   */
  private async waitForContainer(token: string, containerId: string): Promise<void> {
    const deadline = Date.now() + CONTAINER_READY_TIMEOUT_MS;

    for (;;) {
      const status = (await this.graph.call({
        path: containerId,
        accessToken: token,
        query: { fields: 'status_code,status' },
      })) as { status_code?: string; status?: string };

      if (status.status_code === 'FINISHED') return;

      if (status.status_code === 'ERROR' || status.status_code === 'EXPIRED') {
        throw localRejection(
          `Instagram could not process the image: ${status.status ?? status.status_code}`,
          // VALIDATION, not TRANSIENT: Instagram rejected this specific image, so retrying
          // the identical media would fail identically and burn the job's attempts.
          'VALIDATION',
          'INSTAGRAM',
        );
      }

      if (Date.now() >= deadline) {
        throw localRejection(
          'Instagram did not finish processing the image in time',
          // TRANSIENT here is right for the opposite reason: nothing was rejected, it was
          // merely slow, and the retry is likely to succeed.
          'TRANSIENT',
          'INSTAGRAM',
        );
      }

      await this.sleep(CONTAINER_POLL_INTERVAL_MS);
    }
  }

  private async permalinkFor(mediaId: string, token: string): Promise<string | undefined> {
    // Best-effort. A published post with no permalink is still published, so a failure
    // here must not fail the publish — the alternative is a post that went out and a job
    // that reports failure, which is the worst outcome in the whole pipeline.
    const response = await this.graph.raw({
      path: mediaId,
      accessToken: token,
      query: { fields: 'permalink' },
    });
    if (!response.ok) return undefined;
    const permalink = (response.body as { permalink?: unknown }).permalink;
    return typeof permalink === 'string' ? permalink : undefined;
  }

  async fetchMetrics(_cred: ResolvedCredential, target: MetricsTarget): Promise<PlatformMetrics> {
    try {
      const insights = (await this.graph.call({
        path: `${target.externalPostId}/insights`,
        accessToken: target.account.tokens.accessToken,
        query: { metric: 'impressions,reach,likes,comments,saved,shares' },
      })) as { data?: Array<{ name?: string; values?: Array<{ value?: unknown }> }> };

      const byName = new Map<string, number | null>();
      for (const row of insights.data ?? []) {
        const value = row.values?.[0]?.value;
        byName.set(String(row.name), typeof value === 'number' ? value : null);
      }

      return {
        impressions: byName.get('impressions') ?? null,
        reach: byName.get('reach') ?? null,
        likes: byName.get('likes') ?? null,
        comments: byName.get('comments') ?? null,
        shares: byName.get('shares') ?? null,
        saves: byName.get('saved') ?? null,
        videoViews: null,
        collectedAt: new Date(),
      };
    } catch (error) {
      rethrowMeta(error, 'INSTAGRAM');
    }
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
