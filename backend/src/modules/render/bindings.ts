/**
 * Binding resolution: the `$…` expressions in a layout, turned into values.
 *
 * Four kinds, all defined by W2's `template.schemas.ts` regexes:
 *
 * - `$brand.palette.*`, `$brand.typography.*`, `$brand.logo` — the brand kit
 * - `$slot.*` — user content
 * - `$scale(n)` — a dimension proportional to the rendition
 * - `$fit(max, min)` — a font size the compiler solves for
 *
 * `$fit` is not resolved here. It depends on the box the text lands in, which is only
 * known once the tree around it exists, so the compiler handles it — `resolveStyleValue`
 * reports it and leaves it alone.
 */

import type { BrandPalette, BrandTypography } from '../brand/brand.schemas';
import { fontFamilyStack } from './fonts';
import { RenderError } from './render.errors';
import { REFERENCE_WIDTH } from './renderer';

export interface BrandKit {
  palette: BrandPalette;
  typography: BrandTypography;
  /** A data URI, resolved from the brand's logo asset. Absent brands render without one. */
  logo?: string;
}

/** The parsed form of `$fit(max, min)`. */
export interface FitExpression {
  max: number;
  min: number;
}

const FIT = /^\$fit\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*\)$/;
const SCALE = /^\$scale\(\s*(\d+(?:\.\d+)?)\s*\)$/;

export function parseFit(value: unknown): FitExpression | undefined {
  if (typeof value !== 'string') return undefined;
  const match = FIT.exec(value);
  return match ? { max: Number(match[1]), min: Number(match[2]) } : undefined;
}

/**
 * `$scale(n)` in template units → pixels for this rendition.
 *
 * Template dimensions are authored against a 1080px-wide reference canvas, so one layout
 * covers every ratio: a 72px pad is 72px at 1080 wide and 80px at 1200. This is also what
 * makes a third-size preview the same design rather than a different one.
 */
export function scaleValue(units: number, canvasWidth: number): number {
  return Math.round((units * canvasWidth) / REFERENCE_WIDTH);
}

function brandValue(path: string, brand: BrandKit): string | undefined {
  if (path === 'logo') return brand.logo;

  const [namespace, key] = path.split('.');

  if (namespace === 'palette') {
    const value = brand.palette[key as keyof BrandPalette];
    if (value === undefined) {
      throw new RenderError(`Brand palette has no "${key}" — layout binds $brand.palette.${key}`);
    }
    return value;
  }

  if (namespace === 'typography') {
    const value = brand.typography[key as keyof BrandTypography];
    if (value === undefined) {
      throw new RenderError(
        `Brand typography has no "${key}" — layout binds $brand.typography.${key}`,
      );
    }

    // Font families become a CSS fallback list naming every subset of the family. Satori
    // resolves a text run to one face per family name, so the bare name alone silently
    // loses every character outside the `latin` subset. See fonts.ts.
    return key.endsWith('Family') ? fontFamilyStack(String(value)) : String(value);
  }

  throw new RenderError(`Unknown brand binding "$brand.${path}"`);
}

export interface ResolveContext {
  brand: BrandKit;
  slots: Record<string, string>;
  canvasWidth: number;
}

/** A style value that still needs the layout pass: `$fit` at the moment. */
export const DEFERRED = Symbol('deferred');

export type ResolvedStyleValue = string | number | boolean | typeof DEFERRED;

/**
 * One style value, resolved.
 *
 * A `$`-prefixed string that matches nothing is a hard error rather than a passthrough.
 * W2's schema already rejects unknown bindings at authoring time; this is the second line,
 * and the failure it prevents — the literal text `$brand.palete.text` baked into a
 * published image — is worth two.
 */
export function resolveStyleValue(value: unknown, context: ResolveContext): ResolvedStyleValue {
  if (typeof value !== 'string' || !value.startsWith('$')) {
    return value as ResolvedStyleValue;
  }

  if (FIT.test(value)) return DEFERRED;

  const scale = SCALE.exec(value);
  if (scale) return scaleValue(Number(scale[1]), context.canvasWidth);

  if (value.startsWith('$brand.')) {
    return brandValue(value.slice('$brand.'.length), context.brand) ?? '';
  }

  if (value.startsWith('$slot.')) {
    return context.slots[value.slice('$slot.'.length)] ?? '';
  }

  throw new RenderError(`Unknown binding expression "${value}"`);
}

/** Resolve a whole style object, dropping deferred entries for the compiler to fill in. */
export function resolveStyle(
  style: Record<string, unknown> | undefined,
  context: ResolveContext,
): { style: Record<string, unknown>; deferred: string[] } {
  const resolved: Record<string, unknown> = {};
  const deferred: string[] = [];

  for (const [property, raw] of Object.entries(style ?? {})) {
    const value = resolveStyleValue(raw, context);
    if (value === DEFERRED) deferred.push(property);
    else resolved[property] = value;
  }

  return { style: resolved, deferred };
}

/** Text content, which is either a `$slot.*` binding or a literal baked into the template. */
export function resolveContent(content: string, context: ResolveContext): string {
  if (content.startsWith('$slot.')) {
    return context.slots[content.slice('$slot.'.length)] ?? '';
  }
  return content;
}
