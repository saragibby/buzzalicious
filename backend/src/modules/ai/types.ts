import type { ZodType } from 'zod';

/**
 * Provider-agnostic AI contract.
 *
 * Three deliberate changes from the prototype's `services/ai/types.ts`:
 *
 * 1. **`purpose` replaces the free-form prompt.** The old API took whatever string a
 *    client sent and forwarded it to OpenAI. That is an unbounded spend surface and an
 *    unbounded content surface. Callers now name what they want; the prompt for each
 *    purpose lives server-side in `prompts.ts` and is reviewable.
 * 2. **Structured output is first class.** `generateStructured` takes a Zod schema and
 *    returns parsed, validated data, so callers never hand-parse a model response.
 * 3. **No image or video generation.** Satori renders images deterministically from a
 *    template (ADR-0002). Generative images were slow, expensive and off-brand.
 */

export type AiProviderName = 'openai' | 'azure-openai' | 'gemini';

/** The things this product asks a model to do. Adding a case means adding a prompt. */
export type AiPurpose =
  | 'caption_draft'
  | 'caption_rewrite'
  | 'hashtag_suggest'
  | 'trend_summarize'
  | 'insight_explain'
  | 'voice_guide_draft';

export interface AiUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface AiTextRequest {
  purpose: AiPurpose;
  /** Facts the prompt interpolates — brand voice, topic, prior copy. Never a secret. */
  input: Record<string, string>;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface AiStructuredRequest<T> extends AiTextRequest {
  schema: ZodType<T>;
  /** Names the shape for providers that support schema-guided decoding. */
  schemaName: string;
}

export interface AiResult<T> {
  provider: AiProviderName;
  purpose: AiPurpose;
  model: string;
  data: T;
  usage?: AiUsage;
}

/**
 * What every provider implementation must offer. Intentionally small: a provider that
 * cannot do one of these is not usable here, and anything larger leaks provider-specific
 * capability into callers.
 */
export interface AiProvider {
  readonly name: AiProviderName;
  generateText(request: AiTextRequest, prompt: RenderedPrompt): Promise<AiResult<string>>;
  generateStructured<T>(
    request: AiStructuredRequest<T>,
    prompt: RenderedPrompt,
  ): Promise<AiResult<T>>;
}

export interface RenderedPrompt {
  system: string;
  user: string;
}
