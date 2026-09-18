import OpenAI from 'openai';
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

export interface AzureOptions {
  endpoint: string;
  deployment: string;
  apiVersion: string;
}

const DEFAULT_MODEL = 'gpt-4o-mini';

/**
 * OpenAI and Azure OpenAI. One class, because the wire protocol is identical and only
 * the routing differs: Azure encodes the model in the deployment URL, so `model` must be
 * omitted from the request body there.
 */
export class OpenAiProvider implements AiProvider {
  readonly name: AiProviderName;
  private readonly client: OpenAI;
  private readonly isAzure: boolean;

  constructor(apiKey: string, azure?: AzureOptions) {
    this.isAzure = Boolean(azure);
    this.name = azure ? 'azure-openai' : 'openai';

    this.client = azure
      ? new OpenAI({
          apiKey,
          baseURL: `${azure.endpoint.replace(/\/$/, '')}/openai/deployments/${azure.deployment}`,
          defaultQuery: { 'api-version': azure.apiVersion },
          defaultHeaders: { 'api-key': apiKey },
        })
      : new OpenAI({ apiKey });
  }

  async generateText(request: AiTextRequest, prompt: RenderedPrompt): Promise<AiResult<string>> {
    const response = await this.complete(request, prompt);
    return {
      provider: this.name,
      purpose: request.purpose,
      model: response.model,
      data: response.text,
      usage: response.usage,
    };
  }

  async generateStructured<T>(
    request: AiStructuredRequest<T>,
    prompt: RenderedPrompt,
  ): Promise<AiResult<T>> {
    const response = await this.complete(request, prompt, true);
    return {
      provider: this.name,
      purpose: request.purpose,
      model: response.model,
      data: parseModelJson(response.text, request.schema, request.schemaName),
      usage: response.usage,
    };
  }

  private async complete(
    request: AiTextRequest,
    prompt: RenderedPrompt,
    json = false,
  ): Promise<{ text: string; model: string; usage: AiResult<unknown>['usage'] }> {
    const model = request.model ?? DEFAULT_MODEL;

    try {
      const response = await this.client.chat.completions.create({
        // Azure resolves the model from the deployment path; sending it here is an error.
        ...(this.isAzure ? {} : { model }),
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
        temperature: request.temperature ?? 0.7,
        max_tokens: request.maxTokens ?? 1_000,
        ...(json ? { response_format: { type: 'json_object' as const } } : {}),
      } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming);

      return {
        text: response.choices[0]?.message?.content ?? '',
        model: response.model ?? model,
        usage: {
          promptTokens: response.usage?.prompt_tokens,
          completionTokens: response.usage?.completion_tokens,
          totalTokens: response.usage?.total_tokens,
        },
      };
    } catch (error) {
      // Not exposed: provider errors echo the request, and the request contains brand
      // content. The cause is logged server-side by the error handler.
      throw new ExternalServiceError(this.name, 'AI text generation failed', {
        cause: error,
        retryable: true,
      });
    }
  }
}
