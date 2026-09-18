import { z } from 'zod';
import { EmojiPolicySchema, ReadingLevelSchema } from './brand.schemas';

/**
 * JSON column contract for `PersonaLayer.modifiers`.
 *
 * A persona is a *delta* over `Brand.voiceGuide`, never a replacement. Copying the whole
 * voice guide into each persona would mean a brand voice edit silently failing to reach
 * three of its four personas — the shape is what enforces that it cannot happen.
 */
export const PersonaModifiersSchema = z
  .object({
    /** Attributes layered on top of the brand's own tone. */
    toneAttributes: z.array(z.string().min(1)).default([]),
    /** Brand-level tone attributes this persona deliberately drops. */
    suppressToneAttributes: z.array(z.string().min(1)).default([]),
    addDoSay: z.array(z.string().min(1)).default([]),
    addDontSay: z.array(z.string().min(1)).default([]),
    /** Overrides the brand value when present. */
    readingLevel: ReadingLevelSchema.optional(),
    emojiPolicy: EmojiPolicySchema.optional(),
    /** How strongly to apply the delta: 0 = brand voice, 1 = fully the persona. */
    intensity: z.number().min(0).max(1).default(0.5),
    rationale: z.string().optional(),
  })
  .strict();

export type PersonaModifiers = z.infer<typeof PersonaModifiersSchema>;
