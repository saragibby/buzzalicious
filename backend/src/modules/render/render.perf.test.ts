import { describe, expect, it } from 'vitest';
import { TemplateLayoutSchema } from '../template/template.schemas';
import { TEMPLATES } from '../../../prisma/seed/templates';
import { compileLayout } from './compile';
import { loadFonts, loadMetrics } from './fonts';
import { ALL_ASPECT_RATIOS } from './renderer';
import { getRenderer } from './satori-renderer';
import type { BrandKit } from './bindings';

/**
 * The render budget from docs/05: a single rendition under 300ms at p95, all four under
 * one second.
 *
 * ## Why this is not a strict assertion in CI
 *
 * A wall-clock threshold on a shared runner is a classic flake. A noisy neighbour turns a
 * green build red, which trains everyone to re-run rather than to look — and a perf test
 * people re-run past is worse than none, because it also hides the real regression when
 * it eventually arrives.
 *
 * So: strict locally, where the numbers mean something and a regression is worth
 * stopping for; reported but not enforced in CI, where they mean much less. The budget
 * still shapes the design either way, which is the point of writing it early.
 */

const STRICT = !process.env.CI;

/** docs/05. */
const SINGLE_P95_MS = 300;
const FOUR_RATIO_P95_MS = 1000;

/** Enough samples for a p95 to mean something without making the suite slow. */
const ITERATIONS = 12;

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

function percentile(samples: number[], fraction: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

function report(label: string, samples: number[], budget: number): void {
  const line =
    `${label}: p50 ${percentile(samples, 0.5).toFixed(0)}ms ` +
    `p95 ${percentile(samples, 0.95).toFixed(0)}ms ` +
    `max ${Math.max(...samples).toFixed(0)}ms (budget ${budget}ms)`;

  process.stdout.write(`${line}\n`);
}

describe('render performance', () => {
  const spec = TEMPLATES.find((template) => template.slug === 'big-number')!;
  const layout = TemplateLayoutSchema.parse(spec.layout);
  const slots = {
    stat: '68%',
    context: 'of guests book again within a year of their first stay.',
  };

  it('renders a single rendition within budget at p95', { timeout: 60_000 }, async () => {
    const metrics = await loadMetrics();

    // Fonts and metrics are loaded once per process and cached. Measuring the cold load
    // would measure disk, not the renderer, and every real render after the first is warm.
    await loadFonts();

    // The very first render in a process also pays for Satori's and resvg's own one-time
    // initialisation — around a second, and nothing to do with the layout. The worker dyno
    // is long-lived, so steady state is what the budget in docs/05 describes. Measured and
    // reported separately rather than quietly dropped, because a ten-second cold start
    // would still be a problem worth seeing.
    const coldStarted = performance.now();
    await getRenderer().render(
      compileLayout({ layout, brand, slots, aspectRatio: 'SQUARE_1_1', metrics }).element,
      'SQUARE_1_1',
    );
    process.stdout.write(`cold start: ${(performance.now() - coldStarted).toFixed(0)}ms\n`);

    const samples: number[] = [];

    for (let i = 0; i < ITERATIONS; i += 1) {
      const started = performance.now();
      const compiled = compileLayout({
        layout,
        brand,
        slots,
        aspectRatio: 'SQUARE_1_1',
        metrics,
      });
      await getRenderer().render(compiled.element, 'SQUARE_1_1');
      samples.push(performance.now() - started);
    }

    report('single rendition', samples, SINGLE_P95_MS);

    if (STRICT) {
      expect(percentile(samples, 0.95)).toBeLessThan(SINGLE_P95_MS);
    }
  });

  it('renders all four ratios within budget at p95', { timeout: 60_000 }, async () => {
    const metrics = await loadMetrics();
    await loadFonts();

    const samples: number[] = [];

    for (let i = 0; i < ITERATIONS; i += 1) {
      const started = performance.now();

      // In parallel, which is how `renderPost` does it. Serially the budget is not
      // reachable and the number would not describe the product.
      await Promise.all(
        ALL_ASPECT_RATIOS.map(async (aspectRatio) => {
          const compiled = compileLayout({ layout, brand, slots, aspectRatio, metrics });
          return getRenderer().render(compiled.element, aspectRatio);
        }),
      );

      samples.push(performance.now() - started);
    }

    report('four ratios', samples, FOUR_RATIO_P95_MS);

    if (STRICT) {
      expect(percentile(samples, 0.95)).toBeLessThan(FOUR_RATIO_P95_MS);
    }
  });

  it('measures and fits without rendering, fast enough for a live preview', async () => {
    const metrics = await loadMetrics();
    const samples: number[] = [];

    // Compilation is what runs on every keystroke behind a debounce. Rasterization does
    // not, which is why previews return SVG.
    for (let i = 0; i < 100; i += 1) {
      const started = performance.now();
      compileLayout({ layout, brand, slots, aspectRatio: 'STORY_9_16', metrics });
      samples.push(performance.now() - started);
    }

    report('compile only', samples, 10);

    if (STRICT) {
      expect(percentile(samples, 0.95)).toBeLessThan(10);
    }
  });
});
