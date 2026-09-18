import { createHash } from 'node:crypto';
import { AssetKind, type Asset } from '@prisma/client';
import sharp, { type Metadata } from 'sharp';
import { ValidationError } from '../../platform/errors';
import { buildStorageKey, getStorage, type StorageDriver } from '../../platform/storage';
import type { ScopedDb } from '../../platform/tenancy';

/**
 * Brand asset ingestion.
 *
 * This module owns the `Asset` row and the storage key. It does not own the bytes —
 * `platform/storage.ts` does — and it does not know what a rendition is.
 *
 * Three things happen to every uploaded image before it is stored, and each is load-bearing:
 *
 *  1. **The declared MIME type is ignored.** `Content-Type` is attacker-controlled. What
 *     matters is what the bytes actually are, which is what `sharp` reports.
 *  2. **Metadata is stripped.** Phone photos carry GPS coordinates in EXIF. A small
 *     business owner uploading a photo of their shop would otherwise be publishing their
 *     location to every platform that redistributes the file. `sharp` drops all metadata
 *     unless asked to keep it, so this is the default rather than a step — but the
 *     orientation tag has to be *applied* before it is discarded, or portrait photos come
 *     out sideways.
 *  3. **Dimensions are recorded.** The render pipeline needs them, and reading them back
 *     out of storage later costs a download per post.
 */

/** Raster formats we accept, mapped to what they are stored as. */
const ACCEPTED_FORMATS: Record<string, { mimeType: string; extension: string }> = {
  jpeg: { mimeType: 'image/jpeg', extension: 'jpg' },
  png: { mimeType: 'image/png', extension: 'png' },
  webp: { mimeType: 'image/webp', extension: 'webp' },
  gif: { mimeType: 'image/gif', extension: 'gif' },
  // SVG is deliberately absent. It is a document format that can carry script and
  // external references; serving one from our own origin is a stored-XSS primitive.
  // Logos supplied as SVG should be rasterised by the client before upload.
};

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Beyond this, a logo is being used as a photo. Large enough for any real display. */
const MAX_DIMENSION = 4096;

const THUMBNAIL_SIZE = 512;

export interface UploadInput {
  buffer: Buffer;
  kind: AssetKind;
  altText?: string | null;
  tags?: string[];
  /** Original filename, used only for diagnostics. Never used to derive a storage key. */
  originalName?: string;
}

export interface ProcessedImage {
  buffer: Buffer;
  mimeType: string;
  extension: string;
  width: number;
  height: number;
  format: string;
}

/**
 * Normalize an uploaded image, or explain why it cannot be used.
 *
 * Exported separately from the storage write so it is testable without R2, a database, or
 * a request.
 */
export async function processImage(buffer: Buffer): Promise<ProcessedImage> {
  if (buffer.byteLength === 0) {
    throw new ValidationError('That file is empty');
  }

  if (buffer.byteLength > MAX_UPLOAD_BYTES) {
    throw new ValidationError(
      `That file is larger than the ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB limit`,
    );
  }

  let metadata: Metadata;
  try {
    metadata = await sharp(buffer).metadata();
  } catch {
    // sharp failing to parse is the answer: whatever this is, it is not an image we can
    // render with, whatever the upload claimed.
    throw new ValidationError('That file is not a readable image');
  }

  const format = metadata.format ?? '';
  const accepted = ACCEPTED_FORMATS[format];

  if (!accepted) {
    throw new ValidationError(
      `Images must be JPEG, PNG, WebP or GIF. That file is ${format || 'an unrecognised format'}.`,
    );
  }

  if (!metadata.width || !metadata.height) {
    throw new ValidationError('That image has no readable dimensions');
  }

  if (metadata.width > MAX_DIMENSION || metadata.height > MAX_DIMENSION) {
    throw new ValidationError(
      `Images must be no larger than ${MAX_DIMENSION}x${MAX_DIMENSION}. That one is ` +
        `${metadata.width}x${metadata.height}.`,
    );
  }

  // Animated GIFs are stored as-is: re-encoding one frame silently turns an animation
  // into a still, which is worse than not touching it.
  if (format === 'gif') {
    return {
      buffer,
      mimeType: accepted.mimeType,
      extension: accepted.extension,
      width: metadata.width,
      height: metadata.height,
      format,
    };
  }

  // `.rotate()` with no argument applies the EXIF orientation tag. It has to happen
  // before the metadata is dropped, or a portrait photo is stored rotated.
  const pipeline = sharp(buffer).rotate();

  const output =
    format === 'png'
      ? pipeline.png({ compressionLevel: 9 })
      : format === 'webp'
        ? pipeline.webp({ quality: 90 })
        : pipeline.jpeg({ quality: 88, mozjpeg: true });

  const { data, info } = await output.toBuffer({ resolveWithObject: true });

  return {
    buffer: data,
    mimeType: accepted.mimeType,
    extension: accepted.extension,
    width: info.width,
    height: info.height,
    format,
  };
}

/** A square-ish thumbnail for the asset library. Never enlarges a small source. */
export async function buildThumbnail(buffer: Buffer): Promise<Buffer> {
  return sharp(buffer)
    .rotate()
    .resize(THUMBNAIL_SIZE, THUMBNAIL_SIZE, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 80 })
    .toBuffer();
}

export function thumbnailKeyFor(storageKey: string): string {
  return storageKey.replace(/\.[^.]+$/, '') + '-thumb.webp';
}

export interface UploadedAsset {
  asset: Asset;
  /** Time-limited. Meta fetches media by URL, so this has to be third-party reachable. */
  url: string;
  thumbnailUrl: string | null;
}

/**
 * Store an uploaded image and record it.
 *
 * Storage is written before the row, deliberately. The reverse ordering can leave a row
 * pointing at a key that does not exist, which every later read treats as a broken asset;
 * this ordering can at worst leave an unreferenced object, which is inert and cheap to
 * sweep.
 */
export async function uploadAsset(
  db: ScopedDb,
  brandId: string,
  input: UploadInput,
  storage: StorageDriver = getStorage(),
): Promise<UploadedAsset> {
  const processed = await processImage(input.buffer);

  const workspaceId = await workspaceIdFor(db, brandId);

  const storageKey = buildStorageKey({
    workspaceId,
    kind: input.kind.toLowerCase(),
    extension: processed.extension,
  });

  await storage.put(storageKey, processed.buffer, {
    contentType: processed.mimeType,
    // Keys embed random bytes, so an object at a given key never changes.
    cacheControl: 'public, max-age=31536000, immutable',
  });

  let thumbnailKey: string | null = null;
  if (processed.format !== 'gif') {
    try {
      thumbnailKey = thumbnailKeyFor(storageKey);
      await storage.put(thumbnailKey, await buildThumbnail(processed.buffer), {
        contentType: 'image/webp',
        cacheControl: 'public, max-age=31536000, immutable',
      });
    } catch {
      // A missing thumbnail degrades the library to full-size previews. Failing the whole
      // upload over it would lose the asset the user actually cared about.
      thumbnailKey = null;
    }
  }

  const asset = await db.asset.create({
    data: {
      brandId,
      kind: input.kind,
      storageKey,
      mimeType: processed.mimeType,
      width: processed.width,
      height: processed.height,
      bytes: processed.buffer.byteLength,
      checksum: createHash('sha256').update(processed.buffer).digest('hex'),
      source: 'upload',
      altText: input.altText ?? null,
      tags: input.tags ?? [],
    },
  });

  return {
    asset,
    url: await storage.signedUrl(storageKey),
    thumbnailUrl: thumbnailKey ? await storage.signedUrl(thumbnailKey) : null,
  };
}

/**
 * The brand's workspace, for namespacing the storage key.
 *
 * Read through the scoped client, so a brand outside the scope is simply not found and
 * cannot have objects written under its workspace prefix.
 */
async function workspaceIdFor(db: ScopedDb, brandId: string): Promise<string> {
  const brand = await db.brand.findFirst({
    where: { id: brandId, deletedAt: null },
    select: { workspaceId: true },
  });

  if (!brand) throw new ValidationError('That brand does not exist');
  return brand.workspaceId;
}

export interface AssetView {
  id: string;
  kind: AssetKind;
  mimeType: string;
  width: number | null;
  height: number | null;
  bytes: number;
  altText: string | null;
  tags: string[];
  createdAt: Date;
  url: string;
  thumbnailUrl: string | null;
}

/** The asset library, newest first, optionally narrowed to one kind. */
export async function listAssets(
  db: ScopedDb,
  options: { kind?: AssetKind; limit?: number } = {},
  storage: StorageDriver = getStorage(),
): Promise<AssetView[]> {
  const assets = await db.asset.findMany({
    where: options.kind ? { kind: options.kind } : {},
    orderBy: { createdAt: 'desc' },
    take: Math.min(options.limit ?? 100, 200),
  });

  return Promise.all(
    assets.map(async (asset) => ({
      id: asset.id,
      kind: asset.kind,
      mimeType: asset.mimeType,
      width: asset.width,
      height: asset.height,
      bytes: asset.bytes,
      altText: asset.altText,
      tags: asset.tags,
      createdAt: asset.createdAt,
      url: await storage.signedUrl(asset.storageKey),
      // GIFs have no thumbnail; asking for a signed URL to an object that was never
      // written produces a link that 404s, which looks like a broken asset.
      thumbnailUrl:
        asset.mimeType === 'image/gif'
          ? null
          : await storage.signedUrl(thumbnailKeyFor(asset.storageKey)),
    })),
  );
}

/**
 * Remove an asset.
 *
 * The row goes first here, unlike upload. An orphaned object is inert; a row pointing at
 * a deleted object renders as a broken image everywhere it appears.
 */
export async function deleteAsset(
  db: ScopedDb,
  assetId: string,
  storage: StorageDriver = getStorage(),
): Promise<void> {
  const asset = await db.asset.findFirst({ where: { id: assetId } });
  if (!asset) throw new ValidationError('That asset does not exist');

  await db.asset.delete({ where: { id: assetId } });

  await storage.delete(asset.storageKey).catch(() => undefined);
  await storage.delete(thumbnailKeyFor(asset.storageKey)).catch(() => undefined);
}
