import { randomInt } from 'node:crypto';

/**
 * Short-link slugs.
 *
 * ## Why the length is a constant and not a parameter
 *
 * `SLUG_LENGTH` is read by `link-injection.ts` to compute the exact number of characters
 * `{{link}}` will expand to, which is what lets the composer, the schedule-time caption
 * gate and the publisher agree on a caption's length *by construction* rather than by
 * estimate. A slug whose length varied per call would reintroduce the
 * composer-previews-what-publish-rejects bug that `platform-spec.ts` exists to close.
 *
 * So: one constant, exported, and a test that ties the injected-length arithmetic to it.
 */
export const SLUG_LENGTH = 7;

/**
 * Base62. Deliberately the full alphabet rather than an unambiguous subset.
 *
 * A "no 0/O/I/l" alphabet is the right call for a code a human retypes from a receipt.
 * Nobody retypes these — they are clicked from a caption — and dropping four characters
 * would cost 20% of the keyspace for no benefit anyone receives.
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Generate one candidate slug.
 *
 * `randomInt` from `node:crypto`, not `Math.random()`. Slugs are not secrets, but they are
 * guessable-by-enumeration identifiers pointing at a brand's destination URLs, and
 * `Math.random()` is seeded predictably enough that a sequence of slugs minted in one
 * process can be reconstructed. `randomInt` is also free of the modulo bias that
 * `Math.floor(Math.random() * 62)` does not have but `bytes[i] % 62` would.
 */
export function generateSlug(length: number = SLUG_LENGTH): string {
  let slug = '';
  for (let i = 0; i < length; i += 1) {
    slug += ALPHABET[randomInt(ALPHABET.length)];
  }
  return slug;
}

/**
 * A slug this service could have minted.
 *
 * Used by the redirector to reject obvious junk before it reaches the database. This is a
 * cheap filter, not a security control — the database lookup is the authority.
 */
export function isValidSlug(candidate: string): boolean {
  if (candidate.length !== SLUG_LENGTH) return false;
  for (const character of candidate) {
    if (!ALPHABET.includes(character)) return false;
  }
  return true;
}

/**
 * Mint a slug that is not already taken.
 *
 * ## Why this still races, and why that is fine
 *
 * `exists` is a read, so two concurrent callers can both be told a slug is free. The
 * unique index on `ShortLink.slug` is what actually prevents a collision; this loop only
 * keeps the probability of reaching that error negligible. A caller must still handle a
 * unique-violation on insert — `shortlink.service.ts` does, by retrying.
 *
 * The collision probability is not a reason to skip the check. 62^7 is ~3.5e12, so by the
 * birthday bound a *first* collision becomes likely around 2.1 million links — reachable
 * by a successful product, and the failure would be one brand's link resolving to another
 * brand's destination. That is the worst outcome this module can produce.
 */
export async function generateUniqueSlug(
  exists: (slug: string) => Promise<boolean>,
  maxAttempts = 8,
): Promise<string> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const candidate = generateSlug();
    if (!(await exists(candidate))) return candidate;
  }

  // Eight consecutive collisions against a 3.5e12 keyspace is not bad luck, it is a
  // broken generator or an exhausted table. Either way, guessing again is the wrong
  // response and a loud failure is the right one.
  // eslint-disable-next-line no-restricted-syntax
  throw new Error(
    `Could not mint an unused short-link slug in ${maxAttempts} attempts. This is not ` +
      `chance at this keyspace size — suspect a broken random source or an exhausted table.`,
  );
}
