import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { Encryptor, EnvKeyProvider, generateEncryptionKey } from './crypto';
import { EncryptedFieldFilterError, createEncryptionExtension } from './prisma-encryption';

/**
 * These exercise the extension's argument handling without a database: the query function
 * is stubbed, so what is asserted is exactly what would have been sent to Postgres.
 *
 * The complementary test — that the bytes actually in the column are unreadable — needs a
 * real database and lives in `tests/db/encryption.db.test.ts`. Both are necessary: this
 * one pins the behaviour, that one pins the outcome.
 */

const encryptor = new Encryptor(new EnvKeyProvider('k-test', generateEncryptionKey()));

/**
 * Build a client whose queries never reach a database. `$extends` returns a proxy over the
 * real client, so the extension runs exactly as it would in production.
 */
function stubbedClient(result: unknown = {}) {
  const captured: { args?: unknown } = {};
  const prisma = new PrismaClient({ datasources: { db: { url: 'postgresql://unused/db' } } });

  const extended = prisma.$extends(createEncryptionExtension(encryptor)).$extends({
    query: {
      $allModels: {
        $allOperations({ args }) {
          captured.args = args;
          return Promise.resolve(structuredClone(result));
        },
      },
    },
  });

  return { client: extended, captured };
}

describe('the Prisma encryption extension', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('encrypts token fields before they reach the database', async () => {
    const { client, captured } = stubbedClient();

    await client.socialAccount.create({
      data: {
        brandId: 'brand-1',
        platform: 'INSTAGRAM',
        externalId: 'ig-1',
        accessToken: 'plaintext-access-token',
        refreshToken: 'plaintext-refresh-token',
      },
    });

    const data = (captured.args as { data: Record<string, string> }).data;
    expect(data.accessToken).not.toContain('plaintext');
    expect(encryptor.decrypt(data.accessToken)).toBe('plaintext-access-token');
    expect(encryptor.decrypt(data.refreshToken)).toBe('plaintext-refresh-token');
    // Non-secret fields are untouched, so queries on them keep working.
    expect(data.externalId).toBe('ig-1');
  });

  it('encrypts both halves of an upsert', async () => {
    const { client, captured } = stubbedClient();

    await client.platformCredential.upsert({
      where: { id: 'cred-1' },
      create: {
        id: 'cred-1',
        workspaceId: 'ws-1',
        platform: 'X',
        mode: 'DIRECT_TOKEN',
        label: 'Seed',
        directToken: 'created-token',
      },
      update: { directToken: 'updated-token' },
    });

    const args = captured.args as {
      create: Record<string, string>;
      update: Record<string, string>;
    };
    expect(encryptor.decrypt(args.create.directToken)).toBe('created-token');
    expect(encryptor.decrypt(args.update.directToken)).toBe('updated-token');
  });

  it('handles the `{ set: value }` update shorthand', async () => {
    const { client, captured } = stubbedClient();

    await client.socialAccount.update({
      where: { id: 'sa-1' },
      data: { accessToken: { set: 'rotated-token' } },
    });

    const data = (captured.args as { data: { accessToken: { set: string } } }).data;
    expect(encryptor.decrypt(data.accessToken.set)).toBe('rotated-token');
  });

  it('does not re-encrypt a value that is already ciphertext', async () => {
    // The seed upserts the same row on every run, and rotate-on-use refresh writes a value
    // that may already have been through the extension. Double-encrypting would produce a
    // value that decrypts to ciphertext — recoverable, but only by someone who guessed.
    const already = encryptor.encrypt('already-encrypted');
    const { client, captured } = stubbedClient();

    await client.socialAccount.update({
      where: { id: 'sa-1' },
      data: { accessToken: already },
    });

    const data = (captured.args as { data: Record<string, string> }).data;
    expect(data.accessToken).toBe(already);
    expect(encryptor.decrypt(data.accessToken)).toBe('already-encrypted');
  });

  it('decrypts on read', async () => {
    const { client } = stubbedClient({
      id: 'sa-1',
      accessToken: encryptor.encrypt('a-token'),
      tokenSecret: null,
    });

    const account = await client.socialAccount.findUnique({ where: { id: 'sa-1' } });
    expect(account?.accessToken).toBe('a-token');
  });

  it('decrypts through a nested include', async () => {
    // The obvious implementation only walks the top-level result, which works until the
    // first `include: { socialAccounts: true }` hands an adapter ciphertext.
    const { client } = stubbedClient({
      id: 'brand-1',
      socialAccounts: [{ id: 'sa-1', accessToken: encryptor.encrypt('nested-token') }],
    });

    const brand = (await client.brand.findUnique({
      where: { id: 'brand-1' },
      include: { socialAccounts: true },
    })) as unknown as { socialAccounts: { accessToken: string }[] };

    expect(brand.socialAccounts[0]?.accessToken).toBe('nested-token');
  });

  it('decrypts every row of a findMany', async () => {
    const { client } = stubbedClient([
      { id: 'sa-1', accessToken: encryptor.encrypt('one') },
      { id: 'sa-2', accessToken: encryptor.encrypt('two') },
    ]);

    const accounts = await client.socialAccount.findMany();
    expect(accounts.map((account) => account.accessToken)).toEqual(['one', 'two']);
  });

  it('refuses to filter on an encrypted field', async () => {
    // GCM output is non-deterministic, so this filter cannot match — and would report "no
    // such account" rather than failing. Silence is the dangerous outcome here.
    const { client } = stubbedClient();

    await expect(
      client.socialAccount.findFirst({ where: { accessToken: 'plaintext-access-token' } }),
    ).rejects.toThrow(EncryptedFieldFilterError);
  });

  it('refuses a filter nested inside AND/OR', async () => {
    const { client } = stubbedClient();

    await expect(
      client.platformCredential.findMany({
        where: { OR: [{ status: 'ACTIVE' }, { directToken: 'abc' }] },
      }),
    ).rejects.toThrow(EncryptedFieldFilterError);
  });

  it('leaves models with no encrypted fields alone', async () => {
    const { client, captured } = stubbedClient();

    await client.brand.create({
      data: {
        workspaceId: 'ws-1',
        name: 'Rise & Shore',
        slug: 'rise-and-shore',
        palette: {},
        typography: {},
        voiceGuide: {},
      },
    });

    expect((captured.args as { data: { name: string } }).data.name).toBe('Rise & Shore');
  });
});
