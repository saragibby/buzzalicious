import type { User as PrismaUser } from '@prisma/client';

/**
 * Express type augmentation.
 *
 * `req.id` is set by `pino-http`; declaring it here is what lets handlers and the error
 * middleware quote a request ID without casting at every call site.
 */
declare global {
  namespace Express {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface User extends PrismaUser {}

    interface Request {
      id?: string;
    }
  }
}

export {};
