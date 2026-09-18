import { createHmac, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rm, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getConfig, type Config } from './config';
import { safeEqual } from './crypto';
import { NotFoundError, ValidationError } from './errors';

/**
 * Object storage behind an interface, so local development never needs R2 credentials
 * (docs/01-architecture.md) and so the render pipeline has one place to write to.
 *
 * Signed, time-limited URLs are not a nicety: Meta fetches media **by URL**, so a
 * rendition has to be reachable by a third party without being permanently public.
 */

export interface PutOptions {
  contentType?: string;
  /** Cache-Control for the stored object. Renditions are immutable, so this is usually long. */
  cacheControl?: string;
}

export interface StoredObject {
  key: string;
  size: number;
  contentType?: string;
}

export interface StorageDriver {
  readonly kind: 'local' | 'r2';
  put(key: string, body: Buffer, options?: PutOptions): Promise<StoredObject>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  /** A URL a third party can fetch for `ttlSeconds`. */
  signedUrl(key: string, ttlSeconds?: number): Promise<string>;
}

/**
 * Keys are the only untrusted input the drivers take, and the local driver turns them
 * into filesystem paths. Reject anything that could escape the root before it gets there.
 */
export function assertValidKey(key: string): void {
  if (!key || key.length > 512) {
    throw new ValidationError('Storage key must be between 1 and 512 characters');
  }
  if (!/^[A-Za-z0-9!_.*'()/-]+$/.test(key)) {
    throw new ValidationError('Storage key contains unsupported characters');
  }
  if (key.startsWith('/') || key.includes('..') || key.includes('//')) {
    throw new ValidationError('Storage key must be a normalised relative path');
  }
}

/**
 * Filesystem-backed, for local development only.
 *
 * Refuses to be constructed in production. Heroku's filesystem is ephemeral, so files
 * written here vanish on the next dyno restart — a data-loss bug that would otherwise
 * only show up hours later. `config.ts` rejects the combination at boot as well; this is
 * the second lock on the same door because the consequence is silent.
 *
 * Signing is HMAC over `key` and expiry, verified by the file route in
 * `http/routes/files.routes.ts`. It mirrors the shape of a presigned S3 URL so calling
 * code cannot tell the drivers apart.
 */
export class LocalStorageDriver implements StorageDriver {
  readonly kind = 'local' as const;

  private readonly root: string;

  constructor(
    root: string,
    private readonly baseUrl: string,
    private readonly signingKey: string,
    private readonly defaultTtlSeconds: number,
  ) {
    this.root = path.resolve(root);
  }

  private pathFor(key: string): string {
    assertValidKey(key);
    const resolved = path.resolve(this.root, key);
    // Belt and braces: even with a validated key, never return a path outside the root.
    if (resolved !== this.root && !resolved.startsWith(this.root + path.sep)) {
      throw new ValidationError('Storage key resolves outside the storage root');
    }
    return resolved;
  }

  async put(key: string, body: Buffer, options?: PutOptions): Promise<StoredObject> {
    const file = this.pathFor(key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, body);
    return { key, size: body.byteLength, contentType: options?.contentType };
  }

  async get(key: string): Promise<Buffer> {
    try {
      return await readFile(this.pathFor(key));
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new NotFoundError('Stored object', { cause });
      }
      throw cause;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  async exists(key: string): Promise<boolean> {
    try {
      const info = await stat(this.pathFor(key));
      return info.isFile();
    } catch {
      return false;
    }
  }

  async signedUrl(key: string, ttlSeconds?: number): Promise<string> {
    assertValidKey(key);
    const expires = Math.floor(Date.now() / 1000) + (ttlSeconds ?? this.defaultTtlSeconds);
    const signature = this.sign(key, expires);
    const url = new URL(`${this.baseUrl}/api/files/${key}`);
    url.searchParams.set('expires', String(expires));
    url.searchParams.set('signature', signature);
    return url.toString();
  }

  sign(key: string, expires: number): string {
    return createHmac('sha256', this.signingKey).update(`${key}:${expires}`).digest('base64url');
  }

  /** Verify a signature produced by `signedUrl`. Returns why it failed, for logging. */
  verify(key: string, expires: number, signature: string): boolean {
    if (!Number.isFinite(expires) || expires < Math.floor(Date.now() / 1000)) return false;
    return safeEqual(this.sign(key, expires), signature);
  }

  /** Streaming read, so the file route does not buffer a whole rendition into memory. */
  createReadStream(key: string): Readable {
    return createReadStream(this.pathFor(key));
  }
}

/** Cloudflare R2 over the S3 API. Zero egress, which matters when every post serves images. */
export class R2StorageDriver implements StorageDriver {
  readonly kind = 'r2' as const;

  private readonly client: S3Client;

  constructor(
    private readonly bucket: string,
    options: {
      endpoint: string;
      region: string;
      accessKeyId: string;
      secretAccessKey: string;
    },
    private readonly defaultTtlSeconds: number,
  ) {
    this.client = new S3Client({
      endpoint: options.endpoint,
      region: options.region,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
    });
  }

  async put(key: string, body: Buffer, options?: PutOptions): Promise<StoredObject> {
    assertValidKey(key);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: options?.contentType,
        CacheControl: options?.cacheControl,
      }),
    );
    return { key, size: body.byteLength, contentType: options?.contentType };
  }

  async get(key: string): Promise<Buffer> {
    assertValidKey(key);
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      const bytes = await result.Body?.transformToByteArray();
      if (!bytes) throw new NotFoundError('Stored object');
      return Buffer.from(bytes);
    } catch (cause) {
      if ((cause as { name?: string }).name === 'NoSuchKey') {
        throw new NotFoundError('Stored object', { cause });
      }
      throw cause;
    }
  }

  async delete(key: string): Promise<void> {
    assertValidKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.get(key);
      return true;
    } catch {
      return false;
    }
  }

  async signedUrl(key: string, ttlSeconds?: number): Promise<string> {
    assertValidKey(key);
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: ttlSeconds ?? this.defaultTtlSeconds,
    });
  }
}

export function createStorageDriver(config: Config = getConfig()): StorageDriver {
  const { storage } = config;

  if (storage.driver === 'r2') {
    // config.ts guarantees these are present when the driver is r2.
    return new R2StorageDriver(
      storage.r2.bucket!,
      {
        endpoint: storage.r2.endpoint!,
        region: storage.r2.region,
        accessKeyId: storage.r2.accessKeyId!,
        secretAccessKey: storage.r2.secretAccessKey!,
      },
      storage.signedUrlTtlSeconds,
    );
  }

  if (config.isProduction) {
    throw new Error(
      'Refusing to use the local storage driver in production: the dyno filesystem is ephemeral.',
    );
  }

  return new LocalStorageDriver(
    storage.localDir,
    config.appUrl,
    config.session.secret,
    storage.signedUrlTtlSeconds,
  );
}

let cached: StorageDriver | undefined;

export function getStorage(): StorageDriver {
  cached ??= createStorageDriver();
  return cached;
}

/** Test-only. */
export function resetStorageForTests(): void {
  cached = undefined;
}

/** Collision-resistant key for a new object, namespaced by workspace. */
export function buildStorageKey(parts: {
  workspaceId: string;
  kind: string;
  extension: string;
}): string {
  const id = randomBytes(16).toString('hex');
  const extension = parts.extension.replace(/^\./, '');
  return `${parts.workspaceId}/${parts.kind}/${id}.${extension}`;
}
