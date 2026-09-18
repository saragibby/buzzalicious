import { createHmac, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { getConfig } from '../../../platform/config';
import { safeEqual } from '../../../platform/crypto';
import { ValidationError } from '../../../platform/errors';

/**
 * The signed OAuth `state` parameter.
 *
 * docs/10 is emphatic that this is security-relevant rather than incidental, and under
 * BYO it does two jobs at once:
 *
 *  1. **CSRF.** `state` comes back through the user's browser. Unsigned, an attacker can
 *     choose it, and the classic session-fixation version of this attack ends with the
 *     victim's account connected to the attacker's social profile.
 *  2. **Credential selection.** The callback has no other way to know *which* client's
 *     app secret to use for the code exchange. So an unsigned `state` is not merely a
 *     CSRF vector — it is a CSRF vector that chooses whose secret gets used.
 *
 * Wire format is two base64url segments, `payload.signature`, signed with a key derived
 * from the platform KEK rather than the KEK itself. Deriving costs nothing and means a
 * signing oracle cannot be turned into anything that touches stored ciphertext.
 */

const StatePayloadSchema = z
  .object({
    /** Credential to exchange the code with. The whole reason this is signed. */
    c: z.string().min(1),
    /** Matches the `nonce` column on the handshake row, which is single-use. */
    n: z.string().min(1),
    /** Brand the resulting accounts belong to. */
    b: z.string().min(1),
    p: z.string().min(1),
    /** Expiry, epoch seconds. */
    e: z.number().int().positive(),
  })
  .strict();

export interface OAuthState {
  credentialId: string;
  nonce: string;
  brandId: string;
  platform: string;
  expiresAt: Date;
}

const DERIVATION_LABEL = 'buzzalicious/oauth-state/v1';

function signingKey(): Buffer {
  const { crypto } = getConfig();
  return createHmac('sha256', Buffer.from(crypto.key, 'base64')).update(DERIVATION_LABEL).digest();
}

function sign(payload: string): string {
  return createHmac('sha256', signingKey()).update(payload).digest('base64url');
}

export function generateNonce(): string {
  return randomBytes(24).toString('base64url');
}

export function encodeState(state: OAuthState): string {
  const payload: z.infer<typeof StatePayloadSchema> = {
    c: state.credentialId,
    n: state.nonce,
    b: state.brandId,
    p: state.platform,
    e: Math.floor(state.expiresAt.getTime() / 1000),
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${encoded}.${sign(encoded)}`;
}

/** Thrown for every rejection reason. Deliberately one type and one message. */
export class InvalidOAuthStateError extends ValidationError {
  constructor() {
    // No detail about *which* check failed. Distinguishing "bad signature" from "expired"
    // from "malformed" is free information for someone probing the endpoint, and there is
    // nothing a legitimate user can do differently with any of them.
    super('This authorization link is invalid or has expired. Start the connection again.');
    this.name = 'InvalidOAuthStateError';
  }
}

/**
 * Verify and decode. Throws `InvalidOAuthStateError` for anything that is not a valid,
 * unexpired state signed by this deployment.
 *
 * The signature is checked **before** the payload is parsed, so untrusted JSON never
 * reaches the schema, and compared with `safeEqual` so the comparison does not leak how
 * many leading bytes were right.
 */
export function decodeState(value: string, now: Date = new Date()): OAuthState {
  const parts = value.split('.');
  if (parts.length !== 2) throw new InvalidOAuthStateError();

  const [encoded, signature] = parts as [string, string];
  if (!safeEqual(signature, sign(encoded))) throw new InvalidOAuthStateError();

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidOAuthStateError();
  }

  const result = StatePayloadSchema.safeParse(parsed);
  if (!result.success) throw new InvalidOAuthStateError();

  const expiresAt = new Date(result.data.e * 1000);
  if (expiresAt.getTime() <= now.getTime()) throw new InvalidOAuthStateError();

  return {
    credentialId: result.data.c,
    nonce: result.data.n,
    brandId: result.data.b,
    platform: result.data.p,
    expiresAt,
  };
}
