import { describe, expect, it } from 'vitest';
import {
  BindingExpressionSchema,
  SlotSchemaSchema,
  SlotValuesSchema,
  TemplateLayoutSchema,
  findUnboundSlotReferences,
  validateSlotValues,
  type TemplateLayout,
  type TemplateSlotSchema,
} from './template.schemas';

const layout = {
  version: 1,
  canvas: {
    safeArea: { top: 0.04, bottom: 0.04 },
    byRatio: { STORY_9_16: { top: 0.08, bottom: 0.12 } },
  },
  root: {
    type: 'stack',
    direction: 'column',
    style: { background: '$brand.palette.background', padding: '$scale(48)' },
    children: [
      {
        type: 'image',
        source: '$slot.heroPhoto',
        style: { flex: 1, objectFit: 'cover', borderRadius: '$scale(24)' },
      },
      {
        type: 'text',
        content: '$slot.headline',
        style: {
          fontFamily: '$brand.typography.headingFamily',
          fontSize: '$fit(64, 32)',
          color: '$brand.palette.text',
        },
      },
      { type: 'logo', style: { width: '$scale(120)' } },
    ],
  },
} satisfies unknown as TemplateLayout;

const slotSchema: TemplateSlotSchema = SlotSchemaSchema.parse({
  headline: { type: 'text', required: true, maxLength: 60, aiHint: 'punchy hook' },
  body: { type: 'text', maxLength: 140 },
  heroPhoto: { type: 'image', required: true, minWidth: 1080, aspectHint: '4:5' },
  cta: { type: 'text', maxLength: 24, default: 'Learn more' },
});

describe('BindingExpressionSchema', () => {
  it.each([
    '$brand.palette.primary',
    '$brand.typography.headingFamily',
    '$brand.logo',
    '$slot.headline',
    '$scale(48)',
    '$scale(12.5)',
    '$fit(64, 32)',
  ])('accepts %s', (expression) => {
    expect(BindingExpressionSchema.safeParse(expression).success).toBe(true);
  });

  it.each([
    '$brand.colours.primary', // wrong namespace
    '$brand.palette', // no leaf
    '$slots.headline', // pluralised
    '$fit(64)', // $fit needs both bounds
    '$scale()', // no argument
    '$unknown(3)',
  ])('rejects %s', (expression) => {
    expect(BindingExpressionSchema.safeParse(expression).success).toBe(false);
  });
});

describe('TemplateLayoutSchema', () => {
  it('accepts the reference layout from docs/05', () => {
    expect(TemplateLayoutSchema.parse(layout)).toBeTruthy();
  });

  it('rejects a style binding with a typo', () => {
    // This is the whole point of validating bindings: an unresolvable binding renders as
    // nothing, so the image publishes with a missing background rather than failing.
    const broken = structuredClone(layout) as unknown as {
      root: { style: Record<string, string> };
    };
    broken.root.style.background = '$brand.palete.background';
    expect(TemplateLayoutSchema.safeParse(broken).success).toBe(false);
  });

  it('rejects a node type the compiler has no case for', () => {
    const broken = structuredClone(layout) as unknown as {
      root: { children: unknown[] };
    };
    broken.root.children.push({ type: 'video', source: '$slot.clip' });
    expect(TemplateLayoutSchema.safeParse(broken).success).toBe(false);
  });

  it('rejects an empty stack', () => {
    const broken = structuredClone(layout) as unknown as { root: { children: unknown[] } };
    broken.root.children = [];
    expect(TemplateLayoutSchema.safeParse(broken).success).toBe(false);
  });

  it('rejects an unknown top-level key', () => {
    expect(TemplateLayoutSchema.safeParse({ ...layout, renderer: 'puppeteer' }).success).toBe(
      false,
    );
  });

  it('rejects a future layout version', () => {
    // A v2 layout in a v1 compiler must fail loudly, not render half of itself.
    expect(TemplateLayoutSchema.safeParse({ ...layout, version: 2 }).success).toBe(false);
  });

  it('rejects a safe area larger than half the canvas', () => {
    const broken = structuredClone(layout) as unknown as {
      canvas: { safeArea: { top: number } };
    };
    broken.canvas.safeArea.top = 0.9;
    expect(TemplateLayoutSchema.safeParse(broken).success).toBe(false);
  });

  it('validates nested stacks recursively', () => {
    const nested = {
      version: 1,
      root: {
        type: 'stack',
        direction: 'column',
        children: [
          {
            type: 'stack',
            direction: 'row',
            children: [{ type: 'text', content: 'ok', style: { color: '$brand.palete.text' } }],
          },
        ],
      },
    };
    expect(TemplateLayoutSchema.safeParse(nested).success).toBe(false);
  });
});

describe('SlotSchemaSchema', () => {
  it('defaults `required` to false', () => {
    const parsed = SlotSchemaSchema.parse({ body: { type: 'text', maxLength: 140 } });
    expect(parsed.body?.required).toBe(false);
  });

  it('requires a maxLength on text slots', () => {
    // Without it there is no overflow bound, and overflow in Satori is a clipped image.
    expect(SlotSchemaSchema.safeParse({ body: { type: 'text' } }).success).toBe(false);
  });

  it('rejects a slot name a binding could not address', () => {
    expect(SlotSchemaSchema.safeParse({ 'hero photo': { type: 'image' } }).success).toBe(false);
  });

  it('rejects a malformed aspect hint', () => {
    expect(SlotSchemaSchema.safeParse({ hero: { type: 'image', aspectHint: '4x5' } }).success).toBe(
      false,
    );
  });

  it('rejects a template with no slots', () => {
    expect(SlotSchemaSchema.safeParse({}).success).toBe(false);
  });
});

describe('validateSlotValues', () => {
  it('passes a complete, valid set', () => {
    const issues = validateSlotValues(slotSchema, {
      headline: 'Fall rates are live',
      heroPhoto: { assetId: '11111111-1111-4111-8111-111111111111' },
    });
    expect(issues).toEqual([]);
  });

  it('reports a missing required slot', () => {
    const issues = validateSlotValues(slotSchema, { headline: 'Hi' });
    expect(issues).toEqual([{ slot: 'heroPhoto', message: 'Required slot is missing' }]);
  });

  it('reports overflow with the amount, so the UI can say how much to cut', () => {
    const issues = validateSlotValues(slotSchema, {
      headline: 'x'.repeat(65),
      heroPhoto: { assetId: '11111111-1111-4111-8111-111111111111' },
    });
    expect(issues).toEqual([{ slot: 'headline', message: 'Exceeds maxLength 60 by 5' }]);
  });

  it('reports a value supplied for a slot the template does not have', () => {
    const issues = validateSlotValues(slotSchema, {
      headline: 'Hi',
      heroPhoto: { assetId: '11111111-1111-4111-8111-111111111111' },
      subtitle: 'oops',
    });
    expect(issues).toEqual([{ slot: 'subtitle', message: 'No such slot on this template' }]);
  });

  it('reports text supplied where an image reference belongs', () => {
    const issues = validateSlotValues(slotSchema, {
      headline: 'Hi',
      heroPhoto: 'https://example.com/photo.jpg',
    });
    expect(issues).toEqual([
      { slot: 'heroPhoto', message: 'Expected an image reference { assetId }' },
    ]);
  });

  it('treats a required slot with a default as satisfied', () => {
    const withRequiredDefault = SlotSchemaSchema.parse({
      cta: { type: 'text', required: true, maxLength: 24, default: 'Learn more' },
    });
    expect(validateSlotValues(withRequiredDefault, {})).toEqual([]);
  });
});

describe('findUnboundSlotReferences', () => {
  it('finds nothing when every binding has a slot', () => {
    expect(findUnboundSlotReferences(TemplateLayoutSchema.parse(layout), slotSchema)).toEqual([]);
  });

  it('finds a binding with no matching slot', () => {
    // The layout and the slot schema are separate columns, so nothing but this check stops
    // them drifting apart — and the symptom is an empty region in a published image.
    const { heroPhoto: _heroPhoto, ...withoutHero } = slotSchema;
    expect(findUnboundSlotReferences(TemplateLayoutSchema.parse(layout), withoutHero)).toEqual([
      'heroPhoto',
    ]);
  });
});

describe('SlotValuesSchema', () => {
  it('accepts text and image references', () => {
    expect(
      SlotValuesSchema.safeParse({
        headline: 'Hi',
        heroPhoto: { assetId: '11111111-1111-4111-8111-111111111111' },
      }).success,
    ).toBe(true);
  });

  it('rejects an image reference that is not an asset id', () => {
    // Slot values must point at an Asset row; a bare URL would bypass storage entirely.
    expect(SlotValuesSchema.safeParse({ heroPhoto: { assetId: 'not-a-uuid' } }).success).toBe(
      false,
    );
  });
});
