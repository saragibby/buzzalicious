import { Router } from 'express';
import { getConfig } from '../../platform/config';
import { getPrisma } from '../../platform/db';
import { getLogger } from '../../platform/logger';
import { ValidationError } from '../../platform/errors';
import { requireAuth } from '../middleware/require-auth';
import { requireBrand, brandOf } from '../middleware/require-scope';
import { resolveCredential } from '../../modules/publish/credential.resolver';
import { getAdapter } from '../../modules/publish/adapter.registry';
import type { ConnectedAccount } from '../../modules/publish/adapter.types';
import {
  attachRequestToken,
  consumeHandshake,
  handshakeExpiry,
  startHandshake,
} from '../../modules/publish/oauth/handshake.service';
import {
  decodeState,
  encodeState,
  generateNonce,
  InvalidOAuthStateError,
} from '../../modules/publish/oauth/state';
import { PlatformSchema } from '../../modules/publish/credential.schemas';
import { handle } from './trend.routes';

/**
 * The OAuth connect handshake.
 *
 * Two endpoints with deliberately different security models. `/connect` is authenticated
 * and brand-scoped; `/callback` cannot be, because the platform redirects the user's
 * browser to it and there is no guarantee the session cookie survives the round trip
 * (`SameSite=Lax` covers a top-level GET, but an IdP that POSTs, or a user who completed
 * the flow in a different browser, would both fail). The signed `state` is therefore the
 * authority on the callback, not the session — which is exactly what it is for.
 *
 * `state` binds credential, brand, platform, a nonce and an expiry under an HMAC derived
 * from the deployment key. The matching `OAuthHandshake` row makes it single-use: without
 * it, a valid signed state is a bearer token that works until it expires.
 */
export function createOAuthRouter(): Router {
  const router = Router({ mergeParams: true });

  router.post(
    '/:brandId/connect/:platform',
    requireAuth,
    requireBrand('brandId', { minimumRole: 'ADMIN' }),
    handle(async (req, res) => {
      const { brandId, workspaceId } = brandOf(req);
      const parsed = PlatformSchema.safeParse(req.params.platform);
      if (!parsed.success) {
        throw new ValidationError(`Unknown platform "${req.params.platform}"`);
      }
      const platform = parsed.data;

      const credential = await resolveCredential(getPrisma(), {
        workspaceId,
        brandId,
        platform,
        actor: `user:${req.user!.id}`,
        context: { reason: 'oauth-connect' },
      });

      const nonce = generateNonce();
      // The row is created before the adapter is called so that a crash mid-flight leaves
      // an expiring handshake rather than an orphaned request-token secret with nothing to
      // attribute it to.
      const handshake = await startHandshake(getPrisma(), {
        // A platform-app credential has no row of its own; the handshake still needs to
        // name one, and the resolver guarantees a stored credential exists for any
        // client-supplied mode.
        credentialId: credential.id ?? '',
        platform,
        brandId,
        nonce,
        initiatedByUserId: req.user!.id,
      });

      const state = encodeState({
        credentialId: credential.id ?? '',
        nonce,
        brandId,
        platform,
        expiresAt: handshakeExpiry(),
      });

      const adapter = getAdapter(platform);
      const url = await adapter.getAuthUrl(credential, state, {
        persistRequestToken: async (token) => {
          await attachRequestToken(getPrisma(), handshake.id, token);
        },
      });

      // A URL, not a 302. The SPA needs to decide whether to open a popup or navigate, and
      // a redirect from an XHR is invisible to it.
      res.json({ url });
    }),
  );

  router.get(
    '/callback/:platform',
    handle(async (req, res) => {
      const config = getConfig();
      const logger = getLogger();
      const db = getPrisma();

      const rawState = req.query.state;
      if (typeof rawState !== 'string') throw new InvalidOAuthStateError();

      const state = decodeState(rawState);
      if (state.platform !== req.params.platform) throw new InvalidOAuthStateError();

      // Atomic single-use claim. A duplicated callback — a double-click, a prefetching
      // browser, a replayed link — must not exchange the same authorization twice.
      const handshake = await consumeHandshake(db, state.nonce);

      const parsed = PlatformSchema.safeParse(state.platform);
      if (!parsed.success) throw new InvalidOAuthStateError();
      const platform = parsed.data;

      const brand = await db.brand.findUnique({
        where: { id: state.brandId },
        select: { workspaceId: true },
      });
      if (!brand) throw new InvalidOAuthStateError();

      const credential = await resolveCredential(db, {
        workspaceId: brand.workspaceId,
        brandId: state.brandId,
        platform,
        actor: 'oauth:callback',
        credentialId: state.credentialId || undefined,
        context: { reason: 'oauth-callback' },
      });

      const adapter = getAdapter(platform);
      const accounts = await adapter.connect(credential, {
        code: typeof req.query.code === 'string' ? req.query.code : undefined,
        oauthVerifier:
          typeof req.query.oauth_verifier === 'string' ? req.query.oauth_verifier : undefined,
        requestToken: handshake.requestToken ?? undefined,
        requestTokenSecret: handshake.requestTokenSecret ?? undefined,
      });

      await persistAccounts(state.brandId, credential.id, accounts);

      logger.info(
        { platform, brandId: state.brandId, accounts: accounts.length },
        'oauth connect completed',
      );

      // Back to the SPA. The connections page reads the accounts it just gained; passing
      // anything about them in the URL would put a handle in a server log for no benefit.
      res.redirect(`${config.webUrl}/settings/connections?connected=${platform}`);
    }),
  );

  return router;
}

/**
 * Upsert each discovered destination.
 *
 * Keyed on `(brandId, platform, externalId)` so re-running a connect flow refreshes the
 * tokens on the existing row rather than creating a duplicate destination — the prototype
 * created a second account every time a user reconnected, and the composer then offered
 * the same Page twice.
 */
async function persistAccounts(
  brandId: string,
  credentialId: string | null,
  accounts: readonly ConnectedAccount[],
): Promise<void> {
  const db = getPrisma();

  for (const account of accounts) {
    const existing = await db.socialAccount.findFirst({
      where: { brandId, platform: account.platform, externalId: account.externalId },
      select: { id: true },
    });

    const tokens = {
      accessToken: account.tokens.accessToken,
      refreshToken: account.tokens.refreshToken ?? null,
      tokenSecret: account.tokens.tokenSecret ?? null,
      tokenExpiresAt: account.tokens.expiresAt ?? null,
      scopes: [...(account.tokens.scopes ?? [])],
      handle: account.handle ?? null,
      displayName: account.displayName ?? null,
      avatarUrl: account.avatarUrl ?? null,
      credentialId,
      // A freshly exchanged token is active by definition, and a reconnect is the usual
      // cure for a REVOKED row — leaving the old status would make the fix look like it
      // had not worked.
      status: 'ACTIVE' as const,
      lastError: null,
    };

    if (existing) {
      await db.socialAccount.update({ where: { id: existing.id }, data: tokens });
    } else {
      await db.socialAccount.create({
        data: {
          brandId,
          platform: account.platform,
          externalId: account.externalId,
          ...tokens,
        },
      });
    }
  }
}
