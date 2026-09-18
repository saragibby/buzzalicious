import type { Platform } from '@prisma/client';
import type { PlatformAdapter } from './adapter.types';
import { NotFoundError } from '../../platform/errors';
import { XAdapter } from './x/x.adapter';

/**
 * The one place that maps a `Platform` to an implementation.
 *
 * Everything downstream — the pipeline, pre-flight, the connect flow, the health sweep —
 * resolves adapters through here rather than importing a concrete class. That is what
 * makes "add LinkedIn" a new file plus one line, and it is also what lets a test
 * substitute a fake adapter without any module mocking.
 *
 * PR 1 registers X only. Facebook, Instagram and Threads land in PR 2 against the same
 * interface; `getAdapter` failing loudly for them is the correct behaviour in the interim,
 * because the alternative is a target that sits in PENDING forever with no explanation.
 */

export type AdapterRegistry = Partial<Record<Platform, PlatformAdapter>>;

export function createDefaultRegistry(): AdapterRegistry {
  return { X: new XAdapter() };
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
