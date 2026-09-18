/**
 * WCAG contrast maths.
 *
 * In its own module rather than beside the palette editor so it can be tested and reused
 * without importing a component — the render pipeline will want the same check when it
 * starts warning about unreadable template output.
 */

/** WCAG relative luminance. Not perceived brightness — the sRGB gamma matters. */
function relativeLuminance(hex: string): number {
  const value = hex.replace('#', '');
  const channels = [0, 2, 4].map((offset) => {
    const srgb = parseInt(value.slice(offset, offset + 2), 16) / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

/** The ratio between two colours, 1:1 (identical) to 21:1 (black on white). */
export function contrastRatio(a: string, b: string): number {
  const lighter = Math.max(relativeLuminance(a), relativeLuminance(b));
  const darker = Math.min(relativeLuminance(a), relativeLuminance(b));
  return (lighter + 0.05) / (darker + 0.05);
}

/** Below this, small text is hard to read once it is baked into an image. */
export const READABLE_CONTRAST = 4.5;
