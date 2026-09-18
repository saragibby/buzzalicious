import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { getConfig } from './config';

/**
 * AES-256-GCM encryption for values at rest — OAuth tokens and client app secrets.
 *
 * Two structural decisions from docs/10-credentials-and-security.md, both made now so
 * that moving to a managed KMS later is one new class rather than a search across the
 * codebase:
 *
 *  1. **A `KeyProvider` seam.** Nothing here reads the key directly. `EnvKeyProvider`
 *     (a Heroku config var) is the only v1 implementation; a `KmsKeyProvider` drops in
 *     beside it. W6 adds per-workspace DEKs by wrapping them with this same provider.
 *
 *  2. **Versioned ciphertext.** Every value records the scheme and the key that produced
 *     it, so rotation is incremental: write with the new key, read with whichever key
 *     the ciphertext names. There is no flag-day re-encryption.
 *
 * Wire format — five dot-separated base64url segments:
 *
 *     v1.<keyId>.<iv>.<authTag>.<ciphertext>
 *
 * `v1` and `keyId` are authenticated as GCM additional authenticated data, so a value
 * cannot be relabelled as having been encrypted by a different key without detection.
 */

const SCHEME = 'v1';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // 96 bits, the GCM standard
const KEY_BYTES = 32;
const AUTH_TAG_BYTES = 16;

/** Resolves a key encryption key by ID. The seam a KMS implementation replaces. */
export interface KeyProvider {
  /** ID of the key new ciphertext should be written with. */
  readonly currentKeyId: string;
  /** Resolve a key by ID. Must throw `UnknownKeyError` for an ID it does not hold. */
  getKey(keyId: string): Buffer;
}

export class CryptoError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CryptoError';
  }
}

/** A ciphertext names a key we do not have — usually a key removed before re-encryption. */
export class UnknownKeyError extends CryptoError {
  constructor(readonly keyId: string) {
    super(`No encryption key registered for key id "${keyId}"`);
    this.name = 'UnknownKeyError';
  }
}

/** The value was truncated, corrupted, or tampered with. */
export class DecryptionError extends CryptoError {
  constructor(message = 'Failed to decrypt value', options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DecryptionError';
  }
}

/**
 * Keys from config. Holds the current key plus, optionally, retired keys still needed to
 * read old ciphertext — supplied as `ENCRYPTION_KEYS_PREVIOUS` style entries by whoever
 * constructs it.
 */
export class EnvKeyProvider implements KeyProvider {
  private readonly keys: Map<string, Buffer>;

  constructor(
    readonly currentKeyId: string,
    currentKey: string,
    previousKeys: Record<string, string> = {},
  ) {
    this.keys = new Map();
    for (const [id, value] of Object.entries({ ...previousKeys, [currentKeyId]: currentKey })) {
      const key = Buffer.from(value, 'base64');
      if (key.length !== KEY_BYTES) {
        throw new CryptoError(
          `Encryption key "${id}" must be ${KEY_BYTES} bytes; got ${key.length}`,
        );
      }
      this.keys.set(id, key);
    }
  }

  getKey(keyId: string): Buffer {
    const key = this.keys.get(keyId);
    if (!key) throw new UnknownKeyError(keyId);
    return key;
  }
}

export class Encryptor {
  constructor(private readonly keys: KeyProvider) {}

  encrypt(plaintext: string): string {
    const keyId = this.keys.currentKeyId;
    const key = this.keys.getKey(keyId);
    const iv = randomBytes(IV_BYTES);

    const cipher = createCipheriv(ALGORITHM, key, iv);
    // Bind the header to the ciphertext so the scheme and key id cannot be swapped.
    cipher.setAAD(Buffer.from(`${SCHEME}.${keyId}`, 'utf8'));

    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return [
      SCHEME,
      keyId,
      iv.toString('base64url'),
      authTag.toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
  }

  decrypt(value: string): string {
    const parts = value.split('.');
    if (parts.length !== 5) {
      throw new DecryptionError('Malformed ciphertext: expected 5 segments');
    }

    const [scheme, keyId, ivPart, tagPart, ctPart] = parts as [
      string,
      string,
      string,
      string,
      string,
    ];

    if (scheme !== SCHEME) {
      throw new DecryptionError(`Unsupported ciphertext scheme "${scheme}"`);
    }

    const key = this.keys.getKey(keyId);
    const iv = Buffer.from(ivPart, 'base64url');
    const authTag = Buffer.from(tagPart, 'base64url');

    if (iv.length !== IV_BYTES || authTag.length !== AUTH_TAG_BYTES) {
      throw new DecryptionError('Malformed ciphertext: bad IV or auth tag length');
    }

    try {
      const decipher = createDecipheriv(ALGORITHM, key, iv);
      decipher.setAAD(Buffer.from(`${scheme}.${keyId}`, 'utf8'));
      decipher.setAuthTag(authTag);
      return Buffer.concat([
        decipher.update(Buffer.from(ctPart, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch (cause) {
      // GCM authentication failed: corrupted, truncated, or tampered with. Deliberately
      // opaque — distinguishing the cases is an oracle.
      throw new DecryptionError(undefined, { cause });
    }
  }

  /** True when `value` was produced by `encrypt`. Cheap enough to guard a migration with. */
  isEncrypted(value: string): boolean {
    return value.startsWith(`${SCHEME}.`) && value.split('.').length === 5;
  }

  /** The key id a ciphertext was written with, for rotation sweeps. */
  keyIdOf(value: string): string | undefined {
    const parts = value.split('.');
    return parts.length === 5 && parts[0] === SCHEME ? parts[1] : undefined;
  }

  /** Decrypt then re-encrypt under the current key. No-op if already current. */
  rotate(value: string): string {
    if (this.keyIdOf(value) === this.keys.currentKeyId) return value;
    return this.encrypt(this.decrypt(value));
  }
}

let cached: Encryptor | undefined;

export function getEncryptor(): Encryptor {
  if (!cached) {
    const { crypto } = getConfig();
    cached = new Encryptor(new EnvKeyProvider(crypto.keyId, crypto.key));
  }
  return cached;
}

/** Test-only. */
export function resetEncryptorForTests(): void {
  cached = undefined;
}

/** Constant-time string comparison, for signed state and webhook signatures. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Generate a key suitable for `ENCRYPTION_KEY`. Used by the docs and by tests. */
export function generateEncryptionKey(): string {
  return randomBytes(KEY_BYTES).toString('base64');
}
