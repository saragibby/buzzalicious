import { beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { TemplateLayoutSchema, type TemplateLayout } from '../template/template.schemas';
import { TEMPLATES } from '../../../prisma/seed/templates';
import { compileLayout } from './compile';
import { loadMetrics } from './fonts';
import { ALL_ASPECT_RATIOS } from './renderer';
import { PLATFORM_DEFAULT } from './safe-area';
import { getRenderer } from './satori-renderer';
import type { BrandKit } from './bindings';

/**
 * The compiler, exercised against W2's real seeded templates rather than fixtures.
 *
 * A layout that only renders the tree a test invented is not evidence of anything. These
 * use the templates that actually ship, with a brand kit shaped like a seeded one.
 */

/**
 * Loaded once for the file. Not top-level `await`: the backend compiles to CommonJS, so
 * `tsc` rejects it even though Vitest runs it happily — a green test run and a red build.
 */
let metrics: Awaited<ReturnType<typeof loadMetrics>>;

beforeAll(async () => {
  metrics = await loadMetrics();
});

const brand: BrandKit = {
  palette: {
    primary: '#1b4332',
    secondary: '#2d6a4f',
    accent: '#f4a259',
    neutral: '#d8d5cd',
    background: '#fdfcf7',
    text: '#12222e',
  },
  typography: {
    headingFamily: 'Fraunces',
    bodyFamily: 'Inter',
    headingWeight: 700,
    bodyWeight: 400,
    headingTransform: 'none',
  },
};

/** A 1x1 PNG. Enough for Satori to place an image without a fixture file. */
const PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function templateBySlug(slug: string) {
  const spec = TEMPLATES.find((template) => template.slug === slug);
  if (!spec) throw new Error(`No seeded template "${slug}"`);
  return { spec, layout: TemplateLayoutSchema.parse(spec.layout) };
}

/** Fill every slot, text at exactly `maxLength` when asked for the worst case. */
function fillSlots(
  spec: (typeof TEMPLATES)[number],
  mode: 'realistic' | 'max',
): { slots: Record<string, string>; images: Record<string, string> } {
  const slots: Record<string, string> = {};
  const images: Record<string, string> = {};

  for (const [name, definition] of Object.entries(spec.slotSchema)) {
    if (definition.type === 'image') {
      images[name] = PIXEL;
      continue;
    }

    slots[name] =
      mode === 'max'
        ? // Wide characters at full length: the worst input the slot schema permits.
          'W'.repeat(definition.maxLength)
        : 'Lorem ipsum dolor sit amet consectetur'.slice(0, definition.maxLength);
  }

  return { slots, images };
}

describe('compileLayout', () => {
  // Renders the whole seeded set at every ratio, so the default 5s is not enough — and a
  // sweep that only passes when the machine is idle is a flake, not a check.
  it(
    'renders every seeded template at every ratio it claims to support',
    { timeout: 60_000 },
    async () => {
      for (const spec of TEMPLATES) {
        const layout = TemplateLayoutSchema.parse(spec.layout);
        const { slots, images } = fillSlots(spec, 'realistic');

        for (const aspectRatio of spec.ratios) {
          const compiled = compileLayout({ layout, brand, slots, images, aspectRatio, metrics });
          const image = await getRenderer().render(compiled.element, aspectRatio);

          expect(image.png.byteLength, `${spec.slug} ${aspectRatio}`).toBeGreaterThan(0);
          expect(compiled.overflows, `${spec.slug} ${aspectRatio}`).toEqual([]);
        }
      }
    },
  );

  /**
   * The `$fit` acceptance criterion: max-length slot input, every ratio a template claims.
   *
   * `maxLength` is the promise the slot schema makes to the composer — the composer will
   * let a user type exactly that many characters — so text at exactly that length must
   * render. If it does not, either the bound or the template is wrong, and this is where
   * that surfaces rather than in a client's feed.
   *
   * Scoped to declared ratios on purpose. A template that does not claim 16:9 has not
   * been designed for it, and `five-step-checklist` is the proof that the restriction is
   * real rather than an oversight: five rows of body copy do not fit 675px of height at a
   * readable size, which is precisely why it lists portrait and story only.
   */
  it(
    'fits max-length slot input at every ratio a template supports',
    { timeout: 60_000 },
    async () => {
      for (const spec of TEMPLATES) {
        const layout = TemplateLayoutSchema.parse(spec.layout);
        const { slots, images } = fillSlots(spec, 'max');

        for (const aspectRatio of spec.ratios) {
          const compiled = compileLayout({ layout, brand, slots, images, aspectRatio, metrics });

          expect(
            compiled.overflows,
            `${spec.slug} overflowed at ${aspectRatio} with max-length input`,
          ).toEqual([]);
        }
      }
    },
  );

  it('covers all four ratios across the seeded set', () => {
    // The acceptance criteria are stated for four ratios, so the registry has to actually
    // offer four. Before W4 the seed had no landscape template at all.
    const covered = new Set(TEMPLATES.flatMap((spec) => spec.ratios));

    for (const ratio of ALL_ASPECT_RATIOS) {
      expect([...covered], `no seeded template supports ${ratio}`).toContain(ratio);
    }
  });

  it('reports which nodes $fit had to shrink', () => {
    const { spec, layout } = templateBySlug('big-number');
    const { slots, images } = fillSlots(spec, 'max');

    // 16:9 is the shortest canvas, so it is where shrinking actually bites.
    const compiled = compileLayout({
      layout,
      brand,
      slots,
      images,
      aspectRatio: 'LANDSCAPE_16_9',
      metrics,
    });

    expect(compiled.fittedDown.length).toBeGreaterThan(0);
  });

  it('fails loudly when content cannot fit even at the minimum size', () => {
    // Silent clipping is the failure docs/05 singles out: it produces a technically
    // successful render that nobody can publish and nothing surfaces.
    const layout: TemplateLayout = {
      version: 1,
      root: {
        type: 'stack',
        direction: 'column',
        style: { padding: '$scale(48)' },
        children: [
          {
            type: 'text',
            id: 'headline',
            content: '$slot.headline',
            style: { fontSize: '$fit(64, 56)', lineHeight: 1.2 },
          },
        ],
      },
    };

    const compiled = compileLayout({
      layout,
      brand,
      slots: { headline: 'word '.repeat(400) },
      aspectRatio: 'SQUARE_1_1',
      metrics,
    });

    expect(compiled.overflows).toHaveLength(1);
    expect(compiled.overflows[0].node).toBe('headline');
    expect(compiled.overflows[0].slot).toBe('headline');
    expect(compiled.overflows[0].overflowPx).toBeGreaterThan(0);
  });

  it('renders a brand with no logo rather than refusing the whole image', async () => {
    const { spec, layout } = templateBySlug('big-number');
    const { slots, images } = fillSlots(spec, 'realistic');

    const compiled = compileLayout({
      layout,
      brand: { ...brand, logo: undefined },
      slots,
      images,
      aspectRatio: 'SQUARE_1_1',
      metrics,
    });

    await expect(getRenderer().render(compiled.element, 'SQUARE_1_1')).resolves.toBeTruthy();
  });

  it('refuses an image slot whose asset was never resolved', () => {
    // Satori performs no I/O, so an unresolved image renders as nothing at all. Better to
    // fail than to publish a template with a hole in it.
    const { spec, layout } = templateBySlug('stat-with-photo');
    const { slots } = fillSlots(spec, 'realistic');

    expect(() =>
      compileLayout({ layout, brand, slots, images: {}, aspectRatio: 'SQUARE_1_1', metrics }),
    ).toThrow(/no resolved asset/i);
  });

  it('scales dimensions with the canvas, so one layout serves four ratios', async () => {
    const { spec, layout } = templateBySlug('big-number');
    const { slots, images } = fillSlots(spec, 'realistic');

    for (const aspectRatio of ALL_ASPECT_RATIOS) {
      const compiled = compileLayout({ layout, brand, slots, images, aspectRatio, metrics });
      const image = await getRenderer().render(compiled.element, aspectRatio);
      const meta = await sharp(image.png).metadata();

      expect(meta.width).toBe(image.width);
      expect(meta.height).toBe(image.height);
    }
  });
});

describe('determinism', () => {
  /**
   * Compared as raw pixels, not as file bytes. PNG encoders differ between architectures
   * and sharp versions, so byte equality would fail on a machine where the images are
   * identical — a false alarm that teaches people to ignore the test.
   */
  it('produces identical pixels for identical inputs', async () => {
    const { spec, layout } = templateBySlug('big-number');
    const { slots, images } = fillSlots(spec, 'realistic');

    const render = async (): Promise<Buffer> => {
      const compiled = compileLayout({
        layout,
        brand,
        slots,
        images,
        aspectRatio: 'SQUARE_1_1',
        metrics,
      });
      const image = await getRenderer().render(compiled.element, 'SQUARE_1_1');
      return sharp(image.png).raw().toBuffer();
    };

    const [first, second] = await Promise.all([render(), render()]);

    expect(first.equals(second)).toBe(true);
  });
});

describe('safe areas, in pixels', () => {
  /**
   * The unit tests in safe-area.test.ts assert the arithmetic. This asserts the result:
   * that nothing is actually drawn under where Instagram puts its Stories chrome.
   *
   * Arithmetic that is right but not wired into the frame produces exactly the bug this
   * catches — a correct `contentBox` that nothing consumes, and a headline sitting under
   * the profile row.
   */
  const bandIsClear = async (
    png: Buffer,
    width: number,
    from: number,
    to: number,
  ): Promise<boolean> => {
    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    const channels = info.channels;

    // The background colour, sampled from a corner. Comparing against it rather than
    // against white means this still works for a dark or accent-filled canvas.
    const background = [data[0], data[1], data[2]];

    for (let y = from; y < to; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const at = (y * width + x) * channels;

        for (let channel = 0; channel < 3; channel += 1) {
          // A couple of levels of tolerance for antialiasing against the band edge.
          if (Math.abs(data[at + channel] - background[channel]) > 2) {
            return false;
          }
        }
      }
    }

    return true;
  };

  it('draws nothing under the Stories chrome at 9:16', async () => {
    const { spec, layout } = templateBySlug('big-number');
    const { slots, images } = fillSlots(spec, 'max');

    const compiled = compileLayout({
      layout,
      brand,
      slots,
      images,
      aspectRatio: 'STORY_9_16',
      metrics,
    });
    const image = await getRenderer().render(compiled.element, 'STORY_9_16');

    const top = Math.floor(image.height * PLATFORM_DEFAULT.STORY_9_16.top!);
    const bottom = Math.ceil(image.height * (1 - PLATFORM_DEFAULT.STORY_9_16.bottom!));

    await expect(bandIsClear(image.png, image.width, 0, top)).resolves.toBe(true);
    await expect(bandIsClear(image.png, image.width, bottom, image.height)).resolves.toBe(true);
  });

  it('does not reserve chrome on ratios that have none', async () => {
    // The flip side of the decision: only 9:16 pays for overlay it can predict. If square
    // silently inherited the Stories inset it would waste a fifth of the canvas forever.
    expect(PLATFORM_DEFAULT.SQUARE_1_1).toEqual({});
    expect(PLATFORM_DEFAULT.LANDSCAPE_16_9).toEqual({});
  });
});
