import { Role } from '@prisma/client';
import { Router } from 'express';
import { listMemberships } from '../../modules/identity/authorization';
import {
  CreateBrandSchema,
  createBrand,
  listBrands,
  toBrandView,
} from '../../modules/brand/brand.service';
import { AuthError } from '../../platform/errors';
import { requireAuth } from '../middleware/require-auth';
import { requireWorkspace, workspaceOf } from '../middleware/require-scope';

/**
 * Workspace routes.
 *
 * Small on purpose: this exists to answer "which tenants am I in, and what is in the one
 * I picked" — the two questions the workspace switcher asks. Workspace administration
 * (invites, roles, billing) is not W3's.
 */
export function createWorkspaceRouter(): Router {
  const router = Router();

  router.use(requireAuth);

  /**
   * The signed-in user's memberships. Drives the switcher.
   *
   * Derived from memberships rather than from a workspace list, so a workspace the user
   * is not in is not merely hidden from the UI — it is never in the response at all.
   */
  router.get('/', (req, res, next) => {
    void (async () => {
      try {
        if (!req.user) throw new AuthError();

        const memberships = await listMemberships(req.user.id);

        res.json({
          workspaces: memberships.map((membership) => ({
            id: membership.workspace.id,
            name: membership.workspace.name,
            slug: membership.workspace.slug,
            role: membership.role,
          })),
        });
      } catch (error) {
        next(error);
      }
    })();
  });

  router.get('/:workspaceId/brands', requireWorkspace(), (req, res, next) => {
    void (async () => {
      try {
        const { db } = workspaceOf(req);
        const brands = await listBrands(db);
        res.json({ brands: brands.map(toBrandView) });
      } catch (error) {
        next(error);
      }
    })();
  });

  /**
   * Add a brand to a workspace. Admin-only: a brand is the unit everything else attaches
   * to, so creating one is closer to provisioning than to editing.
   */
  router.post(
    '/:workspaceId/brands',
    requireWorkspace('workspaceId', { minimumRole: Role.ADMIN }),
    (req, res, next) => {
      void (async () => {
        try {
          const { db, workspaceId } = workspaceOf(req);
          const input = CreateBrandSchema.parse(req.body);
          const brand = await createBrand(db, workspaceId, input);
          res.status(201).json({ brand: toBrandView(brand) });
        } catch (error) {
          next(error);
        }
      })();
    },
  );

  return router;
}
