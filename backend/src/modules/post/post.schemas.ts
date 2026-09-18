import { z } from 'zod';
import { SlotValuesSchema } from '../template/template.schemas';
import { SUPPORTED_PLATFORMS, type SupportedPlatform } from '../template/platform-spec';

/**
 * Request contracts for composer drafts.
 *
 * A draft is an unfinished thing by definition, so almost everything here is optional and
 * nothing is required to be *valid* — slot values are checked against the template's
 * `slotSchema` at render time, not at save time. Refusing to save a half-typed headline
 * would mean the user loses work every time they stop mid-sentence.
 */

/**
 * The marker W7 replaces with a tracked short link at publish time.
 *
 * Defined here because both the composer and the caption generator have to agree on the
 * exact spelling — a prompt that emits `{link}` and a UI that looks for `{{link}}` fails
 * silently, and the failure is invisible until nobody's clicks are attributed.
 */
export const LINK_MARKER = '{{link}}';

export const PlatformSchema = z.enum(SUPPORTED_PLATFORMS as [SupportedPlatform, ...string[]]);

/**
 * Per-platform caption overrides, stored on `PostTarget.caption`.
 *
 * `null` means "use the base caption" and is different from `''`, which means the user
 * deliberately emptied this platform's caption. Collapsing the two would silently
 * resurrect the base copy on a caption someone cleared on purpose.
 */
export const CaptionOverridesSchema = z.record(PlatformSchema, z.string().max(64_000).nullable());

export const CreateDraftSchema = z
  .object({
    templateSlug: z.string().min(1),
    title: z.string().max(200).optional(),
    slotValues: SlotValuesSchema.optional(),
  })
  .strict();

export const UpdateDraftSchema = z
  .object({
    title: z.string().max(200).nullable().optional(),
    slotValues: SlotValuesSchema.optional(),
    baseCopy: z.string().max(64_000).nullable().optional(),
    captionOverrides: CaptionOverridesSchema.optional(),
    platforms: z.array(PlatformSchema).max(SUPPORTED_PLATFORMS.length).optional(),
  })
  .strict();

export const GenerateCaptionSchema = z
  .object({
    /** Free-text steer from the user, e.g. "lean harder on the discount". */
    notes: z.string().max(1000).optional(),
    /** Which platform's conventions to write for. Defaults to the brand's first target. */
    platform: PlatformSchema.optional(),
    includeLinkMarker: z.boolean().optional(),
  })
  .strict();

export type CreateDraftInput = z.infer<typeof CreateDraftSchema>;
export type UpdateDraftInput = z.infer<typeof UpdateDraftSchema>;
export type GenerateCaptionInput = z.infer<typeof GenerateCaptionSchema>;
export type CaptionOverrides = z.infer<typeof CaptionOverridesSchema>;
