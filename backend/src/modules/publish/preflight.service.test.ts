import { describe, expect, it } from 'vitest';
import { describeCapabilities, evaluateCapabilities, summariseStatus } from './preflight.service';

/**
 * Pre-flight: what a connected credential can actually do.
 *
 * The product rule these tests pin down is that a partly-permissioned credential stays
 * usable. A client who has been granted publishing but not insights should be able to
 * publish; marking the whole credential invalid would block the destinations it can
 * legitimately reach, and would read to them as "your connection is broken" when it is
 * not.
 */

const NONE = {
  publish_text: [],
  publish_image: [],
  publish_carousel: [],
  publish_video: [],
  read_insights: [],
  read_hashtags: [],
} as const;

describe('evaluateCapabilities', () => {
  it('marks a capability supported when every required scope is granted', () => {
    const result = evaluateCapabilities(['pages_manage_posts', 'extra'], {
      ...NONE,
      publish_text: ['pages_manage_posts'],
    });

    expect(result.publish_text!.supported).toBe(true);
    expect(result.publish_text!.missingScopes).toEqual([]);
  });

  it('names the missing scopes rather than counting them', () => {
    const result = evaluateCapabilities(['pages_manage_posts'], {
      ...NONE,
      read_insights: ['read_insights', 'pages_read_engagement'],
    });

    expect(result.read_insights!.supported).toBe(false);
    // The whole value of the report is telling the client which permission to request.
    expect(result.read_insights!.missingScopes).toEqual(['read_insights', 'pages_read_engagement']);
    expect(result.read_insights!.reason).toContain('read_insights');
  });

  it('reports only the scopes that are actually missing', () => {
    const result = evaluateCapabilities(['a'], { ...NONE, publish_text: ['a', 'b'] });
    // Not the whole requirement list. Telling a client to request a permission they
    // already have sends them looking for a problem that does not exist.
    expect(result.publish_text!.missingScopes).toEqual(['b']);
  });

  it('treats a scopeless protocol as supported', () => {
    // X's OAuth 1.0a has no scopes at all. Reporting "unsupported" because the granted
    // list is empty would make every X credential look broken.
    const result = evaluateCapabilities([], NONE);
    expect(result.publish_text!.supported).toBe(true);
    expect(result.read_insights!.supported).toBe(true);
  });

  it('evaluates each capability independently', () => {
    const result = evaluateCapabilities(['can_publish'], {
      ...NONE,
      publish_text: ['can_publish'],
      read_insights: ['can_read'],
    });

    // The partial case, which is the one the product rule is about.
    expect(result.publish_text!.supported).toBe(true);
    expect(result.read_insights!.supported).toBe(false);
  });
});

describe('summariseStatus', () => {
  it('is ACTIVE when everything is supported', () => {
    expect(summariseStatus(evaluateCapabilities([], NONE))).toBe('ACTIVE');
  });

  it('is INSUFFICIENT, not INVALID, when something is missing', () => {
    const capabilities = evaluateCapabilities([], { ...NONE, read_insights: ['read_insights'] });
    // INSUFFICIENT keeps the credential resolvable; INVALID would not. This single value
    // is the difference between "your analytics are incomplete" and "you cannot post".
    expect(summariseStatus(capabilities)).toBe('INSUFFICIENT');
  });

  it('is INSUFFICIENT even when only publish is missing', () => {
    const capabilities = evaluateCapabilities([], {
      ...NONE,
      publish_text: ['pages_manage_posts'],
    });
    expect(summariseStatus(capabilities)).toBe('INSUFFICIENT');
  });
});

describe('describeCapabilities', () => {
  it('confirms a fully-permissioned app without listing scopes', () => {
    const message = describeCapabilities('X', evaluateCapabilities([], NONE));
    expect(message).toContain('every permission');
    expect(message).toContain('X');
  });

  it('names each missing scope once', () => {
    const capabilities = evaluateCapabilities([], {
      ...NONE,
      publish_text: ['pages_manage_posts'],
      publish_video: ['pages_manage_posts'],
      read_insights: ['read_insights'],
    });

    const message = describeCapabilities('FACEBOOK', capabilities);
    // De-duplicated: `pages_manage_posts` gates two capabilities but is one thing to go
    // and request, and listing it twice reads like a bug to the client.
    expect(message.match(/pages_manage_posts/g)).toHaveLength(1);
    expect(message).toContain('read_insights');
  });

  it('never includes an upstream body or a secret', () => {
    const capabilities = evaluateCapabilities([], {
      ...NONE,
      publish_text: ['pages_manage_posts'],
    });
    const message = describeCapabilities('FACEBOOK', capabilities);

    expect(message).not.toContain('{');
    expect(message).not.toMatch(/token|secret/i);
    // Control: it is a real message, not an empty string that trivially satisfies the above.
    expect(message.length).toBeGreaterThan(40);
  });
});
