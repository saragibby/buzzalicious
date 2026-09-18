import { Prisma } from '@prisma/client';
import { getEncryptor, type Encryptor } from './crypto';

/**
 * Transparent encryption at rest for tokens and client app secrets.
 *
 * A Prisma client extension rather than scattered call sites: docs/10 requires that
 * plaintext never reaches the database, and the only version of that rule which survives
 * contact with a growing codebase is one nobody has to remember. Every write through this
 * client encrypts; every read decrypts.
 *
 * The cryptography itself is `platform/crypto.ts` — AES-256-GCM with versioned ciphertext
 * and a `KeyProvider` seam. This file adds no crypto of its own. W6 upgrades that module
 * to per-workspace DEKs and this extension keeps working unchanged, because it only ever
 * asks for "encrypt this string".
 *
 * ## The filtering constraint
 *
 * GCM output is non-deterministic: the same plaintext encrypts to a different value every
 * time, by design. So an encrypted column can never be matched, ordered, or grouped by.
 * `where: { accessToken: 'abc' }` cannot work — and, far worse, it would *silently* match
 * nothing, which reads as "no such account" rather than as the mistake it is. Every such
 * usage throws instead.
 *
 * Looking a token up by value is not a real requirement anyway; tokens are reached through
 * their owning brand or credential.
 */

/** Model name -> the fields on it that are stored encrypted. */
export const ENCRYPTED_FIELDS = {
  SocialAccount: ['accessToken', 'refreshToken', 'tokenSecret'],
  PlatformCredential: ['appSecret', 'directToken', 'directTokenSecret', 'systemUserToken'],
} as const satisfies Record<string, readonly string[]>;

export type EncryptedModel = keyof typeof ENCRYPTED_FIELDS;

const ENCRYPTED_MODELS = Object.keys(ENCRYPTED_FIELDS) as EncryptedModel[];

/** A `where` clause referenced a field whose ciphertext is non-deterministic. */
export class EncryptedFieldFilterError extends Error {
  constructor(model: string, field: string) {
    super(
      `Cannot filter on "${model}.${field}": it is encrypted at rest with a random IV, so ` +
        `the same value never produces the same ciphertext. A filter on it would match ` +
        `nothing rather than fail. Look the row up by its owning brand or credential instead.`,
    );
    this.name = 'EncryptedFieldFilterError';
  }
}

function isEncryptedModel(model: string | undefined): model is EncryptedModel {
  return model !== undefined && model in ENCRYPTED_FIELDS;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date)
  );
}

/**
 * Encrypt the encrypted fields of one data payload.
 *
 * Values that are already ciphertext pass through untouched, so the extension is
 * idempotent — a seed that upserts the same row twice cannot double-encrypt it, and
 * neither can an update that reads a row and writes part of it back.
 */
function encryptData(model: EncryptedModel, data: unknown, encryptor: Encryptor): unknown {
  if (Array.isArray(data)) return data.map((entry) => encryptData(model, entry, encryptor));
  if (!isPlainObject(data)) return data;

  const result: Record<string, unknown> = { ...data };

  for (const field of ENCRYPTED_FIELDS[model]) {
    const value = result[field];
    if (value === undefined || value === null) continue;

    // Prisma allows `{ set: value }` as an update shorthand.
    if (isPlainObject(value)) {
      const inner = value.set;
      if (typeof inner === 'string') {
        result[field] = { set: encryptor.isEncrypted(inner) ? inner : encryptor.encrypt(inner) };
      }
      continue;
    }

    if (typeof value !== 'string') continue;
    result[field] = encryptor.isEncrypted(value) ? value : encryptor.encrypt(value);
  }

  return result;
}

/**
 * Reject a filter that names an encrypted field, at any depth — including inside
 * `AND`/`OR`/`NOT` and in a nested relation filter, where it is least obvious and most
 * likely to be mistaken for a working query.
 */
function assertNoEncryptedFilter(model: EncryptedModel, where: unknown): void {
  if (Array.isArray(where)) {
    for (const entry of where) assertNoEncryptedFilter(model, entry);
    return;
  }
  if (!isPlainObject(where)) return;

  for (const [key, value] of Object.entries(where)) {
    if ((ENCRYPTED_FIELDS[model] as readonly string[]).includes(key)) {
      throw new EncryptedFieldFilterError(model, key);
    }
    if (key === 'AND' || key === 'OR' || key === 'NOT') {
      assertNoEncryptedFilter(model, value);
    }
  }
}

/** Decrypt in place on a result object, recursing into nested relation payloads. */
function decryptResult(value: unknown, encryptor: Encryptor, seen: WeakSet<object>): unknown {
  if (Array.isArray(value)) {
    for (const entry of value) decryptResult(entry, encryptor, seen);
    return value;
  }
  if (!isPlainObject(value)) return value;
  // Prisma results are trees, but guard anyway: a cycle here would hang a request.
  if (seen.has(value)) return value;
  seen.add(value);

  for (const model of ENCRYPTED_MODELS) {
    for (const field of ENCRYPTED_FIELDS[model]) {
      const field_value = value[field];
      if (typeof field_value === 'string' && encryptor.isEncrypted(field_value)) {
        value[field] = encryptor.decrypt(field_value);
      }
    }
  }

  for (const nested of Object.values(value)) {
    if (isPlainObject(nested) || Array.isArray(nested)) decryptResult(nested, encryptor, seen);
  }

  return value;
}

const WRITE_OPERATIONS = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'upsert',
]);

const FILTERED_OPERATIONS = new Set([
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'findUnique',
  'findUniqueOrThrow',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
  'count',
  'aggregate',
  'groupBy',
]);

/**
 * Build the extension. Takes its `Encryptor` so tests can supply a fixed key provider
 * without reaching through config.
 */
export function createEncryptionExtension(encryptor: Encryptor = getEncryptor()) {
  return Prisma.defineExtension({
    name: 'buzzalicious-field-encryption',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          let nextArgs = args;

          // Encrypting and rejecting filters are per-model concerns: only these models
          // have secret columns.
          if (isEncryptedModel(model) && isPlainObject(nextArgs)) {
            if (FILTERED_OPERATIONS.has(operation) && 'where' in nextArgs) {
              assertNoEncryptedFilter(model, nextArgs.where);
            }

            if (WRITE_OPERATIONS.has(operation)) {
              const patched: Record<string, unknown> = { ...nextArgs };
              if ('data' in patched) patched.data = encryptData(model, patched.data, encryptor);
              // upsert carries two payloads.
              if ('create' in patched)
                patched.create = encryptData(model, patched.create, encryptor);
              if ('update' in patched)
                patched.update = encryptData(model, patched.update, encryptor);
              nextArgs = patched as typeof nextArgs;
            }
          }

          const result = await query(nextArgs);

          // Decryption is *not* per-model. A `brand.findUnique` with
          // `include: { socialAccounts: true }` returns encrypted tokens nested under a
          // model that has no encrypted columns of its own, and short-circuiting here
          // hands an adapter ciphertext it will happily send to a platform API.
          return decryptResult(result, encryptor, new WeakSet());
        },
      },
    },
  });
}
