import { z } from 'zod';
import { generateStructuredMetered } from '../ai/metered';
import { NotFoundError } from '../../platform/errors';
import { BrandVoiceGuideSchema, type BrandVoiceGuide } from './brand.schemas';
import type { ScopedDb } from '../../platform/tenancy';

/**
 * AI-assisted voice guide drafting.
 *
 * The PRD is explicit that a voice guide is a structured document, not a one-line
 * descriptor — and a blank structured form is much harder to fill in than a blank text
 * box. This exists to give the user something to react to.
 *
 * **The draft is never written to the brand.** It is returned to the editor as a
 * suggestion the user accepts field by field. A voice guide the owner did not actually
 * agree with is worse than none, because every generated caption afterwards inherits it
 * and it is not obvious where the wrongness came from.
 */

export const DraftVoiceGuideSchema = z
  .object({
    audience: z.string().max(400).optional(),
    notes: z.string().max(2000).optional(),
  })
  .strict();

export type DraftVoiceGuideInput = z.infer<typeof DraftVoiceGuideSchema>;

export interface VoiceGuideDraft {
  draft: BrandVoiceGuide;
  /** So the UI can be honest that a machine wrote this and it needs reading. */
  generated: true;
  model: string;
}

/**
 * Draft a voice guide for a brand.
 *
 * Facts come from the brand record rather than the request body so the model is grounded
 * in what the user already told us, rather than in whatever a caller chose to send.
 */
export async function draftVoiceGuide(
  db: ScopedDb,
  brandId: string,
  input: DraftVoiceGuideInput = {},
): Promise<VoiceGuideDraft> {
  const brand = await db.brand.findFirst({
    where: { id: brandId, deletedAt: null },
    include: { category: { include: { parent: true } } },
  });

  if (!brand) {
    // Scoped client, so this is genuinely "not yours or not there".
    throw new NotFoundError('Brand not found');
  }

  const category = brand.category
    ? brand.category.parent
      ? `${brand.category.parent.name} — ${brand.category.name}`
      : brand.category.name
    : 'Unspecified';

  const result = await generateStructuredMetered(
    // W10: metered against the brand's own workspace, read from the row we just fetched
    // through the scoped client — so attribution cannot be spoofed by a caller and cannot
    // drift from tenancy. An exhausted workspace throws `BudgetExceededError` (402) here,
    // before the provider call.
    { db, workspaceId: brand.workspaceId, brandId: brand.id },
    {
      purpose: 'voice_guide_draft',
      schema: BrandVoiceGuideSchema as z.ZodType<BrandVoiceGuide>,
      schemaName: 'BrandVoiceGuide',
      input: {
        businessName: brand.name,
        category,
        ...(brand.website ? { website: brand.website } : {}),
        ...(input.audience ? { audience: input.audience } : {}),
        ...(input.notes ? { notes: input.notes } : {}),
      },
      // Low, not zero. A voice guide that reads like every other voice guide is useless,
      // but this is a document the user edits rather than copy that ships, so wandering
      // costs more than it buys.
      temperature: 0.6,
    },
  );

  return { draft: result.data, generated: true, model: result.model };
}
