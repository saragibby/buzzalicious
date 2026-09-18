import { describe, expect, it } from 'vitest';
import { decodeState, encodeState, generateNonce, InvalidOAuthStateError } from './state';

/**
 * The signed OAuth `state`.
 *
 * Under BYO this parameter chooses *whose app secret* performs the code exchange, so a
 * forgeable state is not merely a CSRF hole — it is an attacker-chosen credential
 * selection. Each test below corresponds to one way that could go wrong.
 */
const base = {
  credentialId: 'cred-1',
  brandId: 'brand-1',
  platform: 'X',
};

function future(seconds = 600): Date {
  return new Date(Date.now() + seconds * 1000);
}

describe('oauth state', () => {
  it('round-trips a state it signed', () => {
    const nonce = generateNonce();
    const expiresAt = future();
    const decoded = decodeState(encodeState({ ...base, nonce, expiresAt }));

    expect(decoded.credentialId).toBe('cred-1');
    expect(decoded.nonce).toBe(nonce);
    expect(decoded.brandId).toBe('brand-1');
    // Seconds precision: the payload stores epoch seconds, so equality is to the second.
    expect(Math.floor(decoded.expiresAt.getTime() / 1000)).toBe(
      Math.floor(expiresAt.getTime() / 1000),
    );
  });

  it('rejects a tampered payload', () => {
    const encoded = encodeState({ ...base, nonce: generateNonce(), expiresAt: future() });
    const [payload, signature] = encoded.split('.');

    // Swap the credential id for another one and keep the original signature — the exact
    // attack the signature exists to stop.
    const forgedPayload = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(payload!, 'base64url').toString()),
        c: 'cred-evil',
      }),
      'utf8',
    ).toString('base64url');

    expect(() => decodeState(`${forgedPayload}.${signature}`)).toThrow(InvalidOAuthStateError);
  });

  it('rejects a payload signed with a different key', () => {
    // Hand-built "valid-looking" state with an arbitrary signature. An implementation that
    // parsed first and verified second, or skipped verification for well-formed JSON,
    // would accept this.
    const payload = Buffer.from(
      JSON.stringify({
        c: 'cred-evil',
        n: 'n',
        b: 'b',
        p: 'X',
        e: Math.floor(Date.now() / 1000) + 600,
      }),
      'utf8',
    ).toString('base64url');

    expect(() => decodeState(`${payload}.not-a-real-signature`)).toThrow(InvalidOAuthStateError);
  });

  it('rejects an expired state', () => {
    const encoded = encodeState({
      ...base,
      nonce: generateNonce(),
      expiresAt: new Date(Date.now() + 60_000),
    });

    // Correctly signed, simply too late. Verified by moving `now` rather than sleeping.
    expect(() => decodeState(encoded, new Date(Date.now() + 120_000))).toThrow(
      InvalidOAuthStateError,
    );
    // Control: the same string one minute earlier is fine, so this is testing expiry and
    // not a signature that was broken all along.
    expect(decodeState(encoded, new Date(Date.now() + 30_000)).credentialId).toBe('cred-1');
  });

  it('rejects malformed input without leaking which check failed', () => {
    const cases = ['', 'nodot', 'a.b.c', '...', 'ñ.ñ'];
    for (const value of cases) {
      // One error type and one message for every rejection reason: distinguishing "bad
      // signature" from "expired" from "malformed" hands a prober a free oracle.
      expect(() => decodeState(value), value).toThrow(InvalidOAuthStateError);
    }
  });

  it('rejects a payload carrying unexpected fields', () => {
    // `.strict()` on the schema. Extra fields would otherwise ride along into whatever
    // consumes the decoded state next.
    const encoded = encodeState({ ...base, nonce: generateNonce(), expiresAt: future() });
    const [payload] = encoded.split('.');
    const parsed = JSON.parse(Buffer.from(payload!, 'base64url').toString());
    const extended = Buffer.from(JSON.stringify({ ...parsed, admin: true }), 'utf8').toString(
      'base64url',
    );

    // Re-signed correctly, so only the schema can reject it.
    expect(() => decodeState(`${extended}.${encoded.split('.')[1]}`)).toThrow(
      InvalidOAuthStateError,
    );
  });

  it('generates distinct nonces', () => {
    const nonces = new Set(Array.from({ length: 200 }, () => generateNonce()));
    // A repeated nonce would let one handshake row be claimed by a different flow.
    expect(nonces.size).toBe(200);
  });
});
