import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CredentialMode, CredentialStatus, Platform } from '@prisma/client';
import { disconnectPrisma, getPrisma, type Db } from '../../src/platform/db';
import { EncryptedFieldFilterError } from '../../src/platform/prisma-encryption';
import { DecryptionError } from '../../src/platform/crypto';
import { hasTestDatabase } from '../env';

/**
 * Encryption, asserted against the database rather than through the codec.
 *
 * A round-trip test through our own encrypt/decrypt passes even if the column holds
 * plaintext, so the load-bearing assertion here is the one made with `$queryRaw`: read the
 * stored bytes and check they are not the secret. That is the acceptance criterion in
 * docs/10 and the only version of it that cannot pass vacuously.
 */

const PLAINTEXT_TOKEN = 'test-plaintext-token-do-not-store-like-this';

describe.skipIf(!hasTestDatabase)('encryption at rest', () => {
  let db: Db;
  let workspaceId: string;
  let credentialId: string;

  beforeAll(async () => {
    db = getPrisma();

    const workspace = await db.workspace.create({
      data: { name: 'Encryption fixture', slug: `enc-${Date.now()}` },
    });
    workspaceId = workspace.id;

    const credential = await db.platformCredential.create({
      data: {
        workspaceId,
        platform: Platform.X,
        mode: CredentialMode.DIRECT_TOKEN,
        label: 'Encryption fixture credential',
        directToken: PLAINTEXT_TOKEN,
        appSecret: 'test-plaintext-app-secret',
        grantedScopes: [],
        requiredScopes: [],
        status: CredentialStatus.ACTIVE,
      },
    });
    credentialId = credential.id;
  });

  afterAll(async () => {
    await db.workspace.deleteMany({ where: { id: workspaceId } });
    await disconnectPrisma();
  });

  it('stores ciphertext, not the secret', async () => {
    const [row] = await db.$queryRaw<{ directToken: string; appSecret: string }[]>`
      SELECT "directToken", "appSecret" FROM platform_credentials WHERE id = ${credentialId}
    `;

    expect(row?.directToken).toBeTruthy();
    expect(row?.directToken).not.toContain(PLAINTEXT_TOKEN);
    expect(row?.appSecret).not.toContain('plaintext');
  });

  it('tags the ciphertext with a version and key id so rotation can be incremental', async () => {
    const [row] = await db.$queryRaw<{ directToken: string }[]>`
      SELECT "directToken" FROM platform_credentials WHERE id = ${credentialId}
    `;

    // W6 upgrades this to per-workspace DEKs. That is an incremental re-encryption rather
    // than a rewrite only because every value says which scheme wrote it.
    expect(row?.directToken).toMatch(/^v1\.k1\./);
  });

  it('decrypts transparently on read', async () => {
    const credential = await db.platformCredential.findUniqueOrThrow({
      where: { id: credentialId },
    });
    expect(credential.directToken).toBe(PLAINTEXT_TOKEN);
  });

  it('decrypts through a relation include', async () => {
    const account = await db.socialAccount.create({
      data: {
        brand: {
          create: {
            workspaceId,
            name: 'Encryption fixture brand',
            slug: 'enc-fixture',
            palette: {},
            typography: {},
            voiceGuide: {},
          },
        },
        platform: Platform.X,
        externalId: 'enc-fixture-account',
        accessToken: 'nested-plaintext-token',
        credential: { connect: { id: credentialId } },
      },
    });

    const credential = await db.platformCredential.findUniqueOrThrow({
      where: { id: credentialId },
      include: { socialAccounts: true },
    });

    // The failure this guards: the include returns a *different* model's secrets, and an
    // extension that only decrypts the top level hands an adapter ciphertext it will send
    // to a platform API verbatim.
    expect(credential.socialAccounts[0]?.accessToken).toBe('nested-plaintext-token');

    await db.socialAccount.delete({ where: { id: account.id } });
  });

  it('does not re-encrypt a value that is already ciphertext', async () => {
    const stored = await db.platformCredential.findUniqueOrThrow({ where: { id: credentialId } });

    // A read-modify-write, which is what an "update everything I was sent" handler does.
    await db.platformCredential.update({
      where: { id: credentialId },
      data: { directToken: stored.directToken, label: 'Touched' },
    });

    const reread = await db.platformCredential.findUniqueOrThrow({ where: { id: credentialId } });
    expect(reread.directToken).toBe(PLAINTEXT_TOKEN);
  });

  it('refuses to filter on an encrypted column', async () => {
    // AES-GCM is non-deterministic, so this can never match. Returning "no such
    // credential" would be a silently wrong answer; failing loudly is the lesser evil.
    await expect(
      db.platformCredential.findFirst({ where: { directToken: PLAINTEXT_TOKEN } }),
    ).rejects.toThrow(EncryptedFieldFilterError);
  });

  it('refuses a filter nested inside a boolean combinator', async () => {
    await expect(
      db.platformCredential.findFirst({
        where: { AND: [{ status: CredentialStatus.ACTIVE }, { appSecret: 'anything' }] },
      }),
    ).rejects.toThrow(EncryptedFieldFilterError);
  });

  it('detects tampering rather than returning altered plaintext', async () => {
    const victim = await db.platformCredential.create({
      data: {
        workspaceId,
        platform: Platform.THREADS,
        mode: CredentialMode.DIRECT_TOKEN,
        label: 'Tamper fixture',
        directToken: 'original-value',
        grantedScopes: [],
        requiredScopes: [],
      },
    });

    const [row] = await db.$queryRaw<{ directToken: string }[]>`
      SELECT "directToken" FROM platform_credentials WHERE id = ${victim.id}
    `;
    // Corrupt the ciphertext body, leaving the scheme header and IV intact, so what fails
    // is the authentication tag rather than the format check.
    const parts = row!.directToken.split('.');
    const body = parts[4]!;
    const first = body.slice(0, 1);
    parts[4] = (first === 'A' ? 'B' : 'A') + body.slice(1);
    const tampered = parts.join('.');

    await db.$executeRaw`
      UPDATE platform_credentials SET "directToken" = ${tampered} WHERE id = ${victim.id}
    `;

    // The authentication tag is the point: without it, anyone with write access to the
    // database could alter a stored token and we would use the altered value.
    await expect(
      db.platformCredential.findUniqueOrThrow({ where: { id: victim.id } }),
    ).rejects.toThrow(DecryptionError);

    // `delete` returns the row, which would decrypt — and fail. `deleteMany` returns a
    // count, which is the right tool for discarding a deliberately corrupted record.
    await db.platformCredential.deleteMany({ where: { id: victim.id } });
  });
});
