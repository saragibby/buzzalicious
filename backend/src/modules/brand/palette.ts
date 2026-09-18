import sharp from 'sharp';
import { BrandPaletteSchema, type BrandPalette } from './brand.schemas';

/**
 * Suggest a palette from a logo.
 *
 * A convenience, not a decision: the result is offered to the user to accept, adjust or
 * ignore. Nothing here ever writes to a brand.
 *
 * The approach is deliberately simple — quantise to a small palette, rank by coverage,
 * and assign roles by lightness. A perceptual clustering pass in LAB space would pick
 * marginally better accents, and would also be a meaningful amount of code to maintain
 * for a feature whose output a human immediately edits.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export function toHex({ r, g, b }: Rgb): string {
  const channel = (value: number) =>
    Math.max(0, Math.min(255, Math.round(value)))
      .toString(16)
      .padStart(2, '0');
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

/** Perceived brightness, 0..1. The usual sRGB luma weights; green dominates because eyes do. */
export function luminance({ r, g, b }: Rgb): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** 0..1. Greys score near zero, which is what makes them unusable as an accent. */
export function saturation({ r, g, b }: Rgb): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === 0) return 0;
  return (max - min) / max;
}

export interface ColorCount {
  color: Rgb;
  /** Share of sampled pixels, 0..1. */
  weight: number;
}

/**
 * The dominant colours of an image.
 *
 * Downsamples first: a logo's palette does not change with resolution, and quantising a
 * 4096px image pixel by pixel costs far more than the answer is worth. Colours are bucketed
 * at 4 bits per channel so near-identical antialiasing shades collapse together instead of
 * each claiming their own slot.
 */
export async function extractDominantColors(buffer: Buffer, limit = 8): Promise<ColorCount[]> {
  const { data, info } = await sharp(buffer)
    .resize(96, 96, { fit: 'inside', withoutEnlargement: true })
    // Flatten onto white: a transparent logo is mostly alpha, and unflattened those
    // pixels read as black and dominate the result.
    .flatten({ background: '#ffffff' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const channels = info.channels;
  const buckets = new Map<number, { r: number; g: number; b: number; count: number }>();
  let sampled = 0;

  for (let offset = 0; offset + channels - 1 < data.length; offset += channels) {
    const r = data[offset];
    const g = data[offset + 1];
    const b = data[offset + 2];

    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const bucket = buckets.get(key) ?? { r: 0, g: 0, b: 0, count: 0 };
    bucket.r += r;
    bucket.g += g;
    bucket.b += b;
    bucket.count += 1;
    buckets.set(key, bucket);
    sampled += 1;
  }

  if (sampled === 0) return [];

  return [...buckets.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
    .map((bucket) => ({
      // The bucket mean, not its centre: the average is the colour actually present.
      color: {
        r: bucket.r / bucket.count,
        g: bucket.g / bucket.count,
        b: bucket.b / bucket.count,
      },
      weight: bucket.count / sampled,
    }));
}

const FALLBACK: BrandPalette = BrandPaletteSchema.parse({
  primary: '#1f2937',
  secondary: '#4b5563',
  accent: '#2563eb',
  neutral: '#9ca3af',
  background: '#ffffff',
  text: '#111827',
});

/**
 * Turn ranked colours into a role assignment.
 *
 * `background` and `text` are the part that matters most and are treated conservatively:
 * a palette whose text does not contrast with its background produces unreadable posts,
 * and a user is far more likely to notice a slightly wrong accent than to catch that.
 */
export function assignRoles(colors: ColorCount[]): BrandPalette {
  const usable = colors.filter((entry) => entry.weight >= 0.01);
  if (usable.length === 0) return FALLBACK;

  const saturated = usable
    .filter((entry) => saturation(entry.color) > 0.2)
    .sort((a, b) => b.weight - a.weight);

  // A logo that is entirely greyscale genuinely has no brand colour to offer. Saying so
  // by falling back is better than promoting a grey to "primary" and looking confident.
  const primary = saturated[0]?.color ?? usable[0].color;
  const secondary = saturated[1]?.color ?? primary;

  // The accent is the most colourful, not the most common — the most common saturated
  // colour is usually the primary again.
  const accent =
    [...saturated].sort((a, b) => saturation(b.color) - saturation(a.color))[1]?.color ?? secondary;

  const neutral =
    [...usable].sort(
      (a, b) => Math.abs(luminance(a.color) - 0.5) - Math.abs(luminance(b.color) - 0.5),
    )[0]?.color ?? primary;

  const lightest = [...usable].sort((a, b) => luminance(b.color) - luminance(a.color))[0].color;
  const darkest = [...usable].sort((a, b) => luminance(a.color) - luminance(b.color))[0].color;

  // If the extremes are close together the image has no usable contrast of its own, so
  // keep the safe defaults rather than generating a low-contrast pair.
  const hasContrast = luminance(lightest) - luminance(darkest) > 0.4;

  return BrandPaletteSchema.parse({
    primary: toHex(primary),
    secondary: toHex(secondary),
    accent: toHex(accent),
    neutral: toHex(neutral),
    background: hasContrast ? toHex(lightest) : FALLBACK.background,
    text: hasContrast ? toHex(darkest) : FALLBACK.text,
  });
}

/** Suggest a palette from logo bytes. Never throws: a failed suggestion is just defaults. */
export async function suggestPaletteFromImage(buffer: Buffer): Promise<BrandPalette> {
  try {
    return assignRoles(await extractDominantColors(buffer));
  } catch {
    return FALLBACK;
  }
}
