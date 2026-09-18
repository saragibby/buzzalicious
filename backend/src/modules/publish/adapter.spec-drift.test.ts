import { describe, expect, it } from 'vitest';
import { PLATFORM_SPECS, SUPPORTED_PLATFORMS, type PlatformSpec } from '../template/platform-spec';
import { buildAdapterSpec } from './adapter.types';
import { createDefaultRegistry, getAdapter, supportedPlatforms } from './adapter.registry';

/**
 * The spec-drift guard.
 *
 * `PlatformSpec` used to exist twice — once per adapter, once in the composer's table —
 * and the two disagreeing is a shipped bug, not a hypothetical: the composer said a
 * caption fit and the publisher then refused the identical text.
 *
 * `buildAdapterSpec` makes restating a shared field a type error, which a test cannot
 * observe. What a test *can* observe is the consequence: every registered adapter's spec
 * still reports exactly what the composer's table says. If someone reintroduces a
 * hand-written spec object, this goes red even though it compiles.
 */
describe('adapter specs derive from the shared platform table', () => {
  const SHARED_KEYS = [
    'captionMaxLength',
    'captionCountUnit',
    'captionLimitVerified',
    'mediaRequired',
    'linkBehavior',
    'hashtagLimit',
    'maxLinks',
  ] as const;

  it('registers an adapter for every platform the composer offers', () => {
    // The non-vacuity control. Every assertion below iterates the registry, so an empty
    // or shrunken registry would make them all trivially true — which is exactly how a
    // dropped adapter would slip through unnoticed.
    const registered = supportedPlatforms(createDefaultRegistry());

    expect(registered.length).toBeGreaterThan(0);
    for (const platform of SUPPORTED_PLATFORMS) {
      expect(registered).toContain(platform);
    }
  });

  it.each(SUPPORTED_PLATFORMS)('%s reports the shared values verbatim', (platform) => {
    const spec = getAdapter(platform, createDefaultRegistry()).specs;
    // Widened to the declared interface on purpose. `PLATFORM_SPECS` is `as const`, so
    // indexing it gives a union of four literal object types and the optional keys are
    // unreachable on the union — which would quietly force this loop to drop exactly the
    // optional fields most likely to be forgotten by a hand-written spec.
    const shared: PlatformSpec = PLATFORM_SPECS[platform];

    for (const key of SHARED_KEYS) {
      expect(spec[key], `${platform}.${key} drifted from the shared table`).toEqual(shared[key]);
    }
    expect(spec.supportedRatios).toEqual(shared.supportedRatios);
    expect(spec.feedRatios).toEqual(shared.feedRatios);
  });

  it.each(SUPPORTED_PLATFORMS)('%s still carries its adapter-only fields', (platform) => {
    const spec = getAdapter(platform, createDefaultRegistry()).specs;

    // Guards the other direction: a builder that returned only the shared table would
    // pass every assertion above while silently dropping what the pipeline reads.
    expect(spec.maxMediaCount).toBeGreaterThan(0);
    expect(spec.supportsScheduling).toBe(false);
    expect(Object.keys(spec.requiredScopes).length).toBeGreaterThan(0);
  });

  it('cannot be built without naming a platform in the shared table', () => {
    const spec = buildAdapterSpec('THREADS', {
      maxMediaCount: 10,
      supportsScheduling: false,
      requiredScopes: {
        publish_text: ['threads_content_publish'],
        publish_image: ['threads_content_publish'],
        publish_carousel: ['threads_content_publish'],
        publish_video: ['threads_content_publish'],
        read_insights: ['threads_manage_insights'],
        read_hashtags: [],
      },
    });

    // Reads through to the shared table rather than to a literal written here.
    expect(spec.captionMaxLength).toBe(PLATFORM_SPECS.THREADS.captionMaxLength);
    expect(spec.captionCountUnit).toBe('utf8-bytes');
    expect(spec.maxMediaCount).toBe(10);
  });
});
