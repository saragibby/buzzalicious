import type { Writable } from 'node:stream';
import archiver from 'archiver';
import type { AspectRatio } from '@prisma/client';
import type { Db } from '../../platform/db';
import { NotFoundError, ValidationError } from '../../platform/errors';
import { getLogger } from '../../platform/logger';
import type { ScopedDb } from '../../platform/tenancy';
import { renderPost } from '../render/render.service';
import { PLATFORM_SPECS, measureCaption, type SupportedPlatform } from '../template/platform-spec';
import { LINK_MARKER } from './post.schemas';
import { draftReadiness, getDraft, type DraftView } from './post.service';

/**
 * The export bundle: every rendition plus the captions, as one zip.
 *
 * This is the M3 payoff — the whole loop with no platform API involved — so it has to be
 * genuinely usable rather than a token download. What lands on disk is a folder a person
 * can open and post from: four PNGs named after the ratio, the captions as plain text
 * they can paste, and a README explaining the link placeholder, because
 * `{{link}}` appearing verbatim in someone's Instagram caption is a support ticket.
 *
 * ## Streamed, not buffered
 *
 * `archiver` pipes into the response. Four full-resolution PNGs is tens of megabytes, and
 * Heroku dynos have a hard memory ceiling — building the archive in a Buffer first would
 * work in development and be the first thing to fall over with two users exporting at
 * once.
 *
 * W6's brief lists "export/download fallback" as step 7 with a note to coordinate. This
 * is that; W6 should call it rather than build a second one.
 */

const logger = getLogger().child({ module: 'post.export' });

/** Human-facing names, so the file in someone's Downloads folder means something. */
const RATIO_LABELS: Record<AspectRatio, string> = {
  SQUARE_1_1: 'square-1x1',
  PORTRAIT_4_5: 'portrait-4x5',
  STORY_9_16: 'story-9x16',
  LANDSCAPE_16_9: 'landscape-16x9',
};

export interface ExportSummary {
  filename: string;
  renditions: { aspectRatio: AspectRatio; width: number; height: number; bytes: number }[];
  platforms: SupportedPlatform[];
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'post';
}

/** The caption a platform actually publishes: its override, or the base copy. */
export function captionFor(draft: DraftView, platform: SupportedPlatform): string {
  const target = draft.targets.find((candidate) => candidate.platform === platform);
  // `null` means inherit; `''` means the user deliberately cleared it. Only the first
  // falls back, which is the whole reason the column is nullable.
  return target?.caption ?? draft.baseCopy ?? '';
}

export function buildCaptionsFile(draft: DraftView): string {
  const sections = draft.targets.map((target) => {
    const spec = PLATFORM_SPECS[target.platform];
    const caption = captionFor(draft, target.platform);
    const count = measureCaption(target.platform, caption);

    return [
      `## ${spec.label}`,
      `${count.used} / ${count.limit} characters` +
        (count.over ? `  ⚠️  ${count.used - count.limit} over the limit — trim before posting` : ''),
      spec.linkBehavior === 'bio-only' && caption.includes(LINK_MARKER)
        ? `⚠️  ${spec.label} does not make caption links clickable. Put the link in your bio.`
        : null,
      '',
      caption || '(no caption written)',
      '',
    ]
      .filter((line) => line !== null)
      .join('\n');
  });

  return [
    `# ${draft.title ?? draft.templateName ?? 'Untitled post'}`,
    '',
    ...sections,
  ].join('\n');
}

function buildReadme(draft: DraftView, summary: { files: string[] }): string {
  const usesLink = draft.targets.some((target) =>
    captionFor(draft, target.platform).includes(LINK_MARKER),
  );

  return [
    'Buzzalicious export',
    '===================',
    '',
    `Post: ${draft.title ?? draft.templateName ?? 'Untitled'}`,
    `Exported: ${new Date().toISOString()}`,
    '',
    'What is in here',
    '---------------',
    ...summary.files.map((file) => `  ${file}`),
    '',
    'Which image goes where',
    '----------------------',
    '  square-1x1      Instagram feed, Facebook, Threads, X',
    '  portrait-4x5    Instagram feed (takes up more screen)',
    '  story-9x16      Instagram and Facebook Stories',
    '  landscape-16x9  Facebook, X, anywhere wide',
    '',
    'captions.txt has the caption for each platform, with its character count.',
    '',
    ...(usesLink
      ? [
          'About ' + LINK_MARKER,
          '-'.repeat(6 + LINK_MARKER.length),
          `Your caption contains ${LINK_MARKER}. That is a placeholder, not a link.`,
          'Replace it with your real URL before posting. When you publish through',
          'Buzzalicious instead, it is replaced automatically with a trackable short',
          'link so the clicks show up in your insights.',
          '',
        ]
      : []),
  ].join('\n');
}

export interface ExportOptions {
  /** Defaults to every ratio the template supports. */
  aspectRatios?: AspectRatio[];
  /**
   * Called once every pre-flight check has passed and immediately before the first byte
   * is written.
   *
   * This exists so the route can set `Content-Type: application/zip` at the last possible
   * moment. Setting it up front would mean a readiness failure — a 400 with details the
   * composer points at the offending slot — going out under zip headers, which browsers
   * render as a corrupt download rather than an error message.
   */
  onBeforeStream?: (draft: DraftView) => void;
}

/**
 * Render a draft and stream its bundle into `destination`.
 *
 * `scopedDb` proves the draft belongs to the caller's tenant; `db` is the unscoped client
 * the render service needs. The order matters and is not an oversight: the scope check
 * happens first and throws before `renderPost` is ever reached, so the unscoped client is
 * only ever handed a `postId` that has already been authorised. `renderPost` also writes
 * `Rendition` rows, and those are scoped through `post.brandId` — there is no column on
 * them to scope a create by.
 */
export async function streamExportBundle(
  scopedDb: ScopedDb,
  db: Db,
  postId: string,
  destination: Writable,
  options: ExportOptions = {},
): Promise<ExportSummary> {
  const draft = await getDraft(scopedDb, postId);

  const readiness = await draftReadiness(scopedDb, postId);
  if (!readiness.ready) {
    // Loud and specific, per the brief: never a silently clipped or missing image.
    throw new ValidationError('This post is not ready to export yet', {
      details: { issues: readiness.issues },
    });
  }

  if (draft.targets.length === 0) {
    throw new ValidationError('This post has no platforms selected, so there is nothing to export');
  }

  const rendered = await renderPost(db, postId, { aspectRatios: options.aspectRatios });

  if (rendered.length === 0) {
    throw new NotFoundError(
      'No renditions were produced. An image post needs a template that supports at least one ratio.',
    );
  }

  const files = [
    ...rendered.map((item) => `${RATIO_LABELS[item.aspectRatio]}.png`),
    'captions.txt',
    'README.txt',
  ];

  const archive = archiver('zip', { zlib: { level: 6 } });

  // PNGs are already compressed, so the archive is a container more than a compressor;
  // level 6 is a deliberate middle rather than burning CPU for ~1% on incompressible data.
  archive.on('warning', (error) => {
    logger.warn({ postId, err: error }, 'archiver warning during export');
  });

  const finished = new Promise<void>((resolve, reject) => {
    archive.on('error', reject);
    destination.on('error', reject);
    destination.on('close', resolve);
    destination.on('finish', resolve);
  });

  // Last point at which a failure can still become a JSON error response.
  options.onBeforeStream?.(draft);

  archive.pipe(destination);

  for (const item of rendered) {
    archive.append(item.png, { name: `${RATIO_LABELS[item.aspectRatio]}.png` });
  }

  archive.append(buildCaptionsFile(draft), { name: 'captions.txt' });
  archive.append(buildReadme(draft, { files }), { name: 'README.txt' });

  await archive.finalize();
  await finished;

  return {
    filename: exportFilename(draft),
    renditions: rendered.map((item) => ({
      aspectRatio: item.aspectRatio,
      width: item.width,
      height: item.height,
      bytes: item.bytes,
    })),
    platforms: draft.targets.map((target) => target.platform),
  };
}

/** The filename the response should advertise, resolvable before the stream starts. */
export function exportFilename(draft: DraftView): string {
  return `${slugify(draft.title ?? draft.templateName ?? 'post')}-buzzalicious.zip`;
}
