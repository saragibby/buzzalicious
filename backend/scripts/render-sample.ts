/**
 * Step 1 of the W4 build order: one hardcoded template, one ratio, straight to a PNG.
 *
 * This exists to answer one question before eight more steps are spent — *does the output
 * look good enough?* The tree below is the `big-number` seed template hand-translated into
 * what the layout compiler will later produce automatically, using Rise & Shore's real
 * seeded palette and typography. No compiler, no bindings, no cache: just fonts, Satori,
 * resvg and sharp.
 *
 *   npm run render:sample --workspace=backend -- <output-dir>
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getRenderer, type SatoriElement } from '../src/modules/render/satori-renderer';

/** Rise & Shore, from `prisma/seed/workspaces.ts`. Coastal South Carolina. */
const BRAND = {
  palette: {
    primary: '#1b4965',
    secondary: '#5fa8d3',
    accent: '#cae9ff',
    neutral: '#8a9ba8',
    background: '#fdfcf7',
    text: '#12222e',
  },
  typography: { headingFamily: 'Fraunces', bodyFamily: 'Inter' },
};

const SLOTS = {
  stat: '68%',
  context: 'of our guests book a second stay within eighteen months of their first.',
};

/** `$scale(n)` is n px on a 1080-wide reference canvas. At 1:1 that is the identity. */
const scale = (n: number): number => n;

export function bigNumberSample(): SatoriElement {
  return {
    type: 'div',
    props: {
      style: {
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        backgroundColor: BRAND.palette.primary,
        justifyContent: 'center',
        alignItems: 'flex-start',
        padding: scale(72),
      },
      children: [
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              color: BRAND.palette.accent,
              fontFamily: BRAND.typography.headingFamily,
              fontSize: scale(300),
              fontWeight: 900,
              lineHeight: 1,
            },
            children: SLOTS.stat,
          },
        },
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              marginTop: scale(28),
              width: scale(120),
              height: scale(8),
              backgroundColor: BRAND.palette.secondary,
              borderRadius: scale(4),
            },
            children: [],
          },
        },
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              marginTop: scale(36),
              maxWidth: scale(760),
              color: BRAND.palette.background,
              fontFamily: BRAND.typography.bodyFamily,
              fontSize: scale(46),
              fontWeight: 400,
              lineHeight: 1.35,
            },
            children: SLOTS.context,
          },
        },
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              marginTop: 'auto',
              color: BRAND.palette.secondary,
              fontFamily: BRAND.typography.bodyFamily,
              fontSize: scale(28),
              fontWeight: 600,
              letterSpacing: scale(2),
            },
            children: 'RISE & SHORE',
          },
        },
      ],
    },
  };
}

async function main(): Promise<void> {
  const outputDir = process.argv[2] ?? path.resolve(__dirname, '../../.render-samples');
  await mkdir(outputDir, { recursive: true });

  const renderer = getRenderer();
  const result = await renderer.render(bigNumberSample(), 'SQUARE_1_1');
  const target = path.join(outputDir, 'step1-big-number-1x1.png');
  await writeFile(target, result.png);

  process.stdout.write(
    `${target}\n${result.width}x${result.height} · ${result.png.byteLength} bytes · ${result.durationMs}ms\n`,
  );
}

if (require.main === module) {
  main().catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  });
}
