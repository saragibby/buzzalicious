import type { Role } from '@prisma/client';
import type { Request, RequestHandler } from 'express';
import { AuthError } from '../../platform/errors';
import {
  requireBrandAccess,
  requireWorkspaceAccess,
  type BrandAccess,
  type WorkspaceAccess,
} from '../../modules/identity/authorization';

/**
 * Scope resolution for brand- and workspace-scoped routes.
 *
 * These are thin on purpose. The policy lives in `modules/identity/authorization.ts`;
 * all that happens here is turning a route parameter into a resolved scope and hanging it
 * on the request. The value of doing it as middleware is that the handler downstream can
 * only reach `access.db`, which is already scoped — there is no unscoped client in reach,
 * so "forgot to filter by workspace" is not a mistake a route is able to make.
 *
 * Errors are passed to `next` rather than thrown, because an async throw inside an Express
 * 4 handler does not reach the error middleware — it becomes an unhandled rejection and
 * the request hangs until it times out.
 */

function currentUserId(req: Request): string {
  const user = req.user;
  if (!user) {
    // requireAuth should have run first. If it did not, this is the failure that says so.
    throw new AuthError();
  }
  return user.id;
}

/**
 * Resolve the workspace named by a route parameter.
 *
 * @param paramName route parameter holding the workspace id
 */
export function requireWorkspace(
  paramName = 'workspaceId',
  options: { minimumRole?: Role } = {},
): RequestHandler {
  return (req, _res, next) => {
    void (async () => {
      try {
        const workspaceId = req.params[paramName];
        if (!workspaceId) {
          throw new AuthError(`Route is missing the :${paramName} parameter`);
        }

        req.workspace = await requireWorkspaceAccess(currentUserId(req), workspaceId, options);
        next();
      } catch (error) {
        next(error);
      }
    })();
  };
}

/**
 * Resolve the brand named by a route parameter.
 *
 * Also populates `req.workspace`, since brand access implies workspace access and a
 * handler often needs both — without this, a route would have to stack two middlewares
 * and the second would repeat the first's membership query.
 */
export function requireBrand(
  paramName = 'brandId',
  options: { minimumRole?: Role } = {},
): RequestHandler {
  return (req, _res, next) => {
    void (async () => {
      try {
        const brandId = req.params[paramName];
        if (!brandId) {
          throw new AuthError(`Route is missing the :${paramName} parameter`);
        }

        const access = await requireBrandAccess(currentUserId(req), brandId, options);
        req.brand = access;
        req.workspace = access;
        next();
      } catch (error) {
        next(error);
      }
    })();
  };
}

/**
 * Read the resolved scope, or fail loudly.
 *
 * A handler that calls this without the matching middleware gets a clear 500 naming the
 * mistake, rather than `undefined` propagating into a query as an unfiltered read. This
 * is the last of the three locks on the same door — the type is optional, the scoped
 * client is the only one in reach, and this is what happens if both are worked around.
 */
export function brandOf(req: Request): BrandAccess {
  if (!req.brand) {
    throw new Error('This route reads a brand scope but is not mounted behind requireBrand()');
  }
  return req.brand;
}

export function workspaceOf(req: Request): WorkspaceAccess {
  if (!req.workspace) {
    throw new Error(
      'This route reads a workspace scope but is not mounted behind requireWorkspace()',
    );
  }
  return req.workspace;
}
