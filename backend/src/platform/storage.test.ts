import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalStorageDriver, assertValidKey, buildStorageKey, createStorageDriver } from './storage';
import { loadConfig } from './config';
import { validEnv } from '../../tests/env';

describe('assertValidKey', () => {
  it('accepts ordinary keys', () => {
    expect(() => assertValidKey('workspaces/abc/renders/2024-01-01/post.png')).not.toThrow();
  });

  it.each([
    ['', 'empty'],
    ['/leading-slash', 'absolute'],
    ['a//b', 'doubled separator'],
    ['../escape', 'parent traversal'],
    ['nested/../../escape', 'nested traversal'],
    ['has space.png', 'space'],
    ['has\0null', 'null byte'],
    ['x'.repeat(513), 'too long'],
  ])('rejects %s (%s)', (key) => {
    expect(() => assertValidKey(key)).toThrow();
  });
});

describe('buildStorageKey', () => {
  it('scopes keys by workspace so one tenant cannot name another tenant object', () => {
    const key = buildStorageKey({ workspaceId: 'ws_1', kind: 'renders', extension: 'png' });
    expect(key.startsWith('ws_1/renders/')).toBe(true);
    expect(key.endsWith('.png')).toBe(true);
    expect(() => assertValidKey(key)).not.toThrow();
  });
});

describe('LocalStorageDriver', () => {
  let root: string;
  let driver: LocalStorageDriver;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'buzz-storage-'));
    driver = new LocalStorageDriver(root, 'http://127.0.0.1:3001', 'signing-key-for-tests', 300);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('round-trips an object', async () => {
    const body = Buffer.from('rendered png bytes');
    const stored = await driver.put('renders/a/post.png', body, { contentType: 'image/png' });

    expect(stored.size).toBe(body.byteLength);
    expect(await driver.get('renders/a/post.png')).toEqual(body);
  });

  it('creates intermediate directories', async () => {
    await driver.put('deeply/nested/path/file.txt', Buffer.from('ok'));
    expect(await driver.exists('deeply/nested/path/file.txt')).toBe(true);
  });

  it('reports a missing object as not found rather than a raw ENOENT', async () => {
    await expect(driver.get('missing/file.png')).rejects.toThrow(/not found/i);
    expect(await driver.exists('missing/file.png')).toBe(false);
  });

  it('deletes, and deleting twice is not an error', async () => {
    await driver.put('temp/file.txt', Buffer.from('x'));
    await driver.delete('temp/file.txt');
    expect(await driver.exists('temp/file.txt')).toBe(false);
    await expect(driver.delete('temp/file.txt')).resolves.toBeUndefined();
  });

  it('refuses to read outside its root', async () => {
    await expect(driver.get('../../etc/passwd')).rejects.toThrow();
  });

  describe('signed URLs', () => {
    it('produces a verifiable URL', async () => {
      const url = new URL(await driver.signedUrl('renders/a/post.png'));
      const expires = Number(url.searchParams.get('expires'));
      const signature = url.searchParams.get('signature') ?? '';

      expect(url.pathname).toBe('/api/files/renders/a/post.png');
      expect(driver.verify('renders/a/post.png', expires, signature)).toBe(true);
    });

    it('rejects a signature for a different key', async () => {
      const url = new URL(await driver.signedUrl('renders/a/post.png'));
      const expires = Number(url.searchParams.get('expires'));
      const signature = url.searchParams.get('signature') ?? '';

      // Otherwise one valid URL is a valid URL for every object in the bucket.
      expect(driver.verify('renders/b/other.png', expires, signature)).toBe(false);
    });

    it('rejects a tampered expiry', async () => {
      const url = new URL(await driver.signedUrl('renders/a/post.png'));
      const signature = url.searchParams.get('signature') ?? '';
      const extended = Math.floor(Date.now() / 1000) + 86_400;

      expect(driver.verify('renders/a/post.png', extended, signature)).toBe(false);
    });

    it('rejects an expired URL', () => {
      const past = Math.floor(Date.now() / 1000) - 10;
      expect(driver.verify('renders/a/post.png', past, driver.sign('renders/a/post.png', past))).toBe(
        false,
      );
    });

    it('rejects a forged signature', () => {
      const expires = Math.floor(Date.now() / 1000) + 300;
      expect(driver.verify('renders/a/post.png', expires, 'forged')).toBe(false);
    });
  });
});

describe('createStorageDriver', () => {
  it('returns the local driver outside production', () => {
    expect(createStorageDriver(loadConfig(validEnv())).kind).toBe('local');
  });

  it('returns the R2 driver when configured', () => {
    const config = loadConfig(
      validEnv({
        STORAGE_DRIVER: 'r2',
        R2_ENDPOINT: 'https://account.r2.cloudflarestorage.com',
        R2_BUCKET: 'buzz-media',
        R2_ACCESS_KEY_ID: 'key',
        R2_SECRET_ACCESS_KEY: 'secret',
      }),
    );

    expect(createStorageDriver(config).kind).toBe('r2');
  });
});
