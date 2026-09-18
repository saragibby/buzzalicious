import type { AspectRatio, Platform } from '@prisma/client';
import {
  PLATFORM_SPECS,
  type PlatformSpec as CompositionSpec,
  type SupportedPlatform,
} from '../template/platform-spec';
import type { Capability, CredentialCapabilities, PlatformMeta } from './credential.schemas';

/**
 * The contract every social network implements, and the types that flow through it.
 *
 * The single most important property, from ADR-0009: **every method takes an already
 * resolved credential.** No adapter reads `process.env`, because under BYO the app key
 * itself varies per workspace — an adapter that reads the environment works for exactly
 * one client. Retrofitting this would mean touching every signature and every call site,
 * so it is true from the first adapter.
 *
 * The second property, less obvious and just as load-bearing: adapters are **pure
 * translation**. They take identifiers and a credential, call a platform, and return
 * plain data or throw a `PlatformError`. They do not read the database, do not write it,
 * do not enqueue jobs and do not decide policy. That is what makes them testable against
 * faked responses without a database, which is the only way the Meta adapters can be
 * tested at all before a client hands us an app.
 */

/**
 * Decrypted app credentials for one (brand, platform), in memory only.
 *
 * Produced exclusively by `CredentialResolver`. Nothing else constructs one from a
 * database row — that is the choke point docs/10 requires for auditing and rotation, and
 * a second construction site is how it stops being one.
 */
export interface ResolvedCredential {
  /** Row id, or null for the platform-wide `PLATFORM_APP`, which has no row. */
  readonly id: string | null;
  readonly mode: 'DIRECT_TOKEN' | 'CLIENT_APP' | 'PLATFORM_APP';
  readonly platform: Platform;
  readonly workspaceId: string;
  /** Null when the credential is shared across the workspace. */
  readonly brandId: string | null;
  readonly appId: string;
  /** Decrypted. Hold for the duration of the call and no longer. Never log it. */
  readonly appSecret: string;
  readonly redirectUri: string;
  readonly grantedScopes: readonly string[];
  /** `DIRECT_TOKEN` mode: a token the client pasted in rather than one we minted. */
  readonly directToken?: string;
  readonly directTokenSecret?: string;
  readonly systemUserToken?: string;
}

/** An account's tokens, as the platform hands them back. */
export interface TokenSet {
  readonly accessToken: string;
  readonly refreshToken?: string;
  /** OAuth 1.0a: the per-user token secret. X only. */
  readonly tokenSecret?: string;
  readonly expiresAt?: Date | null;
  readonly scopes?: readonly string[];
}

/**
 * One publishable destination discovered by `connect()`.
 *
 * `connect()` returns an **array** because a single Meta authorization can yield several
 * of these — every Page the user administers, plus each linked Instagram Business
 * account. Modelling it as one account was the prototype's mistake and it silently
 * dropped every destination but the first.
 */
export interface ConnectedAccount {
  readonly platform: Platform;
  readonly externalId: string;
  readonly handle?: string;
  readonly displayName?: string;
  readonly avatarUrl?: string;
  readonly tokens: TokenSet;
  readonly platformMeta?: PlatformMeta;
}

/** What a `validate()` sweep found. */
export interface AccountHealth {
  readonly status: 'ACTIVE' | 'EXPIRED' | 'REVOKED' | 'ERROR';
  readonly checkedAt: Date;
  readonly message?: string;
  /** Remaining publishes in the platform's current window, when it tells us. */
  readonly quotaRemaining?: number | null;
  readonly quotaResetsAt?: Date | null;
}

/**
 * The pre-flight answer: what is this credential actually approved to do?
 *
 * `status` is the credential-level verdict and `capabilities` is the per-capability
 * detail the client is shown. `INSUFFICIENT` is the case the whole mechanism exists for —
 * the credential authenticates fine and simply cannot do something we need.
 */
export interface CapabilityReport {
  readonly status: 'ACTIVE' | 'INSUFFICIENT' | 'INVALID';
  readonly grantedScopes: readonly string[];
  readonly capabilities: CredentialCapabilities;
  /** Plain language, shown to the client. Never contains a secret or an upstream body. */
  readonly summary: string;
  readonly checkedAt: Date;
}

/** Media the adapter should attach, already uploaded and publicly fetchable. */
export interface PublishMedia {
  /** Time-limited signed URL. Meta fetches media by URL, so this must be reachable. */
  readonly url: string;
  readonly mimeType: string;
  readonly width?: number;
  readonly height?: number;
  readonly aspectRatio?: AspectRatio;
}

/**
 * Everything one publish attempt needs, and nothing more.
 *
 * Notably absent: a database row, a post id, a job id. An adapter that could reach any of
 * those would be able to make decisions that belong to the pipeline.
 */
export interface PublishInput {
  /** The account to publish as, with its decrypted tokens. */
  readonly account: {
    readonly externalId: string;
    readonly tokens: TokenSet;
    readonly platformMeta?: PlatformMeta;
  };
  readonly caption: string;
  readonly media: readonly PublishMedia[];
  /**
   * Stable per-target key. Platforms that support client-side deduplication are given
   * it; for the rest it is what `findExisting` looks for. Never attempt-scoped.
   */
  readonly idempotencyKey: string;
}

export interface PublishResult {
  readonly externalPostId: string;
  readonly externalUrl?: string;
  readonly publishedAt: Date;
  /** Anything worth keeping for metrics polling later — an IG container id, say. */
  readonly platformMeta?: PlatformMeta;
}

/** Every field nullable: availability differs by platform, media type and account tier. */
export interface PlatformMetrics {
  readonly impressions?: number | null;
  readonly reach?: number | null;
  readonly likes?: number | null;
  readonly comments?: number | null;
  readonly shares?: number | null;
  readonly saves?: number | null;
  readonly videoViews?: number | null;
  readonly collectedAt: Date;
}

/** The published post a `fetchMetrics` call is about. Identifiers only. */
export interface MetricsTarget {
  readonly externalPostId: string;
  readonly account: {
    readonly externalId: string;
    readonly tokens: TokenSet;
    readonly platformMeta?: PlatformMeta;
  };
}

export interface StoredAccount {
  readonly externalId: string;
  readonly tokens: TokenSet;
  readonly platformMeta?: PlatformMeta;
}

/**
 * Static facts about a platform, used by the composer and the pipeline.
 *
 * ## One table, and the adapter cannot disagree with it
 *
 * This used to be a second, independent declaration of `captionMaxLength`,
 * `supportedRatios`, `mediaRequired` and `linkBehavior`, restated per adapter alongside
 * `PLATFORM_SPECS` in `modules/template/platform-spec.ts`. The X pair agreed, by luck and
 * attention rather than by construction, and three more pairs were about to be written.
 *
 * They must not drift, because the two are read at opposite ends of the same user action:
 * the composer counts a caption with the `template` table and the publisher gated on the
 * adapter's. When those disagree the product previews a post it will later refuse — which
 * is not hypothetical, it shipped, and it fired on any caption containing a link.
 *
 * So a `PlatformSpec` is now the composer-facing table **plus** the fields only an adapter
 * has an opinion about. `buildAdapterSpec` is the only way to make one, and it takes
 * exactly the adapter-only fields: restating a shared one is a type error, not a review
 * comment. Adding LinkedIn is still one new file.
 */
export interface AdapterOnlySpec {
  readonly maxMediaCount: number;
  /** Native platform scheduling, as opposed to ours. False everywhere in v1. */
  readonly supportsScheduling: boolean;
  readonly requiredScopes: Readonly<Record<Capability, readonly string[]>>;
}

export type PlatformSpec = CompositionSpec & AdapterOnlySpec;

/**
 * Build an adapter's spec from the shared table.
 *
 * The `?: never` mapped type is the load-bearing part: it makes every composer-facing key
 * unpassable here, so an adapter physically cannot declare its own caption limit or ratio
 * list. A convention that says "don't restate these" only holds until someone is in a
 * hurry; a type error holds always.
 */
export function buildAdapterSpec(
  platform: SupportedPlatform,
  adapterOnly: AdapterOnlySpec & { readonly [K in keyof CompositionSpec]?: never },
): PlatformSpec {
  const { maxMediaCount, supportsScheduling, requiredScopes } = adapterOnly;
  return { ...PLATFORM_SPECS[platform], maxMediaCount, supportsScheduling, requiredScopes };
}

export interface PlatformAdapter {
  readonly platform: Platform;
  readonly specs: PlatformSpec;

  /** Authorize URL for this client's app. `state` is already signed. */
  getAuthUrl(cred: ResolvedCredential, state: string, context: AuthUrlContext): Promise<string>;

  /** Exchange the callback's code (or verifier) for one or more destinations. */
  connect(cred: ResolvedCredential, callback: OAuthCallback): Promise<ConnectedAccount[]>;

  refresh(cred: ResolvedCredential, account: StoredAccount): Promise<TokenSet>;

  validate(cred: ResolvedCredential, account: StoredAccount): Promise<AccountHealth>;

  /** Pre-flight. See docs/10 — this is what turns an invisible failure into a task. */
  introspect(cred: ResolvedCredential): Promise<CapabilityReport>;

  publish(cred: ResolvedCredential, input: PublishInput): Promise<PublishResult>;

  fetchMetrics(cred: ResolvedCredential, target: MetricsTarget): Promise<PlatformMetrics>;
}

/**
 * What leg 1 needs beyond the credential.
 *
 * OAuth 1.0a has no `state` parameter at all — the authorize URL carries an
 * `oauth_token`, and the secret paired with it has to be persisted before the user is
 * redirected. So leg 1 returns data the caller must store, which is why `getAuthUrl` is
 * async and takes a sink rather than being a pure string builder.
 */
export interface AuthUrlContext {
  /**
   * Called with OAuth 1.0a leg-1 material before the URL is returned. The caller
   * persists it; the adapter never touches the database.
   */
  readonly persistRequestToken?: (token: { token: string; secret: string }) => Promise<void>;
}

export interface OAuthCallback {
  /** OAuth 2.0 authorization code. */
  readonly code?: string;
  /** OAuth 1.0a verifier plus the request token pair recovered from the handshake row. */
  readonly oauthVerifier?: string;
  readonly requestToken?: string;
  readonly requestTokenSecret?: string;
}
