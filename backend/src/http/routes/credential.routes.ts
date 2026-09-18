import { Router } from 'express';
import { z } from 'zod';
import { getPrisma } from '../../platform/db';
import { ValidationError } from '../../platform/errors';
import { revokeCredential } from '../../modules/publish/revocation.service';
import { requireAuth } from '../middleware/require-auth';
import { requireWorkspace, workspaceOf } from '../middleware/require-scope';
import {
  createCredential,
  getCredential,
  listCredentials,
  toCredentialView,
  updateCredential,
} from '../../modules/publish/credential.service';
import {
  CredentialInputSchema,
  CredentialUpdateSchema,
  PlatformSchema,
} from '../../modules/publish/credential.schemas';
import { runPreflight } from '../../modules/publish/preflight.service';
import { handle } from './trend.routes';

/**
 * Client platform app credentials.
 *
 * Every response body is a `CredentialView`. That is not a convention, it is the control
 * that keeps docs/10's rule true: a secret is never returned by an API. Returning the
 * Prisma row would be the natural thing to write, would type-check, and would ship the
 * client's app secret to the browser — so the row never leaves the service layer.
 *
 * Mounted under `/api/workspaces/:workspaceId/credentials` behind `requireWorkspace`,
 * with writes gated at ADMIN: connecting a platform account is a workspace-level act with
 * a billing and a reputational consequence, not something an EDITOR should do.
 */
export function createCredentialRouter(): Router {
  const router = Router({ mergeParams: true });

  router.use(requireAuth);

  router.get(
    '/',
    requireWorkspace(),
    handle(async (req, res) => {
      const { db } = workspaceOf(req);
      const platform = req.query.platform;
      if (platform !== undefined && typeof platform !== 'string') {
        throw new ValidationError('Platform must be a single value');
      }

      const parsed = platform === undefined ? undefined : PlatformSchema.safeParse(platform);
      if (parsed && !parsed.success) {
        throw new ValidationError(`Unknown platform "${platform}"`);
      }

      res.json({ credentials: await listCredentials(db, { platform: parsed?.data }) });
    }),
  );

  router.post(
    '/',
    requireWorkspace('workspaceId', { minimumRole: 'ADMIN' }),
    handle(async (req, res) => {
      const { db } = workspaceOf(req);
      const input = CredentialInputSchema.parse(req.body);
      res.status(201).json({ credential: await createCredential(db, input) });
    }),
  );

  router.get(
    '/:credentialId',
    requireWorkspace(),
    handle(async (req, res) => {
      const { db } = workspaceOf(req);
      const row = await getCredential(db, req.params.credentialId!);
      res.json({ credential: toCredentialView(row) });
    }),
  );

  router.patch(
    '/:credentialId',
    requireWorkspace('workspaceId', { minimumRole: 'ADMIN' }),
    handle(async (req, res) => {
      const { db } = workspaceOf(req);
      const update = CredentialUpdateSchema.parse(req.body);
      res.json({ credential: await updateCredential(db, req.params.credentialId!, update) });
    }),
  );

  const PreflightSchema = z.object({ brandId: z.string().uuid().nullable().optional() });

  router.post(
    '/:credentialId/preflight',
    requireWorkspace('workspaceId', { minimumRole: 'ADMIN' }),
    handle(async (req, res) => {
      const { db, workspaceId } = workspaceOf(req);
      const { brandId } = PreflightSchema.parse(req.body ?? {});
      const credential = await getCredential(db, req.params.credentialId!);

      // Runs on the unscoped client because the resolver's three-tier fallback has to be
      // able to see a workspace-level and a platform-level credential, neither of which a
      // brand scope can reach. `workspaceId` comes from the verified scope, never the body.
      const report = await runPreflight(getPrisma(), {
        workspaceId,
        brandId: brandId ?? credential.brandId,
        platform: credential.platform,
        credentialId: credential.id,
        actor: `user:${req.user!.id}`,
      });

      res.json({ report });
    }),
  );

  const RevokeSchema = z.object({ reason: z.string().trim().min(1).max(500).optional() });

  // Appended at the end of the route block rather than inserted next to its siblings: W5
  // is editing neighbouring files in parallel and an append conflicts trivially.
  router.post(
    '/:credentialId/revoke',
    requireWorkspace('workspaceId', { minimumRole: 'ADMIN' }),
    handle(async (req, res) => {
      const { db } = workspaceOf(req);
      const { reason } = RevokeSchema.parse(req.body ?? {});

      // Revocation is a fan-out: the credential, every account minted from it, and every
      // target queued against those accounts. It is deliberately not a delete — the
      // history of what was published with which credential is what an incident review
      // needs, and deleting the row would take the accounts with it by cascade.
      res.json({ revoked: await revokeCredential(db, req.params.credentialId!, { reason }) });
    }),
  );

  return router;
}
