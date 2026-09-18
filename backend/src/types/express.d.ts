import type { User as PrismaUser } from '@prisma/client';
import type { BrandAccess, WorkspaceAccess } from '../modules/identity/authorization';

/**
 * Express type augmentation.
 *
 * `req.id` is set by `pino-http`; declaring it here is what lets handlers and the error
 * middleware quote a request ID without casting at every call site.
 *
 * `req.workspace` / `req.brand` are set by `requireWorkspace` / `requireBrand`. Both are
 * optional in the type, which is deliberate: a handler must narrow before using one, so
 * "I forgot the middleware" is a compile error rather than a runtime surprise. Use the
 * `workspaceOf` / `brandOf` accessors instead of asserting.
 */
declare global {
  namespace Express {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface User extends PrismaUser {}

    interface Request {
      id?: string;
      workspace?: WorkspaceAccess;
      brand?: BrandAccess;
    }
  }
}

export {};
