import { AspectRatio, TemplateKind, TemplateStatus } from '@prisma/client';
import type { Db } from '../../src/platform/db';
import {
  SlotSchemaSchema,
  TemplateLayoutSchema,
  findUnboundSlotReferences,
  type TemplateArchetype,
  type TemplateLayout,
  type TemplateSlotSchema,
} from '../../src/modules/template/template.schemas';
import { categoryId } from './taxonomy';
import { seedId } from './deterministic';

/**
 * The global starter template library (ADR-0010: templates are shared platform-wide).
 *
 * Every archetype in docs/05 is represented, because the recommendation scorer picks by
 * archetype: a category whose priors favour `before-after` and finds no published
 * before-after template silently falls back to whatever else exists, which looks like bad
 * recommendations rather than a missing template.
 *
 * Every layout here is parsed through `TemplateLayoutSchema` and cross-checked against its
 * `slotSchema` before it is written. A seed that quietly inserts an unrenderable template
 * hands W4 a bug that looks like theirs.
 */

interface TemplateSpec {
  slug: string;
  name: string;
  description: string;
  archetype: TemplateArchetype;
  kind: TemplateKind;
  ratios: AspectRatio[];
  /** Category slugs this template is tagged for, with hand-assigned relevance. */
  tags: { category: string; weight: number }[];
  slotSchema: TemplateSlotSchema;
  layout: TemplateLayout;
}

const ALL_RATIOS: AspectRatio[] = [
  AspectRatio.SQUARE_1_1,
  AspectRatio.PORTRAIT_4_5,
  AspectRatio.STORY_9_16,
];

/** Story chrome sits over roughly the top 8% and bottom 12%. See docs/05. */
const STORY_SAFE_AREA = { top: 0.08, bottom: 0.12 };

export const TEMPLATES: TemplateSpec[] = [
  {
    slug: 'big-number',
    name: 'Big Number',
    description: 'One number, one line of context. The highest-contrast way to state a fact.',
    archetype: 'stat-callout',
    kind: TemplateKind.IMAGE,
    ratios: ALL_RATIOS,
    tags: [
      { category: 'professional-services', weight: 1 },
      { category: 'tax-prep', weight: 1 },
      { category: 'health-and-wellness', weight: 0.6 },
    ],
    slotSchema: {
      stat: {
        type: 'text',
        required: true,
        maxLength: 8,
        label: 'The number',
        aiHint: 'A short figure such as "$2,400" or "68%". Digits, not a sentence.',
      },
      context: {
        type: 'text',
        required: true,
        maxLength: 90,
        multiline: true,
        label: 'What it means',
        aiHint: 'One sentence explaining why the number matters to the reader.',
      },
    },
    layout: {
      version: 1,
      canvas: { byRatio: { STORY_9_16: STORY_SAFE_AREA } },
      root: {
        type: 'stack',
        direction: 'column',
        style: {
          backgroundColor: '$brand.palette.primary',
          justifyContent: 'center',
          alignItems: 'flex-start',
          padding: '$scale(72)',
          gap: '$scale(24)',
        },
        children: [
          {
            type: 'text',
            id: 'stat',
            content: '$slot.stat',
            style: {
              color: '$brand.palette.background',
              fontFamily: '$brand.typography.headingFamily',
              fontSize: '$fit(180, 96)',
              fontWeight: 800,
              lineHeight: 1,
            },
          },
          {
            type: 'text',
            id: 'context',
            content: '$slot.context',
            style: {
              color: '$brand.palette.background',
              fontFamily: '$brand.typography.bodyFamily',
              fontSize: '$fit(44, 28)',
              lineHeight: 1.3,
            },
          },
          { type: 'logo', style: { width: '$scale(120)', marginTop: '$scale(32)' } },
        ],
      },
    },
  },
  {
    slug: 'stat-with-photo',
    name: 'Stat Over Photo',
    description: 'A statistic laid over a brand photo, for when the number needs a place.',
    archetype: 'stat-callout',
    kind: TemplateKind.IMAGE,
    ratios: ALL_RATIOS,
    tags: [
      { category: 'hospitality-and-travel', weight: 0.9 },
      { category: 'vacation-rental', weight: 1 },
      { category: 'real-estate-agent', weight: 0.8 },
    ],
    slotSchema: {
      background: {
        type: 'image',
        required: true,
        minWidth: 1080,
        aspectHint: '4:5',
        label: 'Background photo',
        aiHint: 'A wide, uncluttered photo with room for text in the lower third.',
      },
      stat: { type: 'text', required: true, maxLength: 10, label: 'The number' },
      context: { type: 'text', required: true, maxLength: 70, label: 'What it means' },
    },
    layout: {
      version: 1,
      canvas: { safeArea: { bottom: 0.04 }, byRatio: { STORY_9_16: STORY_SAFE_AREA } },
      root: {
        type: 'stack',
        direction: 'column',
        style: { justifyContent: 'flex-end', width: '100%', height: '100%' },
        children: [
          {
            type: 'image',
            id: 'background',
            source: '$slot.background',
            style: { position: 'absolute', width: '100%', height: '100%', objectFit: 'cover' },
          },
          {
            type: 'stack',
            direction: 'column',
            style: {
              backgroundColor: 'rgba(0,0,0,0.55)',
              padding: '$scale(56)',
              gap: '$scale(12)',
            },
            children: [
              {
                type: 'text',
                content: '$slot.stat',
                style: {
                  color: '#ffffff',
                  fontFamily: '$brand.typography.headingFamily',
                  fontSize: '$fit(140, 72)',
                  fontWeight: 800,
                },
              },
              {
                type: 'text',
                content: '$slot.context',
                style: { color: '#ffffff', fontSize: '$fit(40, 26)' },
              },
            ],
          },
        ],
      },
    },
  },
  {
    slug: 'three-tip-list',
    name: 'Three-Tip List',
    description: 'Three short, numbered tips. The workhorse for expertise-led categories.',
    archetype: 'tip-list',
    kind: TemplateKind.IMAGE,
    ratios: ALL_RATIOS,
    tags: [
      { category: 'professional-services', weight: 1 },
      { category: 'home-and-trades', weight: 0.8 },
      { category: 'health-and-wellness', weight: 0.9 },
      { category: 'tax-prep', weight: 1 },
    ],
    slotSchema: {
      heading: { type: 'text', required: true, maxLength: 48, label: 'Heading' },
      tipOne: { type: 'text', required: true, maxLength: 70, label: 'Tip 1' },
      tipTwo: { type: 'text', required: true, maxLength: 70, label: 'Tip 2' },
      tipThree: { type: 'text', required: true, maxLength: 70, label: 'Tip 3' },
    },
    layout: {
      version: 1,
      canvas: { byRatio: { STORY_9_16: STORY_SAFE_AREA } },
      root: {
        type: 'stack',
        direction: 'column',
        style: {
          backgroundColor: '$brand.palette.background',
          padding: '$scale(64)',
          gap: '$scale(28)',
          justifyContent: 'center',
        },
        children: [
          {
            type: 'text',
            content: '$slot.heading',
            style: {
              color: '$brand.palette.text',
              fontFamily: '$brand.typography.headingFamily',
              fontSize: '$fit(64, 40)',
              fontWeight: 700,
            },
          },
          {
            type: 'stack',
            direction: 'column',
            style: { gap: '$scale(18)' },
            children: [
              {
                type: 'text',
                content: '$slot.tipOne',
                style: { color: '$brand.palette.text', fontSize: '$fit(38, 26)' },
              },
              {
                type: 'text',
                content: '$slot.tipTwo',
                style: { color: '$brand.palette.text', fontSize: '$fit(38, 26)' },
              },
              {
                type: 'text',
                content: '$slot.tipThree',
                style: { color: '$brand.palette.text', fontSize: '$fit(38, 26)' },
              },
            ],
          },
          { type: 'logo', style: { width: '$scale(110)' } },
        ],
      },
    },
  },
  {
    slug: 'five-step-checklist',
    name: 'Five-Step Checklist',
    description: 'A longer list for seasonal or procedural content.',
    archetype: 'tip-list',
    kind: TemplateKind.IMAGE,
    ratios: [AspectRatio.PORTRAIT_4_5, AspectRatio.STORY_9_16],
    tags: [
      { category: 'tax-prep', weight: 1 },
      { category: 'bookkeeping', weight: 0.9 },
      { category: 'education-and-community', weight: 0.6 },
    ],
    slotSchema: {
      heading: { type: 'text', required: true, maxLength: 44, label: 'Heading' },
      stepOne: { type: 'text', required: true, maxLength: 56, label: 'Step 1' },
      stepTwo: { type: 'text', required: true, maxLength: 56, label: 'Step 2' },
      stepThree: { type: 'text', required: true, maxLength: 56, label: 'Step 3' },
      stepFour: { type: 'text', required: false, maxLength: 56, label: 'Step 4' },
      stepFive: { type: 'text', required: false, maxLength: 56, label: 'Step 5' },
    },
    layout: {
      version: 1,
      canvas: { byRatio: { STORY_9_16: STORY_SAFE_AREA } },
      root: {
        type: 'stack',
        direction: 'column',
        style: {
          backgroundColor: '$brand.palette.background',
          padding: '$scale(60)',
          gap: '$scale(16)',
        },
        children: [
          {
            type: 'text',
            content: '$slot.heading',
            style: {
              color: '$brand.palette.primary',
              fontFamily: '$brand.typography.headingFamily',
              fontSize: '$fit(56, 36)',
              fontWeight: 700,
            },
          },
          {
            type: 'text',
            content: '$slot.stepOne',
            style: { color: '$brand.palette.text', fontSize: '$fit(34, 24)' },
          },
          {
            type: 'text',
            content: '$slot.stepTwo',
            style: { color: '$brand.palette.text', fontSize: '$fit(34, 24)' },
          },
          {
            type: 'text',
            content: '$slot.stepThree',
            style: { color: '$brand.palette.text', fontSize: '$fit(34, 24)' },
          },
          {
            type: 'text',
            content: '$slot.stepFour',
            style: { color: '$brand.palette.text', fontSize: '$fit(34, 24)' },
          },
          {
            type: 'text',
            content: '$slot.stepFive',
            style: { color: '$brand.palette.text', fontSize: '$fit(34, 24)' },
          },
        ],
      },
    },
  },
  {
    slug: 'before-after-split',
    name: 'Before & After Split',
    description: 'Two photos side by side. The proof format for trades and beauty.',
    archetype: 'before-after',
    kind: TemplateKind.IMAGE,
    ratios: [AspectRatio.SQUARE_1_1, AspectRatio.PORTRAIT_4_5],
    tags: [
      { category: 'home-and-trades', weight: 1 },
      { category: 'beauty-and-personal-care', weight: 1 },
      { category: 'landscaping', weight: 1 },
    ],
    slotSchema: {
      beforeImage: { type: 'image', required: true, aspectHint: '1:1', label: 'Before' },
      afterImage: { type: 'image', required: true, aspectHint: '1:1', label: 'After' },
      caption: { type: 'text', required: false, maxLength: 60, label: 'Caption' },
    },
    layout: {
      version: 1,
      root: {
        type: 'stack',
        direction: 'column',
        style: { backgroundColor: '$brand.palette.background', gap: '$scale(8)' },
        children: [
          {
            type: 'stack',
            direction: 'row',
            style: { gap: '$scale(8)', flexGrow: 1 },
            children: [
              {
                type: 'image',
                source: '$slot.beforeImage',
                style: { width: '50%', objectFit: 'cover' },
              },
              {
                type: 'image',
                source: '$slot.afterImage',
                style: { width: '50%', objectFit: 'cover' },
              },
            ],
          },
          {
            type: 'text',
            content: '$slot.caption',
            style: {
              color: '$brand.palette.text',
              fontSize: '$fit(36, 24)',
              padding: '$scale(28)',
            },
          },
        ],
      },
    },
  },
  {
    slug: 'testimonial-quote',
    name: 'Testimonial Quote',
    description: 'A customer quote with attribution, set large.',
    archetype: 'testimonial',
    kind: TemplateKind.IMAGE,
    ratios: ALL_RATIOS,
    tags: [
      { category: 'hospitality-and-travel', weight: 1 },
      { category: 'professional-services', weight: 0.9 },
      { category: 'vacation-rental', weight: 1 },
      { category: 'home-and-trades', weight: 0.8 },
    ],
    slotSchema: {
      quote: {
        type: 'text',
        required: true,
        maxLength: 180,
        multiline: true,
        label: 'Quote',
        aiHint: 'A real customer sentence. Do not invent one.',
      },
      attribution: { type: 'text', required: true, maxLength: 40, label: 'Who said it' },
    },
    layout: {
      version: 1,
      canvas: { byRatio: { STORY_9_16: STORY_SAFE_AREA } },
      root: {
        type: 'stack',
        direction: 'column',
        style: {
          backgroundColor: '$brand.palette.accent',
          padding: '$scale(72)',
          gap: '$scale(32)',
          justifyContent: 'center',
        },
        children: [
          {
            type: 'text',
            content: '$slot.quote',
            style: {
              color: '$brand.palette.text',
              fontFamily: '$brand.typography.headingFamily',
              fontSize: '$fit(56, 30)',
              lineHeight: 1.25,
            },
          },
          {
            type: 'text',
            content: '$slot.attribution',
            style: { color: '$brand.palette.text', fontSize: '$fit(32, 22)', fontWeight: 600 },
          },
        ],
      },
    },
  },
  {
    slug: 'product-feature',
    name: 'Product Feature',
    description: 'One product, its name, and the reason to care.',
    archetype: 'product-feature',
    kind: TemplateKind.IMAGE,
    ratios: ALL_RATIOS,
    tags: [
      { category: 'retail-and-ecommerce', weight: 1 },
      { category: 'food-and-drink', weight: 0.9 },
    ],
    slotSchema: {
      productImage: { type: 'image', required: true, aspectHint: '1:1', label: 'Product photo' },
      name: { type: 'text', required: true, maxLength: 40, label: 'Product name' },
      pitch: { type: 'text', required: true, maxLength: 80, label: 'Why it matters' },
      price: { type: 'text', required: false, maxLength: 12, label: 'Price' },
    },
    layout: {
      version: 1,
      canvas: { byRatio: { STORY_9_16: STORY_SAFE_AREA } },
      root: {
        type: 'stack',
        direction: 'column',
        style: { backgroundColor: '$brand.palette.background' },
        children: [
          {
            type: 'image',
            source: '$slot.productImage',
            style: { width: '100%', height: '62%', objectFit: 'cover' },
          },
          {
            type: 'stack',
            direction: 'column',
            style: { padding: '$scale(48)', gap: '$scale(12)' },
            children: [
              {
                type: 'text',
                content: '$slot.name',
                style: {
                  color: '$brand.palette.text',
                  fontFamily: '$brand.typography.headingFamily',
                  fontSize: '$fit(56, 34)',
                  fontWeight: 700,
                },
              },
              {
                type: 'text',
                content: '$slot.pitch',
                style: { color: '$brand.palette.text', fontSize: '$fit(34, 24)' },
              },
              {
                type: 'text',
                content: '$slot.price',
                style: {
                  color: '$brand.palette.primary',
                  fontSize: '$fit(40, 26)',
                  fontWeight: 700,
                },
              },
            ],
          },
        ],
      },
    },
  },
  {
    slug: 'announcement-card',
    name: 'Announcement Card',
    description: 'Dated news: an opening, a closure, a new offering.',
    archetype: 'announcement',
    kind: TemplateKind.IMAGE,
    ratios: ALL_RATIOS,
    tags: [
      { category: 'food-and-drink', weight: 0.9 },
      { category: 'retail-and-ecommerce', weight: 0.9 },
      { category: 'education-and-community', weight: 0.9 },
      { category: 'hospitality-and-travel', weight: 0.8 },
    ],
    slotSchema: {
      eyebrow: {
        type: 'text',
        required: false,
        maxLength: 24,
        default: 'ANNOUNCEMENT',
        label: 'Eyebrow',
      },
      headline: { type: 'text', required: true, maxLength: 60, label: 'Headline' },
      detail: { type: 'text', required: true, maxLength: 110, multiline: true, label: 'Detail' },
    },
    layout: {
      version: 1,
      canvas: { byRatio: { STORY_9_16: STORY_SAFE_AREA } },
      root: {
        type: 'stack',
        direction: 'column',
        style: {
          backgroundColor: '$brand.palette.background',
          padding: '$scale(64)',
          gap: '$scale(20)',
          justifyContent: 'center',
        },
        children: [
          {
            type: 'text',
            content: '$slot.eyebrow',
            style: {
              color: '$brand.palette.primary',
              fontSize: '$fit(28, 18)',
              letterSpacing: 4,
              fontWeight: 700,
            },
          },
          {
            type: 'text',
            content: '$slot.headline',
            style: {
              color: '$brand.palette.text',
              fontFamily: '$brand.typography.headingFamily',
              fontSize: '$fit(72, 40)',
              fontWeight: 800,
              lineHeight: 1.1,
            },
          },
          {
            type: 'text',
            content: '$slot.detail',
            style: { color: '$brand.palette.text', fontSize: '$fit(36, 24)', lineHeight: 1.35 },
          },
          { type: 'logo', style: { width: '$scale(110)', marginTop: '$scale(24)' } },
        ],
      },
    },
  },
  {
    slug: 'question-hook',
    name: 'Question Hook',
    description: 'A question set large, designed to be answered in the comments.',
    archetype: 'question-hook',
    kind: TemplateKind.IMAGE,
    ratios: ALL_RATIOS,
    tags: [
      { category: 'health-and-wellness', weight: 0.8 },
      { category: 'professional-services', weight: 0.8 },
      { category: 'hospitality-and-travel', weight: 0.7 },
    ],
    slotSchema: {
      question: {
        type: 'text',
        required: true,
        maxLength: 90,
        multiline: true,
        label: 'Question',
        aiHint: 'An open question with a genuinely debatable answer.',
      },
      prompt: {
        type: 'text',
        required: false,
        maxLength: 40,
        default: 'Tell us below',
        label: 'Call to action',
      },
    },
    layout: {
      version: 1,
      canvas: { byRatio: { STORY_9_16: STORY_SAFE_AREA } },
      root: {
        type: 'stack',
        direction: 'column',
        style: {
          backgroundColor: '$brand.palette.secondary',
          padding: '$scale(80)',
          gap: '$scale(40)',
          justifyContent: 'center',
          alignItems: 'center',
        },
        children: [
          {
            type: 'text',
            content: '$slot.question',
            style: {
              color: '$brand.palette.background',
              fontFamily: '$brand.typography.headingFamily',
              fontSize: '$fit(76, 40)',
              textAlign: 'center',
              lineHeight: 1.2,
            },
          },
          {
            type: 'text',
            content: '$slot.prompt',
            style: { color: '$brand.palette.background', fontSize: '$fit(32, 22)' },
          },
        ],
      },
    },
  },
  {
    slug: 'behind-the-scenes',
    name: 'Behind the Scenes',
    description: 'A working photo with a caption. The least polished format on purpose.',
    archetype: 'behind-the-scenes',
    kind: TemplateKind.IMAGE,
    ratios: ALL_RATIOS,
    tags: [
      { category: 'food-and-drink', weight: 0.9 },
      { category: 'hospitality-and-travel', weight: 0.9 },
      { category: 'vacation-rental', weight: 0.9 },
      { category: 'home-and-trades', weight: 0.7 },
    ],
    slotSchema: {
      photo: { type: 'image', required: true, aspectHint: '4:5', label: 'Photo' },
      caption: { type: 'text', required: true, maxLength: 100, multiline: true, label: 'Caption' },
    },
    layout: {
      version: 1,
      canvas: { byRatio: { STORY_9_16: STORY_SAFE_AREA } },
      root: {
        type: 'stack',
        direction: 'column',
        style: { backgroundColor: '$brand.palette.background' },
        children: [
          {
            type: 'image',
            source: '$slot.photo',
            style: { width: '100%', height: '78%', objectFit: 'cover' },
          },
          {
            type: 'text',
            content: '$slot.caption',
            style: {
              color: '$brand.palette.text',
              fontSize: '$fit(34, 22)',
              padding: '$scale(36)',
              lineHeight: 1.3,
            },
          },
        ],
      },
    },
  },
  {
    slug: 'plain-text-take',
    name: 'Plain Text Take',
    description:
      'A text-only post for X and Threads. Renders no image — the copy is the whole post.',
    archetype: 'question-hook',
    // TEXT_ONLY templates still carry a layout so the composer can preview them, but the
    // publish path produces zero renditions. See the Post.mediaType note in docs/02.
    kind: TemplateKind.TEXT_ONLY,
    ratios: [],
    tags: [
      { category: 'professional-services', weight: 0.9 },
      { category: 'tax-prep', weight: 1 },
    ],
    slotSchema: {
      body: {
        type: 'text',
        required: true,
        maxLength: 260,
        multiline: true,
        label: 'Post text',
        aiHint: 'A complete standalone post. No image will accompany it.',
      },
    },
    layout: {
      version: 1,
      root: {
        type: 'text',
        content: '$slot.body',
        style: { color: '$brand.palette.text', fontSize: 32 },
      },
    },
  },
];

export function templateId(slug: string): string {
  return seedId('template', slug);
}

/**
 * Validate every template before writing it.
 *
 * Exported so the test suite can assert the same thing without a database: the library
 * being renderable is a property of the data, not of the environment.
 */
export function assertTemplatesAreRenderable(): void {
  for (const spec of TEMPLATES) {
    const slotSchema = SlotSchemaSchema.parse(spec.slotSchema);
    const layout = TemplateLayoutSchema.parse(spec.layout);

    const unbound = findUnboundSlotReferences(layout, slotSchema);
    if (unbound.length > 0) {
      throw new Error(
        `Template "${spec.slug}" binds slots that its slotSchema does not declare: ` +
          `${unbound.join(', ')}. Satori renders nothing where the value should be, so this ` +
          'publishes as a hole in the image rather than failing.',
      );
    }

    if (spec.kind !== 'TEXT_ONLY' && spec.ratios.length === 0) {
      throw new Error(`Template "${spec.slug}" renders an image but supports no aspect ratios`);
    }
  }
}

export async function seedTemplates(db: Db): Promise<number> {
  assertTemplatesAreRenderable();

  for (const spec of TEMPLATES) {
    const id = templateId(spec.slug);
    const data = {
      slug: spec.slug,
      name: spec.name,
      description: spec.description,
      archetype: spec.archetype,
      kind: spec.kind,
      // Every seeded template is platform-global (ADR-0010).
      workspaceId: null,
      slotSchema: spec.slotSchema,
      layout: spec.layout,
      supportedRatios: spec.ratios,
      status: TemplateStatus.PUBLISHED,
    };

    await db.template.upsert({ where: { id }, create: { id, ...data }, update: data });

    for (const tag of spec.tags) {
      await db.templateCategoryTag.upsert({
        where: { templateId_categoryId: { templateId: id, categoryId: categoryId(tag.category) } },
        create: { templateId: id, categoryId: categoryId(tag.category), weight: tag.weight },
        update: { weight: tag.weight },
      });
    }
  }

  return TEMPLATES.length;
}
