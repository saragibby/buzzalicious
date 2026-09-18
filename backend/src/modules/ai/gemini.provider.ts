import { GoogleGenerativeAI } from '@google/generative-ai';
import { ExternalServiceError } from '../../platform/errors';
import { parseModelJson } from './parse';
import type {
  AiProvider,
  AiProviderName,
  AiResult,
  AiStructuredRequest,
  AiTextRequest,
  AiUsage,
  RenderedPrompt,
} from './types';

const DEFAULT_MODEL = 'gemini-2.5-flash';

/**
 * Google Gemini.
 *
 * Unlike the prototype, the system prompt goes in `systemInstruction` rather than being
 * concatenated into the user message — concatenation let user-supplied text sit at the
 * same level as the instructions, which is the shape prompt injection needs.
 */
export class GeminiProvider implements AiProvider {
  readonly name: AiProviderName = 'gemini';
  private readonly client: GoogleGenerativeAI;

  constructor(apiKey: string) {
    this.client = new GoogleGenerativeAI(apiKey);
  }

  async generateText(request: AiTextRequest, prompt: RenderedPrompt): Promise<AiResult<string>> {
    const { text, model, usage } = await this.complete(request, prompt);
    return { provider: this.name, purpose: request.purpose, model, data: text, usage };
  }

  async generateStructured<T>(
    request: AiStructuredRequest<T>,
    prompt: RenderedPrompt,
  ): Promise<AiResult<T>> {
    const { text, model, usage } = await this.complete(request, prompt, true);
    return {
      provider: this.name,
      purpose: request.purpose,
      model,
      data: parseModelJson(text, request.schema, request.schemaName),
      usage,
    };
  }

  private async complete(
    request: AiTextRequest,
    prompt: RenderedPrompt,
    json = false,
  ): Promise<{ text: string; model: string; usage?: AiUsage }> {
    const modelName = request.model ?? DEFAULT_MODEL;

    try {
      const model = this.client.getGenerativeModel({
        model: modelName,
        systemInstruction: prompt.system,
        generationConfig: {
          temperature: request.temperature ?? 0.7,
          maxOutputTokens: request.maxTokens ?? 1_000,
          ...(json ? { responseMimeType: 'application/json' } : {}),
        },
      });

      const result = await model.generateContent(prompt.user);

      // Gemini reports usage under `usageMetadata` with its own names. Captured rather
      // than dropped: without it a Gemini-backed workspace spends against the ceiling
      // without ever moving the meter, so the fuse would never trip (ADR-0011).
      const reported = result.response.usageMetadata;
      const usage: AiUsage | undefined = reported
        ? {
            promptTokens: reported.promptTokenCount,
            completionTokens: reported.candidatesTokenCount,
            totalTokens: reported.totalTokenCount,
          }
        : undefined;

      return { text: result.response.text(), model: modelName, usage };
    } catch (error) {
      throw new ExternalServiceError(this.name, 'AI text generation failed', {
        cause: error,
        retryable: true,
      });
    }
  }
}
