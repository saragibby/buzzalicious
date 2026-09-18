import { NotFoundError, ValidationError } from '../../platform/errors';
import type { ScopedDb } from '../../platform/tenancy';
import { generateTextMetered, type MeteringClient } from '../ai/metered';
import { BrandVoiceGuideSchema, type BrandVoiceGuide } from '../brand/brand.schemas';
import { SlotSchemaSchema, SlotValuesSchema } from '../template/template.schemas';
import {
  isSupportedPlatform,
  specFor,
  type SupportedPlatform,
} from '../template/platform-spec';
import { LINK_MARKER, type GenerateCaptionInput } from './post.schemas';

/**
 * Caption drafting for the composer.
 *
 * ## One call, not four
 *
 * A generate produces the **base** caption only. The four per-platform overrides start as
 * a copy of it that the user edits. Generating natively per platform would read better in
 * a demo and cost four metered provider calls per click for text a user rewrites anyway —
 * and W10's ceiling is a real constraint, not a formality. A per-platform rewrite is a
 * separate deliberate action if it is ever wanted.
 *
 * ## What the model is told
 *
 * The brand voice guide, and what the user actually typed into the slots — labelled by
 * the slot's `aiHint`, which is the field docs/05 put there for exactly this. A caption
 * generated from the template's *name* would be generic, which is the thing this product
 * exists not to be.
 *
 * Nothing the model returns is trusted as final: it is a draft the user edits, and the
 * composer says so.
 */

/** Rendered voice guide. Prose, not JSON — models follow prose instructions better. */
export function describeVoice(guide: BrandVoiceGuide): string {
  const lines = [
    guide.summary,
    `Tone: ${guide.toneAttributes.join(', ')}.`,
    `Reading level: ${guide.readingLevel}. Emoji: ${guide.emojiPolicy}.`,
  ];

  if (guide.doSay.length > 0) lines.push(`Say things like: ${guide.doSay.join(' | ')}`);
  if (guide.dontSay.length > 0) lines.push(`Never say: ${guide.dontSay.join(' | ')}`);
  if (guide.vocabulary.length > 0) lines.push(`Preferred words: ${guide.vocabulary.join(', ')}`);
  if (guide.bannedOpeners.length > 0) {
    lines.push(`Never open with: ${guide.bannedOpeners.join(' | ')}`);
  }
  if (guide.sampleCopy.length > 0) {
    lines.push(`Copy that sounds right: ${guide.sampleCopy.join(' | ')}`);
  }

  return lines.join('\n');
}

/**
 * What the post is about, assembled from filled slots.
 *
 * `aiHint` is used as the label where the template author wrote one, because "the number
 * that makes the point: 40%" tells the model far more than "stat: 40%".
 */
export function describeSlots(
  slotSchema: ReturnType<typeof SlotSchemaSchema.parse>,
  slotValues: ReturnType<typeof SlotValuesSchema.parse>,
): string {
  const lines: string[] = [];

  for (const [name, definition] of Object.entries(slotSchema)) {
    if (definition.type !== 'text') continue;

    const value = slotValues[name];
    const text = typeof value === 'string' && value !== '' ? value : definition.default;
    if (!text) continue;

    lines.push(`${definition.aiHint ?? definition.label ?? name}: ${text}`);
  }

  return lines.join('\n');
}

export interface GeneratedCaption {
  caption: string;
  platform: SupportedPlatform;
  model: string;
  /** So the UI can be honest that a machine wrote this and it needs reading. */
  generated: true;
}

/**
 * Draft a caption for a composer draft.
 *
 * Grounded entirely in rows read through the scoped client — the brand's voice guide and
 * the draft's own slot values — so a caller cannot steer the model with a body it
 * supplies, and metering cannot be attributed to a workspace the caller merely names.
 */
export async function generateCaption(
  db: ScopedDb,
  postId: string,
  input: GenerateCaptionInput = {},
): Promise<GeneratedCaption> {
  const post = await db.post.findFirst({
    where: { id: postId, deletedAt: null },
    include: {
      template: { select: { slotSchema: true, archetype: true } },
      brand: {
        select: { id: true, name: true, workspaceId: true, voiceGuide: true, targetPlatforms: true },
      },
    },
  });

  if (!post) throw new NotFoundError('Draft');
  if (!post.template) {
    throw new ValidationError('This draft has no template, so there is nothing to write about');
  }

  const slotSchema = SlotSchemaSchema.parse(post.template.slotSchema);
  const slotValues = SlotValuesSchema.parse(post.slotValues ?? {});
  const topic = describeSlots(slotSchema, slotValues);

  if (!topic) {
    // Refusing costs the user a sentence of explanation. Generating from nothing costs a
    // metered call and returns invented facts about a business we were told nothing about.
    throw new ValidationError(
      'Fill in at least one text slot first — a caption written from an empty template ' +
        'would be about nothing in particular, which is exactly what we are trying to avoid.',
    );
  }

  const platform = resolvePlatform(input.platform, post.brand.targetPlatforms);
  const spec = specFor(platform);

  const notes = [
    `Keep it under ${spec.captionMaxLength} characters.`,
    spec.hashtagLimit ? `At most ${spec.hashtagLimit} hashtags.` : null,
    input.includeLinkMarker
      ? `Include the literal placeholder ${LINK_MARKER} exactly once where a link belongs. ` +
        'Do not invent a URL and do not alter the placeholder.'
      : 'Do not include any URL.',
    spec.linkBehavior === 'bio-only' && input.includeLinkMarker
      ? `On ${spec.label} a caption link is not clickable, so refer to it as "link in bio".`
      : null,
    input.notes,
  ]
    .filter(Boolean)
    .join(' ');

  const result = await generateTextMetered(
    // Metered against the brand's own workspace, read from the row fetched through the
    // scoped client — so attribution cannot be spoofed and cannot drift from tenancy. An
    // exhausted workspace throws `BudgetExceededError` (402) before the provider call.
    {
      db: db as unknown as MeteringClient,
      workspaceId: post.brand.workspaceId,
      brandId: post.brand.id,
      postId: post.id,
    },
    {
      purpose: 'caption_draft',
      input: {
        brandVoice: describeVoice(BrandVoiceGuideSchema.parse(post.brand.voiceGuide)),
        topic,
        platform: spec.label,
        notes,
      },
      // Captions are the one place wandering is the point. Still not 1.0: the voice guide
      // is a constraint, and a caption that ignores it is worse than a dull one.
      temperature: 0.8,
    },
  );

  return {
    caption: enforceLinkMarker(result.data.trim(), input.includeLinkMarker ?? false),
    platform,
    model: result.model,
    generated: true,
  };
}

function resolvePlatform(
  requested: string | undefined,
  brandTargets: readonly string[],
): SupportedPlatform {
  if (requested && isSupportedPlatform(requested)) return requested;

  const fromBrand = brandTargets.find(isSupportedPlatform);
  return fromBrand ?? 'INSTAGRAM';
}

/**
 * Keep the link marker intact and singular.
 *
 * Models paraphrase placeholders — `{link}`, `[link]`, `{{ link }}` — and a marker W7
 * cannot find is a post published with literal braces in it, or worse, a post whose
 * clicks are never attributed. Cheap to normalise here; expensive to discover live.
 */
export function enforceLinkMarker(caption: string, wanted: boolean): string {
  const normalised = caption.replace(/\{\{\s*link\s*\}\}|\{\s*link\s*\}|\[\s*link\s*\]/gi, LINK_MARKER);

  if (!wanted) return normalised;

  const occurrences = normalised.split(LINK_MARKER).length - 1;
  if (occurrences === 1) return normalised;
  if (occurrences === 0) return `${normalised}\n\n${LINK_MARKER}`;

  // Keep the first, drop the rest: two tracked links in one caption would split the
  // click data for a single post across two short links.
  const [first, ...rest] = normalised.split(LINK_MARKER);
  return `${first}${LINK_MARKER}${rest.join('')}`;
}
