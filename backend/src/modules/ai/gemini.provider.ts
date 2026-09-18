import { GoogleGenerativeAI } from '@google/generative-ai';
import { ExternalServiceError } from '../../platform/errors';
import { parseModelJson } from './parse';
import type {
  AiProvider,
  AiProviderName,
  AiResult,
  AiStructuredRequest,
  AiTextRequest,
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
    const { text, model } = await this.complete(request, prompt);
    return { provider: this.name, purpose: request.purpose, model, data: text };
  }

  async generateStructured<T>(
    request: AiStructuredRequest<T>,
    prompt: RenderedPrompt,
  ): Promise<AiResult<T>> {
    const { text, model } = await this.complete(request, prompt, true);
    return {
      provider: this.name,
      purpose: request.purpose,
      model,
      data: parseModelJson(text, request.schema, request.schemaName),
    };
  }

  private async complete(
    request: AiTextRequest,
    prompt: RenderedPrompt,
    json = false,
  ): Promise<{ text: string; model: string }> {
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
      return { text: result.response.text(), model: modelName };
    } catch (error) {
      throw new ExternalServiceError(this.name, 'AI text generation failed', {
        cause: error,
        retryable: true,
      });
    }
  }
}
