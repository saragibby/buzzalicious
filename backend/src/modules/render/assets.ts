/**
 * Image assets, resolved to data URIs for Satori.
 *
 * Satori performs no I/O. An `<img src="https://…">` is not fetched, it is skipped, and
 * the render succeeds with a hole where the photo should be. So every image a template
 * references has to be bytes in memory before compilation starts, which is what this file
 * does.
 *
 * Images are also downscaled on the way in. A 12MP phone photo behind a 1080px canvas
 * costs resvg real time to rasterize and inflates the data URI embedded in the SVG, for
 * detail no one can see. Downscaling to the canvas is the single largest render-time win
 * available on image templates.
 */

import sharp from 'sharp';
import type { Db } from '../../platform/db';
import { getStorage } from '../../platform/storage';
import { RenderError } from './render.errors';
import { REFERENCE_WIDTH } from './renderer';

/**
 * Cap on the longest edge of an embedded image.
 *
 * Twice the reference canvas, so a full-bleed background still has pixels to spare after
 * `objectFit: cover` crops it, and a Story at 1920 tall is not upscaled.
 */
export const MAX_EMBEDDED_EDGE = REFERENCE_WIDTH * 2;

export interface ResolvedImage {
  dataUri: string;
  width: number;
  height: number;
}

function toDataUri(buffer: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}

/**
 * Downscale and normalise an image for embedding.
 *
 * Output is always PNG or JPEG: resvg understands both, and neither AVIF nor HEIC is
 * reliably supported by every resvg build. JPEG for photographs keeps the data URI an
 * order of magnitude smaller than the PNG equivalent.
 */
export async function prepareImage(source: Buffer): Promise<ResolvedImage> {
  try {
    const image = sharp(source, { failOn: 'error' }).rotate();
    const metadata = await image.metadata();
    const hasAlpha = metadata.hasAlpha ?? false;

    const resized = image.resize({
      width: MAX_EMBEDDED_EDGE,
      height: MAX_EMBEDDED_EDGE,
      fit: 'inside',
      withoutEnlargement: true,
    });

    const output = hasAlpha
      ? await resized.png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true })
      : await resized.jpeg({ quality: 88, mozjpeg: true }).toBuffer({ resolveWithObject: true });

    return {
      dataUri: toDataUri(output.data, hasAlpha ? 'image/png' : 'image/jpeg'),
      width: output.info.width,
      height: output.info.height,
    };
  } catch (cause) {
    throw new RenderError(`Could not decode an image asset: ${String(cause)}`, { cause });
  }
}

/**
 * Fetch and prepare every asset a render needs, by asset id.
 *
 * `db` is typed `Db` and not `PrismaClient` on purpose — the client is `$extends`-wrapped
 * to encrypt secrets at rest, and a `PrismaClient` annotation compiles, passes tests, and
 * quietly writes plaintext. See platform/db.ts.
 */
export async function resolveAssets(
  db: Db,
  assetIds: readonly string[],
): Promise<Map<string, ResolvedImage>> {
  const resolved = new Map<string, ResolvedImage>();
  const unique = [...new Set(assetIds)];
  if (unique.length === 0) return resolved;

  const assets = await db.asset.findMany({
    where: { id: { in: unique } },
    select: { id: true, storageKey: true },
  });

  const missing = unique.filter((id) => !assets.some((asset) => asset.id === id));
  if (missing.length > 0) {
    throw new RenderError(`Unknown image asset(s): ${missing.join(', ')}`);
  }

  const storage = getStorage();

  await Promise.all(
    assets.map(async (asset) => {
      resolved.set(asset.id, await prepareImage(await storage.get(asset.storageKey)));
    }),
  );

  return resolved;
}
