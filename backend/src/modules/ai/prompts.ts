import { ValidationError } from '../../platform/errors';
import type { AiPurpose, AiTextRequest, RenderedPrompt } from './types';

/**
 * Server-side prompt templates, one per purpose.
 *
 * These live in source, not in the request body and not in the database, for three
 * reasons: they are reviewable in a pull request, they cannot be injected by a client,
 * and they are versioned with the code that depends on their output shape.
 *
 * W4/W5 will expand these considerably. The structure — a system message stating the
 * role and constraints, a user message carrying only interpolated facts — should hold.
 */

interface PromptTemplate {
  system: string;
  user: (input: Record<string, string>) => string;
  required: readonly string[];
}

const PROMPTS: Record<AiPurpose, PromptTemplate> = {
  caption_draft: {
    system:
      'You write social media captions for a brand. Match the brand voice exactly. ' +
      'Return the caption only, with no preamble, commentary, or surrounding quotes.',
    required: ['brandVoice', 'topic', 'platform'],
    user: (input) =>
      [
        `Platform: ${input.platform}`,
        `Brand voice: ${input.brandVoice}`,
        `Topic: ${input.topic}`,
        input.notes ? `Additional notes: ${input.notes}` : null,
      ]
        .filter(Boolean)
        .join('\n'),
  },
  caption_rewrite: {
    system:
      'You revise an existing social media caption. Preserve its meaning and any factual ' +
      'claims. Apply only the requested change. Return the revised caption only.',
    required: ['caption', 'instruction'],
    user: (input) => `Caption:\n${input.caption}\n\nRequested change: ${input.instruction}`,
  },
  hashtag_suggest: {
    system:
      'You suggest hashtags for a social media post. Prefer specific, currently-used tags ' +
      'over generic ones. Never invent a branded hashtag that was not provided.',
    required: ['caption', 'platform'],
    user: (input) => `Platform: ${input.platform}\n\nCaption:\n${input.caption}`,
  },
  trend_summarize: {
    system:
      'You summarize a collection of trending topics for a marketer. Be concrete and ' +
      'brief. Do not speculate about causes you were not given evidence for.',
    required: ['trends'],
    user: (input) => `Trending items:\n${input.trends}`,
  },
  insight_explain: {
    system:
      'You explain social media performance metrics in plain language. State what changed ' +
      'and the most likely explanation supported by the data. Say when data is insufficient.',
    required: ['metrics'],
    user: (input) => `Metrics:\n${input.metrics}`,
  },
  voice_guide_draft: {
    // The strongest signal in the Tax Dedux prompt work (docs/11) was the banned list,
    // not the positive description — so the system message asks for what the brand would
    // never say with the same weight as what it would.
    system:
      'You draft a brand voice guide for a small business. Produce a starting point a ' +
      'human will edit, not a finished artefact: be concrete and specific to this ' +
      'business, and prefer leaving a list short over padding it with generic marketing ' +
      'advice. Be as precise about what the brand would never say as about what it would. ' +
      'Never invent facts about the business that you were not given.',
    required: ['businessName', 'category'],
    user: (input) =>
      [
        `Business name: ${input.businessName}`,
        `Business category: ${input.category}`,
        input.website ? `Website: ${input.website}` : null,
        input.audience ? `Target audience: ${input.audience}` : null,
        input.notes ? `What the owner says about themselves: ${input.notes}` : null,
      ]
        .filter(Boolean)
        .join('\n'),
  },
};

/**
 * Builds the prompt for a request, failing if the caller omitted a fact the template
 * needs. Silently interpolating `undefined` produces a confident, wrong answer — a
 * failure mode far more expensive than a 400.
 */
export function renderPrompt(request: AiTextRequest): RenderedPrompt {
  const template = PROMPTS[request.purpose];

  if (!template) {
    throw new ValidationError(`Unknown AI purpose: ${String(request.purpose)}`);
  }

  const missing = template.required.filter((key) => !request.input[key]?.trim());
  if (missing.length > 0) {
    throw new ValidationError(
      `Missing input for purpose "${request.purpose}": ${missing.join(', ')}`,
    );
  }

  return { system: template.system, user: template.user(request.input) };
}

export function listPurposes(): AiPurpose[] {
  return Object.keys(PROMPTS) as AiPurpose[];
}
