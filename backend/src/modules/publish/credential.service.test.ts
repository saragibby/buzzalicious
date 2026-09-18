import { describe, expect, it } from 'vitest';
import type { PlatformCredential } from '@prisma/client';
import { containsSecretField, maskSecret, toCredentialView } from './credential.service';
import { CredentialSecretFields } from './credential.schemas';

/**
 * The read layer for credentials.
 *
 * The single rule this file exists to enforce is that a plaintext secret never leaves the
 * service. docs/10 is unambiguous: client platform app secrets are never logged, never
 * returned by an API and never placed in a job payload. `toCredentialView` is the only
 * shape the HTTP layer is allowed to serialise, so if a secret can survive that function
 * it can reach a browser.
 */

function credential(overrides: Partial<PlatformCredential> = {}): PlatformCredential {
  return {
    id: 'cred-1',
    workspaceId: 'ws-1',
    brandId: 'brand-1',
    platform: 'X',
    mode: 'CLIENT_APP',
    label: 'Marketing X app',
    appId: 'app-id',
    appSecret: 'sk-live-abcdefghijkl',
    redirectUri: 'https://example.test/cb',
    directToken: null,
    directTokenSecret: null,
    systemUserToken: null,
    tokenExpiresAt: null,
    grantedScopes: [],
    requiredScopes: [],
    capabilities: null,
    status: 'ACTIVE',
    lastError: null,
    lastValidatedAt: null,
    createdAt: new Date('2025-01-01T00:00:00Z'),
    updatedAt: new Date('2025-01-01T00:00:00Z'),
    ...overrides,
  } as PlatformCredential;
}

describe('maskSecret', () => {
  it('keeps only the last four characters', () => {
    // Enough to let a client confirm *which* secret is stored without revealing it.
    expect(maskSecret('sk-live-abcdefghijkl')).toBe('••••••••ijkl');
  });

  it('reveals nothing at all for a short value', () => {
    // Four of eight characters is half the secret. A short value is masked completely.
    const masked = maskSecret('short');
    expect(masked).toBe('••••••••');
    expect(masked).not.toContain('ort');
  });

  it('returns null rather than a mask for an absent value', () => {
    // A mask would claim a secret exists. The UI renders "not set" from null.
    expect(maskSecret(null)).toBeNull();
    expect(maskSecret(undefined)).toBeNull();
    expect(maskSecret('')).toBeNull();
  });
});

describe('toCredentialView', () => {
  it('does not carry any secret value, at any depth', () => {
    const row = credential({
      appSecret: 'sk-live-abcdefghijkl',
      directToken: 'dt-aaaaaaaaaaaa',
      directTokenSecret: 'dts-bbbbbbbbbbbb',
      systemUserToken: 'sut-cccccccccccc',
    });

    const view = toCredentialView(row);
    const serialised = JSON.stringify(view);

    // Serialise and search, rather than checking named keys. A future field added to the
    // view would bypass a key-by-key assertion; it cannot bypass this one.
    for (const secret of [
      row.appSecret,
      row.directToken,
      row.directTokenSecret,
      row.systemUserToken,
    ]) {
      expect(serialised).not.toContain(secret!);
    }

    // Control: the view is not simply empty. Without this, the loop above would pass for
    // a function that returned `{}`.
    expect(view.id).toBe('cred-1');
    expect(view.appId).toBe('app-id');
    expect(view.appSecretMask).toBe('••••••••ijkl');
    expect(view.directTokenMask).toBe('••••••••aaaa');
  });

  it('exposes no key named like a secret column', () => {
    const view = toCredentialView(credential());
    for (const field of CredentialSecretFields) {
      expect(Object.keys(view)).not.toContain(field);
    }
  });

  it('computes days to expiry relative to the supplied clock', () => {
    const now = new Date('2025-06-01T00:00:00Z');
    const view = toCredentialView(
      credential({ tokenExpiresAt: new Date('2025-06-11T00:00:00Z') }),
      now,
    );
    // Ten days: the number the connections page turns amber on.
    expect(view.expiresInDays).toBe(10);
  });

  it('reports a negative number for an already-expired token', () => {
    const now = new Date('2025-06-01T00:00:00Z');
    const view = toCredentialView(
      credential({ tokenExpiresAt: new Date('2025-05-30T00:00:00Z') }),
      now,
    );
    // Not clamped to zero. "Expired two days ago" and "expires today" need different copy.
    expect(view.expiresInDays).toBeLessThan(0);
  });

  it('reports null days when the token does not expire', () => {
    expect(toCredentialView(credential({ tokenExpiresAt: null })).expiresInDays).toBeNull();
  });
});

describe('containsSecretField', () => {
  it('finds a secret key nested inside a job payload', () => {
    // The shape this guards against: someone puts the resolved credential into a pg-boss
    // payload for convenience, and it is written to a Postgres table in plaintext.
    expect(containsSecretField({ targetId: 't1', credential: { appSecret: 'x' } })).toBe(
      'appSecret',
    );
  });

  it('finds a secret key inside an array element', () => {
    expect(containsSecretField({ items: [{ ok: 1 }, { directToken: 'x' }] })).toBe('directToken');
  });

  it('returns null for a payload that carries only identifiers', () => {
    // The control, and the shape every queue payload in this workstream actually uses.
    expect(containsSecretField({ targetId: 't1', credentialId: 'c1', attempt: 2 })).toBeNull();
  });

  it('detects every declared secret field', () => {
    // Iterating the exported list means adding a secret column to the schema without
    // adding it here cannot silently pass.
    for (const field of CredentialSecretFields) {
      expect(containsSecretField({ [field]: 'value' })).toBe(field);
    }
  });
});
