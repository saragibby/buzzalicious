/**
 * Vendors the Twemoji SVG set into `backend/assets/emoji/`.
 *
 * Like the fonts, this is not part of the build: the bundle is committed and rendering
 * never reaches the network. It runs when `TWEMOJI_TAG` moves — which is what picks up new
 * Unicode releases — and its output is reviewed as a single file rather than 4,009.
 *
 *   npm run emoji:vendor --workspace=backend
 *
 * Upstream is **jdecked/twemoji**, the maintained continuation of Twitter's project. The
 * `@twemoji/svg` package on npm is an unaffiliated repackage that relicenses the graphics
 * as MIT, which they are not; this pulls from the source of truth instead.
 */

import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { EMOJI_ASSET_DIR, EMOJI_BUNDLE_FILE, TWEMOJI_TAG } from '../src/modules/render/emoji';

async function main(): Promise<void> {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'twemoji-'));

  try {
    const tarball = `https://codeload.github.com/jdecked/twemoji/tar.gz/refs/tags/${TWEMOJI_TAG}`;
    // One tarball rather than 4,009 requests: GitHub's rate limit would refuse the latter
    // halfway through and leave a half-vendored bundle behind.
    execFileSync('bash', ['-c', `curl -sL "${tarball}" | tar -xz -C "${workDir}"`], {
      stdio: 'inherit',
    });

    const [root] = await readdir(workDir);
    const svgDir = path.join(workDir, root, 'assets', 'svg');
    const files = (await readdir(svgDir)).filter((name) => name.endsWith('.svg'));

    const bundle: Record<string, string> = {};
    for (const file of files) {
      // `1f469-200d-1f4bb.svg` -> the codepoint sequence `emoji.ts` builds from a grapheme.
      bundle[path.basename(file, '.svg')] = await readFile(path.join(svgDir, file), 'utf8');
    }

    await mkdir(EMOJI_ASSET_DIR, { recursive: true });
    // Gzipped, so the committed artefact is ~3MB rather than ~10MB and Git treats it as one
    // opaque blob instead of ten megabytes of reviewable text.
    await writeFile(EMOJI_BUNDLE_FILE, gzipSync(Buffer.from(JSON.stringify(bundle)), { level: 9 }));

    await writeFile(
      path.join(EMOJI_ASSET_DIR, 'NOTICE.md'),
      [
        '# Twemoji',
        '',
        `Graphics from [jdecked/twemoji](https://github.com/jdecked/twemoji) at \`${TWEMOJI_TAG}\`,`,
        'the maintained continuation of Twitter\'s Twemoji.',
        '',
        'Copyright 2019 Twitter, Inc and other contributors.',
        '',
        'The graphics are licensed under **CC-BY 4.0**:',
        'https://creativecommons.org/licenses/by/4.0/',
        '',
        'Attribution is required wherever these images are displayed. Buzzalicious renders',
        'them into post images, so the attribution lives here and in `docs/05-template-engine.md`.',
        '',
        `Regenerate with \`npm run emoji:vendor --workspace=backend\`. ${files.length} glyphs.`,
        '',
      ].join('\n'),
    );

    process.stdout.write(`${files.length} emoji bundled into ${EMOJI_BUNDLE_FILE}\n`);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
