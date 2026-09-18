import { z } from 'zod';

/**
 * JSON column contracts for `Template.slotSchema`, `Template.layout` and
 * `Post.slotValues`.
 *
 * `TemplateLayoutSchema` is the contract W4's layout compiler renders from
 * (docs/05-template-engine.md). It is deliberately strict: a template is authored once and
 * rendered thousands of times, and Satori's failure mode for a malformed tree is a blank
 * or subtly wrong image rather than an exception. Catching it here — at seed time, at
 * template-authoring time, in a test — is the difference between a review comment and a
 * client's feed.
 */

/** The archetypes in docs/05. Category priors are expressed over these. */
export const TEMPLATE_ARCHETYPES = [
  'stat-callout',
  'tip-list',
  'before-after',
  'testimonial',
  'product-feature',
  'announcement',
  'question-hook',
  'behind-the-scenes',
] as const;

export const TemplateArchetypeSchema = z.enum(TEMPLATE_ARCHETYPES);
export type TemplateArchetype = z.infer<typeof TemplateArchetypeSchema>;

// ─── Binding expressions ─────────────────────────────────────────────────────────

/**
 * `$brand.palette.primary`, `$brand.typography.headingFamily`, `$brand.logo`.
 * Enumerating the two namespaces rather than accepting any path means a typo like
 * `$brand.colours.primary` fails at authoring time instead of rendering as nothing.
 */
const BRAND_BINDING = /^\$brand\.(?:logo|(?:palette|typography)\.[a-zA-Z][a-zA-Z0-9]*)$/;
/** `$slot.headline` — the slot must also exist in `slotSchema`, checked separately. */
const SLOT_BINDING = /^\$slot\.[a-zA-Z][a-zA-Z0-9]*$/;
/** `$scale(48)` — a dimension scaled proportionally to the target rendition. */
const SCALE_BINDING = /^\$scale\(\s*\d+(?:\.\d+)?\s*\)$/;
/** `$fit(64, 32)` — font size auto-fitted between bounds to avoid overflow. */
const FIT_BINDING = /^\$fit\(\s*\d+(?:\.\d+)?\s*,\s*\d+(?:\.\d+)?\s*\)$/;

const BINDING_PATTERNS = [BRAND_BINDING, SLOT_BINDING, SCALE_BINDING, FIT_BINDING];

function isKnownBinding(value: string): boolean {
  return BINDING_PATTERNS.some((pattern) => pattern.test(value));
}

/** Any `$...` string must be a binding the compiler knows how to resolve. */
export const BindingExpressionSchema = z.string().refine((value) => isKnownBinding(value), {
  message:
    'Unknown binding expression. Supported: $brand.palette.*, $brand.typography.*, ' +
    '$brand.logo, $slot.*, $scale(n), $fit(max, min)',
});

const BrandBindingSchema = z.string().regex(BRAND_BINDING, 'Expected a $brand.* binding');
const SlotBindingSchema = z.string().regex(SLOT_BINDING, 'Expected a $slot.* binding');

/**
 * A style value: a literal, or a binding. A bare `$`-prefixed string that is not a
 * recognised binding is rejected — silently rendering the literal text "$brand.palete.text"
 * into an image is the exact class of bug this catches.
 */
export const StyleValueSchema = z.union([
  z.number(),
  z.boolean(),
  z.string().refine((value) => !value.startsWith('$') || isKnownBinding(value), {
    message: 'Unknown binding expression',
  }),
]);

export const StyleSchema = z.record(StyleValueSchema);
export type LayoutStyle = z.infer<typeof StyleSchema>;

// ─── Layout nodes ────────────────────────────────────────────────────────────────

const BaseNodeFields = {
  /** Optional author-facing identifier, useful for overflow reporting. */
  id: z.string().min(1).optional(),
  style: StyleSchema.optional(),
};

const TextNodeSchema = z.object({
  type: z.literal('text'),
  /** A `$slot.*` binding or a literal string baked into the template. */
  content: z.string().min(1),
  ...BaseNodeFields,
});

const ImageNodeSchema = z.object({
  type: z.literal('image'),
  source: SlotBindingSchema,
  ...BaseNodeFields,
});

const LogoNodeSchema = z.object({
  type: z.literal('logo'),
  /** Defaults to `$brand.logo`; stated explicitly when a template wants it named. */
  source: BrandBindingSchema.optional(),
  ...BaseNodeFields,
});

export type LayoutNode =
  | z.infer<typeof TextNodeSchema>
  | z.infer<typeof ImageNodeSchema>
  | z.infer<typeof LogoNodeSchema>
  | {
      type: 'stack';
      id?: string;
      direction: 'row' | 'column';
      style?: LayoutStyle;
      children: LayoutNode[];
    };

const StackNodeSchema: z.ZodType<Extract<LayoutNode, { type: 'stack' }>> = z.lazy(() =>
  z.object({
    type: z.literal('stack'),
    direction: z.enum(['row', 'column']),
    // Satori implements a flexbox subset; a stack with no children renders nothing, which
    // is almost always an authoring mistake rather than an intent.
    children: z.array(LayoutNodeSchema).min(1),
    ...BaseNodeFields,
  }),
);

export const LayoutNodeSchema: z.ZodType<LayoutNode> = z.lazy(() =>
  z.union([StackNodeSchema, TextNodeSchema, ImageNodeSchema, LogoNodeSchema]),
);

// ─── Canvas ──────────────────────────────────────────────────────────────────────

/**
 * Fractions of the canvas reserved for platform chrome. Instagram Stories overlay UI on
 * roughly the top 8% and bottom 12%; rendering through it puts the CTA under the
 * platform's own buttons.
 */
export const SafeAreaSchema = z.object({
  top: z.number().min(0).max(0.5).optional(),
  bottom: z.number().min(0).max(0.5).optional(),
  left: z.number().min(0).max(0.5).optional(),
  right: z.number().min(0).max(0.5).optional(),
});

export const AspectRatioKeySchema = z.enum([
  'SQUARE_1_1',
  'PORTRAIT_4_5',
  'STORY_9_16',
  'LANDSCAPE_16_9',
]);

export const CanvasSchema = z.object({
  /** Applied to every ratio unless `byRatio` overrides it. */
  safeArea: SafeAreaSchema.optional(),
  /**
   * Per-ratio overrides. Safe areas are genuinely per-ratio — a story has chrome a square
   * feed post does not — so one flat value cannot express what docs/05 requires.
   */
  byRatio: z.record(AspectRatioKeySchema, SafeAreaSchema).optional(),
});

export const TemplateLayoutSchema = z
  .object({
    version: z.literal(1),
    canvas: CanvasSchema.optional(),
    root: LayoutNodeSchema,
  })
  .strict();

export type TemplateLayout = z.infer<typeof TemplateLayoutSchema>;

// ─── Slot schema ─────────────────────────────────────────────────────────────────

const TextSlotSchema = z.object({
  type: z.literal('text'),
  required: z.boolean().default(false),
  maxLength: z.number().int().positive(),
  minLength: z.number().int().nonnegative().optional(),
  multiline: z.boolean().optional(),
  /** Feeds caption generation so the AI knows what the slot is *for*. See docs/05. */
  aiHint: z.string().optional(),
  default: z.string().optional(),
  label: z.string().optional(),
});

const ImageSlotSchema = z.object({
  type: z.literal('image'),
  required: z.boolean().default(false),
  minWidth: z.number().int().positive().optional(),
  minHeight: z.number().int().positive().optional(),
  /** e.g. "4:5" — guides the upload UI's crop. */
  aspectHint: z
    .string()
    .regex(/^\d+:\d+$/, 'Expected an aspect hint like "4:5"')
    .optional(),
  aiHint: z.string().optional(),
  label: z.string().optional(),
});

export const SlotDefinitionSchema = z.discriminatedUnion('type', [TextSlotSchema, ImageSlotSchema]);
export type SlotDefinition = z.infer<typeof SlotDefinitionSchema>;

export const SlotSchemaSchema = z
  .record(
    z.string().regex(/^[a-zA-Z][a-zA-Z0-9]*$/, 'Slot names must be identifier-like'),
    SlotDefinitionSchema,
  )
  .refine((slots) => Object.keys(slots).length > 0, {
    message: 'A template needs at least one slot',
  });

export type TemplateSlotSchema = z.infer<typeof SlotSchemaSchema>;

// ─── Slot values ─────────────────────────────────────────────────────────────────

export const ImageSlotValueSchema = z.object({
  assetId: z.string().uuid(),
  /** Optional focal point for smart cropping, as fractions of the image. */
  focalPoint: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).optional(),
});

export const SlotValueSchema = z.union([z.string(), ImageSlotValueSchema]);
export const SlotValuesSchema = z.record(z.string(), SlotValueSchema);
export type SlotValues = z.infer<typeof SlotValuesSchema>;

// ─── Cross-validation ────────────────────────────────────────────────────────────

export interface SlotValidationIssue {
  slot: string;
  message: string;
}

/**
 * Check supplied values against a template's slot schema.
 *
 * Kept separate from the Zod schemas because the rules depend on *another* JSON column:
 * required-ness and length come from `slotSchema`, not from the values. W4 must run this
 * before queueing a render — failing inside a job means failing where the user is not
 * watching (docs/05, `modules/template/README.md`).
 */
export function validateSlotValues(
  slotSchema: TemplateSlotSchema,
  values: SlotValues,
): SlotValidationIssue[] {
  const issues: SlotValidationIssue[] = [];

  for (const [name, definition] of Object.entries(slotSchema)) {
    const value = values[name];

    if (value === undefined || value === '') {
      const hasDefault = definition.type === 'text' && definition.default !== undefined;
      if (definition.required && !hasDefault) {
        issues.push({ slot: name, message: 'Required slot is missing' });
      }
      continue;
    }

    if (definition.type === 'text') {
      if (typeof value !== 'string') {
        issues.push({ slot: name, message: 'Expected text, got an image reference' });
        continue;
      }
      if (value.length > definition.maxLength) {
        issues.push({
          slot: name,
          message: `Exceeds maxLength ${definition.maxLength} by ${value.length - definition.maxLength}`,
        });
      }
      if (definition.minLength !== undefined && value.length < definition.minLength) {
        issues.push({ slot: name, message: `Shorter than minLength ${definition.minLength}` });
      }
    } else if (typeof value === 'string' || !ImageSlotValueSchema.safeParse(value).success) {
      issues.push({ slot: name, message: 'Expected an image reference { assetId }' });
    }
  }

  for (const name of Object.keys(values)) {
    if (!(name in slotSchema)) {
      issues.push({ slot: name, message: 'No such slot on this template' });
    }
  }

  return issues;
}

/** Every `$slot.*` a layout binds must exist in the template's slot schema. */
export function findUnboundSlotReferences(
  layout: TemplateLayout,
  slotSchema: TemplateSlotSchema,
): string[] {
  const referenced = new Set<string>();

  const visitValue = (value: unknown): void => {
    if (typeof value === 'string' && SLOT_BINDING.test(value)) {
      referenced.add(value.slice('$slot.'.length));
    }
  };

  const visit = (node: LayoutNode): void => {
    if (node.style) Object.values(node.style).forEach(visitValue);
    if (node.type === 'text') visitValue(node.content);
    if (node.type === 'image') visitValue(node.source);
    if (node.type === 'stack') node.children.forEach(visit);
  };

  visit(layout.root);

  return [...referenced].filter((name) => !(name in slotSchema)).sort();
}
