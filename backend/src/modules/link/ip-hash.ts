import { createHash } from 'node:crypto';
import { getConfig } from '../../platform/config';

/**
 * Turning a request's network identity into something storable.
 *
 * ## The rule this module exists to enforce
 *
 * **A raw IP address never leaves this file.** Not into a return value, not into a
 * database column, not into a log line, not into an error message. ADR-0006 and docs/06
 * both state it, and an acceptance criterion tests it — but the durable reason it holds
 * is structural: `describeClient()` takes the address and returns a digest and a country,
 * so a caller physically has nothing to misuse.
 *
 * ## Why salted and not merely hashed
 *
 * IPv4 is 2^32 addresses. A bare SHA-256 of every one of them is a few minutes of GPU
 * time, so an unsalted digest is a reversible encoding of the address rather than a
 * pseudonym — it would be PII wearing a hash's clothes, which is worse than storing the
 * address openly because it invites everyone to believe otherwise.
 *
 * The salt is required in production; `config.ts` fails boot without it.
 *
 * ## What rotation costs
 *
 * Rotating the salt makes new digests incomparable with old ones. The only thing that
 * compares digests is `(ipHash, shortLinkId)` duplicate suppression over a window of
 * minutes, so a rotation costs at most one window of missed deduplication. Nothing
 * historical breaks, because nothing reads an old digest for anything else.
 */

/**
 * The dev/test salt.
 *
 * Named so it cannot be mistaken for a secret if it ever appears somewhere unexpected.
 * Production cannot reach this: `config.ts` refuses to boot without a real salt when
 * `NODE_ENV=production`.
 */
const DEV_SALT = 'buzzalicious-development-only-not-a-secret';

function salt(): string {
  return getConfig().link.ipSalt ?? DEV_SALT;
}

/**
 * Salted SHA-256 of an address, hex encoded.
 *
 * The salt is prefixed with its own length so that the salt/address split is unambiguous.
 *
 * The `:` separator alone is not enough, because **IPv6 addresses contain colons**. With
 * only a separator, salt `"s"` + ip `"a:b"` and salt `"s:a"` + ip `"b"` both produce
 * `"s:a:b"`. That matters across a salt rotation: two different addresses under two
 * different salts could land on one digest, and `(ipHash, shortLinkId)` deduplication
 * would then discard a real person's click as a repeat visit.
 *
 * It costs one integer to remove the question entirely.
 */
export function hashIp(ip: string): string {
  const key = salt();
  return createHash('sha256').update(`${key.length}:${key}:${ip}`).digest('hex');
}

/** ISO 3166-1 alpha-2, as a platform edge reports it. */
export type CountryCode = string;

/**
 * Headers a fronting proxy may use to report the client's country.
 *
 * We derive country from a header rather than from an IP-geolocation database. That is a
 * deliberate v1 choice: it adds no dependency, ships no data file, and — the part that
 * matters — means the address never has to be held long enough to look anything up.
 *
 * When no header is present, `country` is `null`. It is **not** guessed and **not**
 * defaulted to anything: an unknown country and a known one must stay distinguishable,
 * because "we don't know" and "they were in the US" support very different conclusions.
 */
const COUNTRY_HEADERS = [
  // Cloudflare.
  'cf-ipcountry',
  // Generic, and what Heroku-fronting proxies tend to set.
  'x-country',
  'x-country-code',
  // Fastly.
  'x-geo-country',
] as const;

/**
 * Cloudflare sends `XX` for "unknown" and `T1` for Tor. Both are real header values and
 * neither is a country, so they map to null rather than being stored as though they were.
 */
const NON_COUNTRIES = new Set(['XX', 'T1', 'ZZ']);

export function countryFromHeaders(
  headers: Record<string, string | string[] | undefined>,
): CountryCode | null {
  for (const name of COUNTRY_HEADERS) {
    const raw = headers[name];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value !== 'string') continue;

    const code = value.trim().toUpperCase();
    if (code.length !== 2) continue;
    if (NON_COUNTRIES.has(code)) continue;
    if (!/^[A-Z]{2}$/.test(code)) continue;

    return code;
  }

  return null;
}

/**
 * Everything storable about who made a request, and nothing else.
 *
 * Note what is absent: the address. That absence is the point — this is the type every
 * caller downstream of the redirector handles, so there is no code path on which an
 * address could reach a column or a log even by mistake.
 */
export interface ClientDescriptor {
  readonly ipHash: string | null;
  readonly country: CountryCode | null;
}

/**
 * Reduce a request's network identity to its storable form.
 *
 * A missing address yields a `null` hash rather than a hash of the empty string. Hashing
 * `''` would give every address-less request one shared digest, and
 * `(ipHash, shortLinkId)` deduplication would then treat all of them as repeat visits by
 * a single person — silently discarding real clicks as duplicates.
 */
export function describeClient(
  ip: string | undefined,
  headers: Record<string, string | string[] | undefined>,
): ClientDescriptor {
  return {
    ipHash: ip ? hashIp(ip) : null,
    country: countryFromHeaders(headers),
  };
}
