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
import { buildCapabilityReport, THREADS_SCOPES } from './meta.capabilities';

/**
 * Threads.
 *
 * Structurally the closest to Instagram — a container, then a publish — but on its own
 * host (`graph.threads.net`), with its own scopes, its own token-exchange spelling
 * (`th_exchange_token`, not `fb_exchange_token`), and a real refresh endpoint that
 * Facebook and Instagram do not have.
 *
 * It is also the only one of the four that counts captions in **UTF-8 bytes**. A
 * 500-character caption of ordinary English fits; the same 500 characters with accented
 * text or emoji does not. That is why the caption gate here goes through
 * `measureCaption` rather than `.length` — see `MetaAdapterBase.assertCaptionFits`.
 */

const THREADS_SPEC: PlatformSpec = buildAdapterSpec('THREADS', {
  maxMediaCount: 10,
  supportsScheduling: false,
  requiredScopes: {
    publish_text: ['threads_content_publish'],
    publish_image: ['threads_content_publish'],
    publish_carousel: ['threads_content_publish'],
    publish_video: ['threads_content_publish'],
    read_insights: ['threads_manage_insights'],
    read_hashtags: [],
  },
});

const CONTAINER_SETTLE_MS = 3_000;

export class ThreadsAdapter extends MetaAdapterBase {
  readonly platform: Platform = 'THREADS';
  readonly specs = THREADS_SPEC;
  protected readonly metaPlatform: MetaPlatform = 'THREADS';
  protected readonly authorizeUrl = 'https://threads.net/oauth/authorize';
  protected readonly authScopes = THREADS_SCOPES;

  constructor(
    options: GraphClientOptions = {},
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
  ) {
    super(options, 'THREADS');
  }

  protected async exchangeForLongLived(
    cred: ResolvedCredential,
    shortLivedToken: string,
  ): Promise<{ accessToken: string; expiresAt: Date | null }> {
    const body = (await this.graph.call({
      path: 'access_token',
      unversioned: true,
      accessToken: '',
      query: {
        // Threads spells this differently from the rest of Meta. Using the Facebook
        // spelling returns a 400 that says nothing about the parameter name.
        grant_type: 'th_exchange_token',
        client_secret: cred.appSecret,
        access_token: shortLivedToken,
      },
    })) as { access_token?: string; expires_in?: number };

    if (typeof body.access_token !== 'string') {
      throw localRejection('Threads did not return a long-lived token', 'CREDENTIAL', 'THREADS');
    }

    return {
      accessToken: body.access_token,
      expiresAt:
        typeof body.expires_in === 'number' && body.expires_in > 0
          ? new Date(Date.now() + body.expires_in * 1000)
          : null,
    };
  }

  /**
   * Threads has a real refresh endpoint, unlike Facebook and Instagram.
   *
   * It requires the current token to still be valid and at least 24 hours old. The health
   * sweep's job is to call this in the middle of the token's life, not at the end of it.
   */
  protected async refreshLongLived(
    token: string,
  ): Promise<{ accessToken: string; expiresAt: Date | null }> {
    const body = (await this.graph.call({
      path: 'refresh_access_token',
      unversioned: true,
      accessToken: '',
      query: { grant_type: 'th_refresh_token', access_token: token },
    })) as { access_token?: string; expires_in?: number };

    if (typeof body.access_token !== 'string') {
      throw localRejection('Threads did not return a refreshed token', 'AUTH', 'THREADS');
    }

    return {
      accessToken: body.access_token,
      expiresAt:
        typeof body.expires_in === 'number' && body.expires_in > 0
          ? new Date(Date.now() + body.expires_in * 1000)
          : null,
    };
  }

  async refresh(_cred: ResolvedCredential, account: StoredAccount) {
    try {
      const refreshed = await this.refreshLongLived(account.tokens.accessToken);
      return {
        accessToken: refreshed.accessToken,
        expiresAt: refreshed.expiresAt,
        scopes: account.tokens.scopes,
      };
    } catch (error) {
      rethrowMeta(error, 'THREADS');
    }
  }

  protected healthPath(account: StoredAccount): string {
    return account.externalId;
  }

  /**
   * A Threads authorization yields exactly one account.
   *
   * Still an array, because the contract is an array for every platform and a per-platform
   * cardinality would have to be handled by every caller.
   */
  async connect(cred: ResolvedCredential, callback: OAuthCallback): Promise<ConnectedAccount[]> {
    if (!callback.code) {
      throw localRejection('Missing OAuth authorization code', 'VALIDATION', 'THREADS');
    }

    try {
      const short = (await this.graph.call({
        path: 'oauth/access_token',
        method: 'POST',
        unversioned: true,
        accessToken: '',
        body: {
          client_id: cred.appId,
          client_secret: cred.appSecret,
          redirect_uri: cred.redirectUri,
          grant_type: 'authorization_code',
          code: callback.code,
        },
      })) as { access_token?: string; user_id?: string | number };

      if (typeof short.access_token !== 'string') {
        throw localRejection('Threads did not return an access token', 'AUTH', 'THREADS');
      }

      const longLived = await this.exchangeForLongLived(cred, short.access_token);

      const profile = (await this.graph.call({
        path: 'me',
        accessToken: longLived.accessToken,
        query: { fields: 'id,username,threads_profile_picture_url' },
      })) as { id?: string; username?: string; threads_profile_picture_url?: string };

      return [
        {
          platform: 'THREADS' as const,
          externalId: String(profile.id ?? short.user_id),
          handle: profile.username,
          displayName: profile.username,
          avatarUrl: profile.threads_profile_picture_url,
          tokens: {
            accessToken: longLived.accessToken,
            expiresAt: longLived.expiresAt,
            scopes: cred.grantedScopes,
          },
          platformMeta: { threadsUserId: String(profile.id ?? short.user_id) },
        },
      ];
    } catch (error) {
      rethrowMeta(error, 'THREADS');
    }
  }

  /**
   * Threads has no `debug_token`.
   *
   * So unlike Facebook and Instagram there is no way to ask which scopes were granted; the
   * scopes recorded on the credential at connect time are the only source. That is a real
   * weakness — a scope revoked afterwards is invisible until a publish fails — and it is
   * reported as what it is rather than presented as a verified check.
   */
  async introspect(cred: ResolvedCredential): Promise<CapabilityReport> {
    const checkedAt = new Date();
    const token = cred.directToken ?? cred.systemUserToken;

    if (!token) {
      return {
        status: 'INVALID',
        grantedScopes: cred.grantedScopes,
        capabilities: {},
        summary:
          'No Threads token is available to check. Connect an account or supply a direct token first.',
        checkedAt,
      };
    }

    const response = await this.graph.raw({
      path: 'me',
      accessToken: token,
      query: { fields: 'id,username' },
    });

    if (!response.ok) {
      const error = classifyMetaResponse('THREADS', response.status, response.body);
      return {
        status: error.errorClass === 'CREDENTIAL' ? 'INSUFFICIENT' : 'INVALID',
        grantedScopes: [],
        capabilities: {},
        summary: error.clientMessage,
        checkedAt,
      };
    }

    const report = buildCapabilityReport({
      platform: 'Threads',
      grantedScopes: cred.grantedScopes,
      requiredScopes: THREADS_SPEC.requiredScopes,
      unsupported: { read_hashtags: 'Threads does not expose hashtag search.' },
      checkedAt,
    });

    return {
      ...report,
      summary: `${report.summary} Threads does not publish a token inspection endpoint, so these permissions are the ones granted when the account was connected rather than a live check.`,
    };
  }

  async publish(_cred: ResolvedCredential, input: PublishInput): Promise<PublishResult> {
    this.assertCaptionFits(input.caption);
    this.assertMediaAcceptable(input);

    const userId = String(input.account.platformMeta?.threadsUserId ?? input.account.externalId);
    const token = input.account.tokens.accessToken;

    try {
      const containerId = await this.createContainer(userId, token, input);

      // Threads has no container status endpoint. Meta's own guidance is to wait before
      // publishing; there is nothing to poll, so the wait is the whole mechanism.
      if (input.media.length > 0) await this.sleep(CONTAINER_SETTLE_MS);

      const published = (await this.graph.call({
        path: `${userId}/threads_publish`,
        method: 'POST',
        accessToken: token,
        body: { creation_id: containerId },
      })) as { id?: string };

      const postId = String(published.id);
      const permalink = await this.permalinkFor(postId, token);

      return {
        externalPostId: postId,
        externalUrl: permalink,
        publishedAt: new Date(),
        platformMeta: { threadsContainerId: containerId },
      };
    } catch (error) {
      rethrowMeta(error, 'THREADS');
    }
  }

  private async createContainer(
    userId: string,
    token: string,
    input: PublishInput,
  ): Promise<string> {
    if (input.media.length === 0) {
      const container = (await this.graph.call({
        path: `${userId}/threads`,
        method: 'POST',
        accessToken: token,
        body: { media_type: 'TEXT', text: input.caption },
      })) as { id?: string };
      return String(container.id);
    }

    if (input.media.length === 1) {
      const container = (await this.graph.call({
        path: `${userId}/threads`,
        method: 'POST',
        accessToken: token,
        body: { media_type: 'IMAGE', image_url: input.media[0]!.url, text: input.caption },
      })) as { id?: string };
      return String(container.id);
    }

    const childIds: string[] = [];
    for (const media of input.media) {
      const child = (await this.graph.call({
        path: `${userId}/threads`,
        method: 'POST',
        accessToken: token,
        body: { media_type: 'IMAGE', image_url: media.url, is_carousel_item: 'true' },
      })) as { id?: string };
      childIds.push(String(child.id));
    }

    const container = (await this.graph.call({
      path: `${userId}/threads`,
      method: 'POST',
      accessToken: token,
      body: { media_type: 'CAROUSEL', children: childIds.join(','), text: input.caption },
    })) as { id?: string };

    return String(container.id);
  }

  private async permalinkFor(postId: string, token: string): Promise<string | undefined> {
    const response = await this.graph.raw({
      path: postId,
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
        query: { metric: 'views,likes,replies,reposts,quotes,shares' },
      })) as { data?: Array<{ name?: string; values?: Array<{ value?: unknown }> }> };

      const byName = new Map<string, number | null>();
      for (const row of insights.data ?? []) {
        const value = row.values?.[0]?.value;
        byName.set(String(row.name), typeof value === 'number' ? value : null);
      }

      const reposts = byName.get('reposts') ?? null;
      const quotes = byName.get('quotes') ?? null;

      return {
        impressions: byName.get('views') ?? null,
        // Threads reports views, not unique reach.
        reach: null,
        likes: byName.get('likes') ?? null,
        comments: byName.get('replies') ?? null,
        // Reposts and quotes are both shares of this post; summing them is the closest
        // honest mapping. Null only when Threads reported neither, so that "no data" and
        // "zero shares" stay distinguishable.
        shares: reposts === null && quotes === null ? null : (reposts ?? 0) + (quotes ?? 0),
        saves: null,
        videoViews: null,
        collectedAt: new Date(),
      };
    } catch (error) {
      rethrowMeta(error, 'THREADS');
    }
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
