import type { Platform } from '@prisma/client';
import { ExternalServiceError } from '../../../platform/errors';
import { measureCaption } from '../../template/platform-spec';
import type {
  AccountHealth,
  AuthUrlContext,
  ConnectedAccount,
  OAuthCallback,
  PlatformAdapter,
  PlatformSpec,
  PublishInput,
  ResolvedCredential,
  StoredAccount,
  TokenSet,
} from '../adapter.types';
import {
  classifyPlatformError,
  isPlatformError,
  type PlatformError,
  type PublishErrorClass,
} from '../publish.errors';
import { GraphClient, type GraphClientOptions } from './graph.client';
import { classifyMetaError } from './meta.errors';

/**
 * What Facebook, Instagram and Threads genuinely share.
 *
 * All three are OAuth 2.0 authorization-code flows against a Graph API, all three trade a
 * short-lived token for a long-lived one, and all three answer errors in the same
 * envelope. Publishing is where they diverge — a Page feed post, a two-step Instagram
 * container, a two-step Threads container — so publishing is abstract and everything
 * before it is not.
 *
 * The base deliberately stops at `publish`, `connect` and `fetchMetrics`. A base class
 * that tried to unify those would need a flag per platform, and the flags would be the
 * real implementation wearing a disguise.
 */

export type MetaPlatform = 'FACEBOOK' | 'INSTAGRAM' | 'THREADS';

/** A thrown failure that never reached a platform. */
export function localRejection(
  message: string,
  errorClass: PublishErrorClass,
  platform: string,
): PlatformError {
  return classifyPlatformError({ platform, message, errorClass });
}

/** Re-throw a `PlatformError` unchanged; classify anything else. */
export function rethrowMeta(error: unknown, platform: MetaPlatform): never {
  if (isPlatformError(error)) throw error;
  throw classifyPlatformError({
    platform,
    message: error instanceof Error ? error.message : String(error),
    cause: error,
  });
}

/** The long-lived token exchange answer, in the one shape all three use. */
interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  token_type?: string;
}

function readTokenResponse(body: unknown): { accessToken: string; expiresAt: Date | null } {
  const token = body as TokenResponse;
  if (typeof token?.access_token !== 'string' || token.access_token === '') {
    // A 200 with no token is a real Graph behaviour when a parameter is subtly wrong, and
    // it would otherwise surface much later as a confusing 401 on the first publish.
    throw new ExternalServiceError('meta', 'Token exchange succeeded but returned no access token');
  }
  return {
    accessToken: token.access_token,
    expiresAt:
      typeof token.expires_in === 'number' && token.expires_in > 0
        ? new Date(Date.now() + token.expires_in * 1000)
        : null,
  };
}

export abstract class MetaAdapterBase implements PlatformAdapter {
  abstract readonly platform: Platform;
  abstract readonly specs: PlatformSpec;

  /** Scopes leg 1 asks for. */
  protected abstract readonly authScopes: readonly string[];
  /** Host serving the authorize dialog, which is not the API host. */
  protected abstract readonly authorizeUrl: string;
  protected abstract readonly metaPlatform: MetaPlatform;

  protected readonly graph: GraphClient;

  constructor(options: GraphClientOptions = {}, platform: MetaPlatform) {
    this.graph = new GraphClient(platform, options);
  }

  async getAuthUrl(
    cred: ResolvedCredential,
    state: string,
    _context: AuthUrlContext,
  ): Promise<string> {
    const url = new URL(this.authorizeUrl);
    url.searchParams.set('client_id', cred.appId);
    url.searchParams.set('redirect_uri', cred.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', this.authScopes.join(','));
    // OAuth 2.0 has a real `state` parameter, so unlike X there is nothing to persist
    // before redirecting and `persistRequestToken` is correctly unused here.
    url.searchParams.set('state', state);
    return url.toString();
  }

  /**
   * Trade an authorization code for a long-lived token.
   *
   * Two calls, not one, and the second is not optional: the code exchange returns a token
   * good for roughly an hour. Storing that is how you build a product that works in
   * testing and breaks for every user the next morning.
   */
  protected async exchangeCodeForLongLivedToken(
    cred: ResolvedCredential,
    code: string,
  ): Promise<{ accessToken: string; expiresAt: Date | null }> {
    const short = readTokenResponse(
      await this.graph.call({
        path: 'oauth/access_token',
        method: 'POST',
        unversioned: true,
        // There is no token yet; the app secret authenticates this call. It goes in the
        // body with everything else, so it is not in a URL.
        accessToken: '',
        body: {
          client_id: cred.appId,
          client_secret: cred.appSecret,
          redirect_uri: cred.redirectUri,
          grant_type: 'authorization_code',
          code,
        },
      }),
    );

    return this.exchangeForLongLived(cred, short.accessToken);
  }

  /** Platform-specific long-lived exchange. Threads spells it differently from Meta. */
  protected abstract exchangeForLongLived(
    cred: ResolvedCredential,
    shortLivedToken: string,
  ): Promise<{ accessToken: string; expiresAt: Date | null }>;

  /**
   * Extend the current long-lived token.
   *
   * Called by the health sweep well before expiry, not at expiry: Meta long-lived tokens
   * are refreshable only while still valid, so a token that has already lapsed cannot be
   * rescued and needs the user to reconnect. Leaving the refresh until the token is dead
   * converts an invisible background renewal into a support request.
   */
  async refresh(cred: ResolvedCredential, account: StoredAccount): Promise<TokenSet> {
    try {
      const extended = await this.exchangeForLongLived(cred, account.tokens.accessToken);
      return {
        accessToken: extended.accessToken,
        expiresAt: extended.expiresAt,
        scopes: account.tokens.scopes,
      };
    } catch (error) {
      rethrowMeta(error, this.metaPlatform);
    }
  }

  /**
   * Ask the platform whether this account still works.
   *
   * Uses `raw` rather than `call` so an unhealthy account is a returned verdict instead of
   * a thrown exception — the sweep checks many accounts in a pass, and one throwing would
   * abandon the rest of them unchecked.
   */
  async validate(_cred: ResolvedCredential, account: StoredAccount): Promise<AccountHealth> {
    const checkedAt = new Date();

    const response = await this.graph.raw({
      path: this.healthPath(account),
      accessToken: account.tokens.accessToken,
      query: { fields: 'id' },
    });

    if (response.ok) return { status: 'ACTIVE', checkedAt };

    const error = classifyMetaResponse(this.metaPlatform, response.status, response.body);

    return {
      // AUTH means the token itself is dead — the user removed the app, changed their
      // password, or the long-lived token finally lapsed. That is REVOKED, and REVOKED is
      // what blocks dependent scheduled targets rather than retrying them forever.
      status: error.errorClass === 'AUTH' ? 'REVOKED' : 'ERROR',
      checkedAt,
      message: error.clientMessage,
    };
  }

  /** The cheapest call that proves a token works, per platform. */
  protected abstract healthPath(account: StoredAccount): string;

  abstract connect(cred: ResolvedCredential, callback: OAuthCallback): Promise<ConnectedAccount[]>;

  /**
   * Reject a caption the platform will reject, before the network.
   *
   * Measured with the shared `measureCaption`, never `caption.length`: Threads charges
   * UTF-8 bytes and Instagram counts code points, so a `.length` gate here would disagree
   * with the composer's counter in both directions — an emoji-heavy Instagram caption
   * would be refused although it fits, and a Threads caption of multibyte text would be
   * accepted although it does not.
   *
   * This is a backstop. The real gate is in pre-flight at schedule time, where the user
   * can still do something about it.
   */
  protected assertCaptionFits(caption: string): void {
    const measured = measureCaption(this.platform as Parameters<typeof measureCaption>[0], caption);
    if (!measured.over) return;

    throw localRejection(
      `Caption is ${measured.used} ${this.specs.captionCountUnit} against a ${measured.limit} limit for ${this.specs.label}`,
      'VALIDATION',
      this.metaPlatform,
    );
  }

  /** Media rules that are the same for all three, checked before any upload. */
  protected assertMediaAcceptable(input: PublishInput): void {
    if (this.specs.mediaRequired && input.media.length === 0) {
      throw localRejection(
        `${this.platform} posts must include at least one image`,
        'VALIDATION',
        this.metaPlatform,
      );
    }
    if (input.media.length > this.specs.maxMediaCount) {
      throw localRejection(
        `${this.platform} accepts at most ${this.specs.maxMediaCount} images per post`,
        'VALIDATION',
        this.metaPlatform,
      );
    }
  }

  abstract introspect(cred: ResolvedCredential): ReturnType<PlatformAdapter['introspect']>;
  abstract publish(
    cred: ResolvedCredential,
    input: PublishInput,
  ): ReturnType<PlatformAdapter['publish']>;
  abstract fetchMetrics(
    cred: ResolvedCredential,
    target: Parameters<PlatformAdapter['fetchMetrics']>[1],
  ): ReturnType<PlatformAdapter['fetchMetrics']>;
}

/** Classify a non-throwing `raw` response. Shared by `validate` and `introspect`. */
export function classifyMetaResponse(
  platform: MetaPlatform,
  status: number,
  body: unknown,
): PlatformError {
  return classifyMetaError({ platform, status, body });
}
