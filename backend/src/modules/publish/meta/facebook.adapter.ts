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
import { buildCapabilityReport, FB_PAGE_SCOPES } from './meta.capabilities';

/**
 * Facebook Pages.
 *
 * Publishing is to a **Page**, never to a person's profile — Meta removed the ability to
 * post to a user's own timeline through the API, and a client who expects otherwise needs
 * to be told that at connect time rather than at publish time.
 *
 * The consequence that shapes this file: a Page post is authorized by a **Page access
 * token**, which is not the user token the OAuth flow returns. `connect()` exchanges the
 * user token for one token per Page and stores each against its own account row, so the
 * user token is never what publishes.
 */

const FB_SPEC: PlatformSpec = buildAdapterSpec('FACEBOOK', {
  // Facebook accepts multi-photo posts; ten is the practical ceiling for a feed post and
  // well above anything the composer produces.
  maxMediaCount: 10,
  supportsScheduling: false,
  requiredScopes: {
    publish_text: ['pages_manage_posts'],
    publish_image: ['pages_manage_posts'],
    publish_carousel: ['pages_manage_posts'],
    publish_video: ['pages_manage_posts'],
    read_insights: ['read_insights', 'pages_read_engagement'],
    read_hashtags: [],
  },
});

interface PageRow {
  id?: string;
  name?: string;
  access_token?: string;
  username?: string;
  category?: string;
  tasks?: string[];
}

export class FacebookAdapter extends MetaAdapterBase {
  readonly platform: Platform = 'FACEBOOK';
  readonly specs = FB_SPEC;
  protected readonly metaPlatform: MetaPlatform = 'FACEBOOK';
  protected readonly authorizeUrl = 'https://www.facebook.com/v23.0/dialog/oauth';
  protected readonly authScopes = FB_PAGE_SCOPES;

  constructor(options: GraphClientOptions = {}) {
    super(options, 'FACEBOOK');
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
      throw localRejection('Facebook did not return a long-lived token', 'CREDENTIAL', 'FACEBOOK');
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

  /**
   * One authorization, every Page the user administers.
   *
   * Returning only the first Page is the prototype bug this array return exists to
   * prevent: agencies and multi-location businesses routinely administer several, and a
   * silently dropped Page looks to the client like the connection simply did not work.
   *
   * Pages the user cannot post to are filtered out rather than connected-and-broken. The
   * `tasks` array is Meta's own statement of what this user may do with this Page, and
   * connecting a Page without `CREATE_CONTENT` produces an account that fails on its
   * first publish with a permissions error nobody can act on.
   */
  async connect(cred: ResolvedCredential, callback: OAuthCallback): Promise<ConnectedAccount[]> {
    if (!callback.code) {
      throw localRejection('Missing OAuth authorization code', 'VALIDATION', 'FACEBOOK');
    }

    try {
      const userToken = await this.exchangeCodeForLongLivedToken(cred, callback.code);

      const response = (await this.graph.call({
        path: 'me/accounts',
        accessToken: userToken.accessToken,
        query: { fields: 'id,name,username,category,access_token,tasks', limit: 100 },
      })) as { data?: PageRow[] };

      const pages = response.data ?? [];
      const publishable = pages.filter((page) => canCreateContent(page));

      if (pages.length > 0 && publishable.length === 0) {
        // Distinguishable from "no Pages at all", which is a different conversation with
        // the client: this one means they need a role change, not a Page.
        throw localRejection(
          'This Facebook account administers Pages, but none of them grant permission to create posts',
          'CREDENTIAL',
          'FACEBOOK',
        );
      }

      return publishable.map((page) => ({
        platform: 'FACEBOOK' as const,
        externalId: String(page.id),
        handle: page.username,
        displayName: page.name,
        tokens: {
          // The Page token, not the user token. Page tokens derived from a long-lived user
          // token do not themselves expire, which is why `expiresAt` is null and why the
          // health sweep must probe rather than trust a clock.
          accessToken: String(page.access_token),
          expiresAt: null,
          scopes: cred.grantedScopes,
        },
        platformMeta: {
          facebookPageId: String(page.id),
          facebookPageName: page.name,
          facebookTasks: page.tasks,
        },
      }));
    } catch (error) {
      rethrowMeta(error, 'FACEBOOK');
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
          'No Facebook token is available to check. Connect a Page or supply a direct token first.',
        checkedAt,
      };
    }

    const response = await this.graph.raw({
      path: 'debug_token',
      accessToken: `${cred.appId}|${cred.appSecret}`,
      query: { input_token: token },
    });

    if (!response.ok) {
      const error = classifyMetaResponse('FACEBOOK', response.status, response.body);
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
        summary: 'Facebook reports this token is no longer valid. The connection must be renewed.',
        checkedAt,
      };
    }

    return buildCapabilityReport({
      platform: 'Facebook',
      grantedScopes: debug?.scopes ?? [],
      requiredScopes: FB_SPEC.requiredScopes,
      unsupported: {
        read_hashtags: 'Facebook does not expose hashtag search.',
      },
      checkedAt,
    });
  }

  async publish(_cred: ResolvedCredential, input: PublishInput): Promise<PublishResult> {
    this.assertCaptionFits(input.caption);
    this.assertMediaAcceptable(input);

    const pageId = input.account.platformMeta?.facebookPageId ?? input.account.externalId;
    const pageToken = input.account.tokens.accessToken;

    try {
      if (input.media.length === 0) {
        const post = (await this.graph.call({
          path: `${pageId}/feed`,
          method: 'POST',
          accessToken: pageToken,
          body: { message: input.caption },
        })) as { id?: string };

        return this.toResult(pageId, String(post.id));
      }

      if (input.media.length === 1) {
        const photo = (await this.graph.call({
          path: `${pageId}/photos`,
          method: 'POST',
          accessToken: pageToken,
          body: { url: input.media[0]!.url, caption: input.caption },
        })) as { post_id?: string; id?: string };

        // `post_id` is the feed story; `id` is the photo object. Metrics and permalinks
        // want the story, so the photo id is only the fallback.
        return this.toResult(pageId, String(photo.post_id ?? photo.id));
      }

      // Multi-photo: every photo is uploaded unpublished first, then a single feed post
      // attaches them. Publishing them individually would produce N posts rather than one.
      const mediaFbids: string[] = [];
      for (const media of input.media) {
        const uploaded = (await this.graph.call({
          path: `${pageId}/photos`,
          method: 'POST',
          accessToken: pageToken,
          body: { url: media.url, published: 'false' },
        })) as { id?: string };
        mediaFbids.push(String(uploaded.id));
      }

      const body: Record<string, string> = { message: input.caption };
      mediaFbids.forEach((id, index) => {
        body[`attached_media[${index}]`] = JSON.stringify({ media_fbid: id });
      });

      const post = (await this.graph.call({
        path: `${pageId}/feed`,
        method: 'POST',
        accessToken: pageToken,
        body,
      })) as { id?: string };

      return this.toResult(pageId, String(post.id));
    } catch (error) {
      rethrowMeta(error, 'FACEBOOK');
    }
  }

  private toResult(pageId: string, postId: string): PublishResult {
    // Graph returns `{pageId}_{storyId}` for feed posts. The permalink wants them apart.
    const storyId = postId.includes('_') ? postId.split('_')[1]! : postId;
    return {
      externalPostId: postId,
      externalUrl: `https://www.facebook.com/${pageId}/posts/${storyId}`,
      publishedAt: new Date(),
    };
  }

  async fetchMetrics(_cred: ResolvedCredential, target: MetricsTarget): Promise<PlatformMetrics> {
    try {
      const insights = (await this.graph.call({
        path: `${target.externalPostId}/insights`,
        accessToken: target.account.tokens.accessToken,
        query: { metric: 'post_impressions,post_impressions_unique,post_clicks' },
      })) as { data?: Array<{ name?: string; values?: Array<{ value?: unknown }> }> };

      const byName = new Map<string, number | null>();
      for (const row of insights.data ?? []) {
        const value = row.values?.[0]?.value;
        byName.set(String(row.name), typeof value === 'number' ? value : null);
      }

      const reactions = (await this.graph.call({
        path: target.externalPostId,
        accessToken: target.account.tokens.accessToken,
        query: {
          fields:
            'reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0),shares',
        },
      })) as {
        reactions?: { summary?: { total_count?: number } };
        comments?: { summary?: { total_count?: number } };
        shares?: { count?: number };
      };

      return {
        impressions: byName.get('post_impressions') ?? null,
        reach: byName.get('post_impressions_unique') ?? null,
        likes: reactions.reactions?.summary?.total_count ?? null,
        comments: reactions.comments?.summary?.total_count ?? null,
        shares: reactions.shares?.count ?? null,
        // Facebook does not report saves on a Page post.
        saves: null,
        videoViews: null,
        collectedAt: new Date(),
      };
    } catch (error) {
      rethrowMeta(error, 'FACEBOOK');
    }
  }
}

function canCreateContent(page: PageRow): boolean {
  // Meta omits `tasks` for some legacy Page roles. Absent is treated as permitted so a
  // usable Page is never hidden; the publish attempt is then the authority, and its
  // permissions error is classified as CREDENTIAL by code 200.
  if (!Array.isArray(page.tasks)) return true;
  return page.tasks.includes('CREATE_CONTENT');
}
