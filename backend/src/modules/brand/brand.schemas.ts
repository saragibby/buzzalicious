import { z } from 'zod';

/**
 * JSON column contracts for `Brand.palette`, `typography`, `voiceGuide` and `goals`.
 *
 * These are JSON rather than columns because the voice guide in particular will churn
 * heavily as the persona feature develops (docs/02). The tradeoff only pays off if the
 * shape is validated at the boundary — an unvalidated JSON column is a schema with no
 * migrations *and* no guarantees.
 */

/** `#rrggbb` or `#rgb`. Satori will not resolve a named CSS colour. */
export const HexColorSchema = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'Expected a hex colour like "#1b4332"');

export const BrandPaletteSchema = z
  .object({
    primary: HexColorSchema,
    secondary: HexColorSchema,
    accent: HexColorSchema,
    neutral: HexColorSchema,
    background: HexColorSchema,
    text: HexColorSchema,
  })
  .strict();

export type BrandPalette = z.infer<typeof BrandPaletteSchema>;

/**
 * Font weights are numeric because Satori takes numeric weights; "bold" is not resolved.
 * Families must be ones we actually ship as loaded buffers — Satori has no system font
 * fallback, and a missing font renders as a blank image rather than an error (docs/05).
 */
export const BrandTypographySchema = z
  .object({
    headingFamily: z.string().min(1),
    bodyFamily: z.string().min(1),
    headingWeight: z.number().int().min(100).max(900).default(700),
    bodyWeight: z.number().int().min(100).max(900).default(400),
    headingLetterSpacing: z.number().optional(),
    bodyLineHeight: z.number().positive().optional(),
    /** Applied to headings at render time. Satori has no `text-transform`. */
    headingTransform: z.enum(['none', 'uppercase', 'lowercase']).default('none'),
  })
  .strict();

export type BrandTypography = z.infer<typeof BrandTypographySchema>;

export const EmojiPolicySchema = z.enum(['none', 'sparing', 'liberal']);
export const ReadingLevelSchema = z.enum(['simple', 'standard', 'expert']);

/**
 * A real guide the user authors, not a one-line descriptor. `doSay` / `dontSay` exist
 * because the strongest signal in the Tax Dedux prompt work (docs/11) was the banned
 * list, not the positive description — telling a model what not to write moves output
 * further than telling it what to write.
 */
export const BrandVoiceGuideSchema = z
  .object({
    summary: z.string().min(1),
    toneAttributes: z.array(z.string().min(1)).min(1),
    doSay: z.array(z.string().min(1)).default([]),
    dontSay: z.array(z.string().min(1)).default([]),
    vocabulary: z.array(z.string().min(1)).default([]),
    sampleCopy: z.array(z.string().min(1)).default([]),
    readingLevel: ReadingLevelSchema.default('standard'),
    emojiPolicy: EmojiPolicySchema.default('sparing'),
    /** Openers the brand never uses. Ported from the Tax Dedux prompt work. */
    bannedOpeners: z.array(z.string().min(1)).default([]),
  })
  .strict();

export type BrandVoiceGuide = z.infer<typeof BrandVoiceGuideSchema>;

export const PrimaryGoalSchema = z.enum([
  'awareness',
  'leads',
  'sales',
  'retention',
  'community',
  'recruiting',
]);

export const BrandGoalsSchema = z
  .object({
    primaryGoal: PrimaryGoalSchema,
    targetAudience: z.string().min(1),
    callsToAction: z.array(z.string().min(1)).default([]),
    /** Free-text notes the recommender surfaces as reasoning context. */
    notes: z.string().optional(),
  })
  .strict();

export type BrandGoals = z.infer<typeof BrandGoalsSchema>;
