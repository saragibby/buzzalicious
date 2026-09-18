import type { Platform } from '@prisma/client';
import type { PlatformAdapter } from './adapter.types';
import { NotFoundError } from '../../platform/errors';
import { XAdapter } from './x/x.adapter';
import { FacebookAdapter } from './meta/facebook.adapter';
import { InstagramAdapter } from './meta/instagram.adapter';
import { ThreadsAdapter } from './meta/threads.adapter';

/**
 * The one place that maps a `Platform` to an implementation.
 *
 * Everything downstream — the pipeline, pre-flight, the connect flow, the health sweep —
 * resolves adapters through here rather than importing a concrete class. That is what
 * makes "add LinkedIn" a new file plus one line, and it is also what lets a test
 * substitute a fake adapter without any module mocking.
 *
 * All four v1 platforms are now registered. `adapter.spec-drift.test.ts` asserts that this
 * list covers every platform the composer offers, so a platform added to the composer
 * without an adapter fails a test rather than producing a target that sits in PENDING with
 * no explanation.
 */

export type AdapterRegistry = Partial<Record<Platform, PlatformAdapter>>;

export function createDefaultRegistry(): AdapterRegistry {
  return {
    X: new XAdapter(),
    FACEBOOK: new FacebookAdapter(),
    INSTAGRAM: new InstagramAdapter(),
    THREADS: new ThreadsAdapter(),
  };
}

const defaultRegistry = createDefaultRegistry();

export function getAdapter(
  platform: Platform,
  registry: AdapterRegistry = defaultRegistry,
): PlatformAdapter {
  const adapter = registry[platform];
  if (!adapter) {
    throw new NotFoundError(`No adapter is registered for ${platform}`);
  }
  return adapter;
}

export function supportedPlatforms(registry: AdapterRegistry = defaultRegistry): Platform[] {
  return Object.keys(registry) as Platform[];
}
