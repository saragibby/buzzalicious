import { Router } from 'express';
import { getConfig } from '../../platform/config';
import { getStorage, LocalStorageDriver } from '../../platform/storage';
import { AuthError, NotFoundError, ValidationError } from '../../platform/errors';

/**
 * Serves objects held by the local storage driver, behind the same signed, expiring URL
 * contract that R2 presigning gives us. Development only — in production `getStorage()`
 * returns the R2 driver and this router is not mounted.
 *
 * It exists so that code which needs a fetchable media URL (the render pipeline, and
 * eventually Meta, which fetches media by URL) behaves identically in both environments.
 */
export function createFilesRouter(): Router {
  const router = Router();
  const storage = getStorage();

  if (!(storage instanceof LocalStorageDriver)) {
    return router;
  }

  router.get('/*', (req, res, next) => {
    void (async () => {
      try {
        // Storage keys contain slashes, so the wildcard segment is the whole key.
        const key = (req.params as Record<string, string | undefined>)[0];
        const expires = Number(req.query.expires);
        const signature = String(req.query.signature ?? '');

        if (!key || !signature || !Number.isFinite(expires)) {
          throw new ValidationError('Missing or malformed signed URL parameters');
        }

        // Expired and forged are the same answer on purpose — telling them apart lets a
        // caller probe for valid keys.
        if (!storage.verify(key, expires, signature)) {
          throw new AuthError('Invalid or expired signed URL');
        }

        if (!(await storage.exists(key))) {
          throw new NotFoundError('File');
        }

        res.setHeader('Cache-Control', 'private, max-age=60');
        storage.createReadStream(key).on('error', next).pipe(res);
      } catch (error) {
        next(error);
      }
    })();
  });

  return router;
}

/** True when the local file route should be mounted at all. */
export function shouldMountFilesRouter(): boolean {
  return getConfig().storage.driver === 'local';
}
