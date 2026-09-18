import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { countryFromHeaders, describeClient, hashIp } from './ip-hash';

/**
 * A salt override for the boundary tests only.
 *
 * `null` means "defer to the real config", so every other test in this file runs against
 * the unmocked behaviour and this mock cannot quietly change what they prove.
 */
let saltOverride: string | null = null;

vi.mock('../../platform/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../platform/config')>();
  return {
    ...actual,
    getConfig: () => {
      const real = actual.getConfig();
      if (saltOverride === null) return real;
      return { ...real, link: { ...real.link, ipSalt: saltOverride } };
    },
  };
});

afterEach(() => {
  saltOverride = null;
});

const SENTINEL_IP = '203.0.113.77';
const OTHER_IP = '198.51.100.22';

describe('hashIp', () => {
  it('is deterministic for one address', () => {
    expect(hashIp(SENTINEL_IP)).toBe(hashIp(SENTINEL_IP));
  });

  it('distinguishes different addresses', () => {
    expect(hashIp(SENTINEL_IP)).not.toBe(hashIp(OTHER_IP));
  });

  it('returns a hex sha-256 digest', () => {
    expect(hashIp(SENTINEL_IP)).toMatch(/^[0-9a-f]{64}$/);
  });

  /**
   * The whole point of the salt.
   *
   * IPv4 is 2^32 addresses, so a bare SHA-256 is enumerable in minutes and the digest is
   * therefore a reversible encoding of the address rather than a pseudonym. This asserts
   * the digest is *not* the unsalted one — which is the only way to tell a salted
   * implementation from an unsalted one from the outside.
   *
   * Mutation check: drop the salt from `hashIp` and this goes red.
   */
  it('is salted — the digest is not a bare sha-256 of the address', () => {
    const unsalted = createHash('sha256').update(SENTINEL_IP).digest('hex');
    expect(hashIp(SENTINEL_IP)).not.toBe(unsalted);
  });

  /**
   * The length prefix, proved rather than asserted by analogy.
   *
   * My first version of this test compared `hashIp('2.3.4.5')` with `hashIp('12.3.4.5')`
   * under one fixed salt and claimed it covered this. It was a tautology: with a `:`
   * separator and a constant salt those two can never collide, so it passed identically
   * with the prefix removed — a mutation run is what exposed it.
   *
   * The real ambiguity needs two things the old test had neither of: a **varying salt**
   * (rotation) and an **IPv6 address**, which contains the same `:` used as the
   * separator. Salt `"secret"` + `"a:b"` and salt `"secret:a"` + `"b"` both flatten to
   * `"secret:a:b"` without a length prefix.
   *
   * If these two digests were ever equal, two different addresses would share one
   * pseudonym and deduplication would discard one person's click as a repeat visit.
   */
  it('keeps the salt/address boundary unambiguous across a salt rotation', () => {
    saltOverride = 'rotating-salt-value';
    const ipv6 = hashIp('2001:db8::1');

    saltOverride = 'rotating-salt-value:2001';
    const shiftedBoundary = hashIp('db8::1');

    expect(ipv6).not.toBe(shiftedBoundary);
  });

  /**
   * Positive control for the mock itself.
   *
   * Without this, a broken `saltOverride` that never reached `hashIp` would make the test
   * above compare two identical inputs — which would pass, and would prove nothing. This
   * asserts the override genuinely changes the digest.
   */
  it('the salt override actually takes effect', () => {
    saltOverride = 'salt-one';
    const one = hashIp(SENTINEL_IP);

    saltOverride = 'salt-two';
    const two = hashIp(SENTINEL_IP);

    expect(one).not.toBe(two);
  });

  /**
   * The acceptance criterion, asserted at the only place an address exists.
   *
   * A digest that contained the address would be a catastrophic implementation, and
   * "obviously it doesn't" is precisely the kind of claim docs/12 says belongs in an
   * assertion rather than a comment.
   */
  it('never embeds the address in its output', () => {
    expect(hashIp(SENTINEL_IP)).not.toContain(SENTINEL_IP);
    expect(hashIp(SENTINEL_IP)).not.toContain('203');
  });
});

describe('countryFromHeaders', () => {
  it.each([
    ['cf-ipcountry', 'cf-ipcountry'],
    ['x-country', 'x-country'],
    ['x-country-code', 'x-country-code'],
    ['x-geo-country', 'x-geo-country'],
  ])('reads %s', (_label, header) => {
    expect(countryFromHeaders({ [header]: 'GB' })).toBe('GB');
  });

  it('upper-cases and trims', () => {
    expect(countryFromHeaders({ 'cf-ipcountry': ' us ' })).toBe('US');
  });

  it('takes the first value when a header repeats', () => {
    expect(countryFromHeaders({ 'cf-ipcountry': ['FR', 'DE'] })).toBe('FR');
  });

  /**
   * "We don't know" and "they were in the US" support very different conclusions, so an
   * absent or unusable header must stay distinguishable from a real country rather than
   * being defaulted to one.
   */
  it('returns null when no country header is present', () => {
    expect(countryFromHeaders({})).toBeNull();
    expect(countryFromHeaders({ 'user-agent': 'Mozilla/5.0' })).toBeNull();
  });

  it.each([
    ['Cloudflare unknown', 'XX'],
    ['Cloudflare Tor', 'T1'],
    ['reserved', 'ZZ'],
  ])('maps the %s pseudo-country to null rather than storing it', (_label, value) => {
    expect(countryFromHeaders({ 'cf-ipcountry': value })).toBeNull();
  });

  it.each([
    ['a country name', 'United Kingdom'],
    ['an alpha-3 code', 'GBR'],
    ['a single letter', 'G'],
    ['digits', '44'],
    ['empty', ''],
  ])('rejects %s', (_label, value) => {
    expect(countryFromHeaders({ 'cf-ipcountry': value })).toBeNull();
  });

  it('falls through to a later header when an earlier one is unusable', () => {
    expect(countryFromHeaders({ 'cf-ipcountry': 'XX', 'x-country': 'JP' })).toBe('JP');
  });
});

describe('describeClient', () => {
  it('returns a hash and a country', () => {
    const described = describeClient(SENTINEL_IP, { 'cf-ipcountry': 'IE' });
    expect(described.ipHash).toBe(hashIp(SENTINEL_IP));
    expect(described.country).toBe('IE');
  });

  /**
   * The structural guarantee. `ClientDescriptor` has two fields and neither is an
   * address, so a caller downstream of this function has nothing to leak even by
   * accident. Asserted on the actual key set rather than on the two known fields, so
   * adding an `ip` field later turns this red rather than sailing through.
   */
  it('exposes no field carrying the raw address', () => {
    const described = describeClient(SENTINEL_IP, { 'cf-ipcountry': 'IE' });

    expect(Object.keys(described).sort()).toEqual(['country', 'ipHash']);
    expect(JSON.stringify(described)).not.toContain(SENTINEL_IP);
  });

  /**
   * Hashing `''` would give every address-less request one shared digest, and
   * `(ipHash, shortLinkId)` deduplication would then read all of them as repeat visits by
   * a single person — silently discarding real clicks. Null keeps them distinct.
   *
   * The positive control is the first assertion: a *present* address must still produce a
   * hash, otherwise an implementation that returned null unconditionally would pass.
   */
  it('hashes a present address but returns null for a missing one', () => {
    expect(describeClient(SENTINEL_IP, {}).ipHash).toMatch(/^[0-9a-f]{64}$/);
    expect(describeClient(undefined, {}).ipHash).toBeNull();
    expect(describeClient('', {}).ipHash).toBeNull();
  });

  it('still reports a country when the address is unavailable', () => {
    expect(describeClient(undefined, { 'cf-ipcountry': 'CA' })).toEqual({
      ipHash: null,
      country: 'CA',
    });
  });
});
