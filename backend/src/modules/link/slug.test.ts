import { describe, expect, it } from 'vitest';
import { SLUG_LENGTH, generateSlug, generateUniqueSlug, isValidSlug } from './slug';

describe('generateSlug', () => {
  it('is SLUG_LENGTH characters of base62', () => {
    for (let i = 0; i < 200; i += 1) {
      const slug = generateSlug();
      expect(slug).toHaveLength(SLUG_LENGTH);
      expect(slug).toMatch(/^[A-Za-z0-9]{7}$/);
    }
  });

  /**
   * The injected-length arithmetic in `link-injection.ts` is derived from `SLUG_LENGTH`.
   * If the constant and the generator disagree, a caption measured at the composer is not
   * the caption that gets published — the exact bug `platform-spec.ts` exists to close.
   */
  it('produces exactly SLUG_LENGTH characters, tying the constant to the generator', () => {
    expect(generateSlug().length).toBe(SLUG_LENGTH);
  });

  /**
   * A generator stuck on one character would satisfy every assertion above. This is the
   * positive control for "it is actually random" — with 200 draws from a 62-character
   * alphabet, seeing fewer than 20 distinct characters overall would be astronomically
   * unlikely and is a far weaker claim than the generator actually makes.
   */
  it('draws from across the alphabet rather than repeating one character', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      for (const character of generateSlug()) seen.add(character);
    }
    expect(seen.size).toBeGreaterThan(20);
  });

  it('does not repeat itself across many draws', () => {
    const slugs = new Set<string>();
    for (let i = 0; i < 1000; i += 1) slugs.add(generateSlug());
    // 1000 draws from 3.5e12 should collide with probability ~1.4e-7.
    expect(slugs.size).toBe(1000);
  });
});

describe('isValidSlug', () => {
  it('accepts a slug the generator could have produced', () => {
    expect(isValidSlug(generateSlug())).toBe(true);
    expect(isValidSlug('aB3xY9z')).toBe(true);
  });

  it.each([
    ['too short', 'abc'],
    ['too long', 'abcdefgh'],
    ['empty', ''],
    ['a hyphen', 'abc-def'],
    ['an underscore', 'abc_def'],
    ['a dot', 'abc.def'],
    ['a slash, which would be a path traversal attempt', 'ab/cdef'],
    ['a percent escape', 'a%2Fbcd'],
    ['a space', 'abc def'],
    ['non-ascii', 'abcdéfg'],
  ])('rejects %s', (_label, candidate) => {
    expect(isValidSlug(candidate)).toBe(false);
  });
});

describe('generateUniqueSlug', () => {
  it('returns the first candidate when nothing is taken', async () => {
    const slug = await generateUniqueSlug(async () => false);
    expect(isValidSlug(slug)).toBe(true);
  });

  /**
   * The positive control that matters here: without asserting `exists` was *called*, a
   * `generateUniqueSlug` that ignored the collision check entirely would pass the test
   * above. That is the "would this still be green if the code were never reached" check
   * from docs/12 applied to a collaborator rather than to the code under test.
   */
  it('consults the collision check', async () => {
    const asked: string[] = [];
    await generateUniqueSlug(async (slug) => {
      asked.push(slug);
      return false;
    });
    expect(asked).toHaveLength(1);
    expect(isValidSlug(asked[0]!)).toBe(true);
  });

  it('retries past a taken slug and returns an untaken one', async () => {
    const asked: string[] = [];
    const slug = await generateUniqueSlug(async (candidate) => {
      asked.push(candidate);
      return asked.length <= 3;
    });

    expect(asked).toHaveLength(4);
    expect(slug).toBe(asked[3]);
    // The three rejected candidates must not be what was returned.
    expect(asked.slice(0, 3)).not.toContain(slug);
  });

  /**
   * Exhaustion must be loud. A generator that returned a colliding slug after giving up
   * would hand one brand's link to another brand's destination — the worst outcome this
   * module can produce — and it would do it silently.
   */
  it('throws rather than returning a colliding slug when every attempt is taken', async () => {
    await expect(generateUniqueSlug(async () => true, 4)).rejects.toThrow(
      /Could not mint an unused short-link slug in 4 attempts/,
    );
  });

  it('makes exactly maxAttempts attempts before giving up', async () => {
    let calls = 0;
    await expect(
      generateUniqueSlug(async () => {
        calls += 1;
        return true;
      }, 5),
    ).rejects.toThrow();
    expect(calls).toBe(5);
  });
});
