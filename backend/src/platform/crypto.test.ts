import { describe, expect, it } from 'vitest';
import {
  DecryptionError,
  EnvKeyProvider,
  Encryptor,
  UnknownKeyError,
  generateEncryptionKey,
  safeEqual,
} from './crypto';

const keyA = generateEncryptionKey();
const keyB = generateEncryptionKey();

function encryptorWith(currentId: string, currentKey: string, previous = {}) {
  return new Encryptor(new EnvKeyProvider(currentId, currentKey, previous));
}

describe('Encryptor', () => {
  const encryptor = encryptorWith('k1', keyA);

  it('round-trips a value', () => {
    const secret = 'oauth-access-token-value';
    expect(encryptor.decrypt(encryptor.encrypt(secret))).toBe(secret);
  });

  it('round-trips unicode and empty values', () => {
    for (const value of ['', 'ünïcödé — ✨', 'x'.repeat(10_000)]) {
      expect(encryptor.decrypt(encryptor.encrypt(value))).toBe(value);
    }
  });

  it('produces different ciphertext for the same plaintext', () => {
    // A fresh IV per encryption. Identical ciphertext would reveal that two workspaces
    // had stored the same secret.
    expect(encryptor.encrypt('same')).not.toBe(encryptor.encrypt('same'));
  });

  it('labels ciphertext with the scheme and key id', () => {
    const [scheme, keyId, ...rest] = encryptor.encrypt('value').split('.');
    expect(scheme).toBe('v1');
    expect(keyId).toBe('k1');
    expect(rest).toHaveLength(3);
  });

  it('never emits the plaintext in the ciphertext', () => {
    expect(encryptor.encrypt('hunter2')).not.toContain('hunter2');
  });

  describe('tamper detection', () => {
    it('rejects a modified ciphertext body', () => {
      const parts = encryptor.encrypt('value').split('.');
      parts[4] = Buffer.from('tampered-with-payload').toString('base64url');
      expect(() => encryptor.decrypt(parts.join('.'))).toThrow(DecryptionError);
    });

    it('rejects a modified auth tag', () => {
      const parts = encryptor.encrypt('value').split('.');
      parts[3] = Buffer.alloc(16, 9).toString('base64url');
      expect(() => encryptor.decrypt(parts.join('.'))).toThrow(DecryptionError);
    });

    it('rejects a modified IV', () => {
      const parts = encryptor.encrypt('value').split('.');
      parts[2] = Buffer.alloc(12, 9).toString('base64url');
      expect(() => encryptor.decrypt(parts.join('.'))).toThrow(DecryptionError);
    });

    it('rejects a relabelled key id', () => {
      // The key id is authenticated as AAD, so swapping it is detected rather than
      // producing a confusing "unknown key" or, worse, silent garbage.
      const twoKeys = encryptorWith('k1', keyA, { k0: keyB });
      const parts = twoKeys.encrypt('value').split('.');
      parts[1] = 'k0';
      expect(() => twoKeys.decrypt(parts.join('.'))).toThrow(DecryptionError);
    });

    it('rejects an unknown scheme rather than guessing', () => {
      const parts = encryptor.encrypt('value').split('.');
      parts[0] = 'v2';
      expect(() => encryptor.decrypt(parts.join('.'))).toThrow(/scheme/);
    });

    it('rejects a malformed value', () => {
      expect(() => encryptor.decrypt('not-ciphertext')).toThrow(DecryptionError);
      expect(() => encryptor.decrypt('v1.k1.a.b')).toThrow(DecryptionError);
    });

    it('cannot be decrypted by a different key', () => {
      const other = encryptorWith('k1', keyB);
      expect(() => other.decrypt(encryptor.encrypt('value'))).toThrow(DecryptionError);
    });
  });

  describe('key rotation', () => {
    it('reads ciphertext written by a retired key', () => {
      const old = encryptorWith('k1', keyA);
      const rotated = encryptorWith('k2', keyB, { k1: keyA });

      // The point of versioning: no flag-day re-encryption.
      expect(rotated.decrypt(old.encrypt('value'))).toBe('value');
    });

    it('rewrites old ciphertext under the current key', () => {
      const old = encryptorWith('k1', keyA);
      const rotated = encryptorWith('k2', keyB, { k1: keyA });

      const rewritten = rotated.rotate(old.encrypt('value'));
      expect(rotated.keyIdOf(rewritten)).toBe('k2');
      expect(rotated.decrypt(rewritten)).toBe('value');
    });

    it('leaves current ciphertext untouched', () => {
      const current = encryptor.encrypt('value');
      expect(encryptor.rotate(current)).toBe(current);
    });

    it('reports a key it does not hold instead of failing obscurely', () => {
      const parts = encryptor.encrypt('value').split('.');
      parts[1] = 'k99';
      expect(() => encryptor.decrypt(parts.join('.'))).toThrow(UnknownKeyError);
    });
  });

  it('rejects a key of the wrong length at construction', () => {
    expect(() => new EnvKeyProvider('k1', Buffer.alloc(16).toString('base64'))).toThrow(/32 bytes/);
  });

  it('recognises its own ciphertext', () => {
    expect(encryptor.isEncrypted(encryptor.encrypt('value'))).toBe(true);
    expect(encryptor.isEncrypted('plaintext-token')).toBe(false);
  });
});

describe('safeEqual', () => {
  it('compares equal and unequal values', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
  });

  it('handles different lengths without throwing', () => {
    // `timingSafeEqual` throws on a length mismatch, which would turn a signature check
    // into a 500 for any attacker who sent a short value.
    expect(safeEqual('abc', 'abcdef')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });
});
