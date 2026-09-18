import { createHash } from 'node:crypto';

/**
 * Deterministic identity and randomness for the seed.
 *
 * The seed has to be re-runnable: developers run it against a database that already has
 * seeded rows, and W3–W9 all build against it. Re-running must converge on the same data,
 * not accumulate a second copy. Prisma's `@default(uuid())` cannot give us that, because a
 * second run would mint new ids for the same logical row, so every seeded row derives its
 * primary key from a stable natural key and is written with `upsert({ where: { id } })`.
 *
 * That also means a fixture id is stable across machines: a test, a doc, or a Slack
 * message can name a specific seeded brand and mean the same row everywhere.
 */

const NAMESPACE = 'buzzalicious.seed.v1';

/**
 * A UUID derived from a natural key — RFC 4122 §4.3 name-based, SHA-1 variant.
 *
 * `seedId('brand', 'rise-and-shore')` is the same UUID on every machine, every run.
 */
export function seedId(...parts: string[]): string {
  const hash = createHash('sha1')
    .update(`${NAMESPACE}:${parts.join('/')}`)
    .digest();

  // Version 5, RFC 4122 variant.
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;

  const hex = hash.subarray(0, 16).toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/**
 * A small deterministic PRNG (mulberry32), seeded from a string.
 *
 * Metrics and click counts need to look organic without being random: `Math.random()`
 * would make every developer's database different and every "why is this number different
 * on your machine?" question unanswerable.
 */
export function createRng(seed: string): () => number {
  let state = 0;
  for (let i = 0; i < seed.length; i += 1) {
    state = Math.imul(state ^ seed.charCodeAt(i), 2654435761) >>> 0;
  }

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** An integer in [min, max], inclusive. */
export function randomInt(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

/** Scale a base value by ±`spread` (0.3 = ±30%), rounded. Keeps counts plausible. */
export function jitter(rng: () => number, base: number, spread = 0.3): number {
  return Math.max(0, Math.round(base * (1 + (rng() * 2 - 1) * spread)));
}
