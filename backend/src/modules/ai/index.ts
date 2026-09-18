import { getConfig } from '../../platform/config';
import { ValidationError } from '../../platform/errors';
import { GeminiProvider } from './gemini.provider';
import { OpenAiProvider } from './openai.provider';
import { renderPrompt } from './prompts';
import type {
  AiProvider,
  AiProviderName,
  AiResult,
  AiStructuredRequest,
  AiTextRequest,
} from './types';

/**
 * Provider selection and the module's public surface.
 *
 * Providers are cached because constructing a client opens a connection pool. Keys come
 * from config, never from `process.env` directly, so a missing key is a boot-time or
 * first-use failure with a readable message rather than an SDK exception.
 *
 * Note this is *platform* AI credentials — our own OpenAI key for our own features. It
 * is not the BYO client-credential path (ADR-0009), which is `modules/publish/`'s
 * concern and resolves per workspace.
 */

const cache = new Map<AiProviderName, AiProvider>();

export function getAiProvider(name?: AiProviderName): AiProvider {
  const resolved = name ?? defaultProviderName();

  const existing = cache.get(resolved);
  if (existing) return existing;

  const provider = createProvider(resolved);
  cache.set(resolved, provider);
  return provider;
}

/** First configured provider wins. Explicit ordering beats implicit map iteration. */
function defaultProviderName(): AiProviderName {
  const { ai } = getConfig();
  if (ai.openaiApiKey) return 'openai';
  if (ai.azure.apiKey && ai.azure.endpoint) return 'azure-openai';
  if (ai.geminiApiKey) return 'gemini';

  throw new ValidationError(
    'No AI provider is configured. Set OPENAI_API_KEY, GEMINI_API_KEY, or the AZURE_OPENAI_* variables.',
  );
}

function createProvider(name: AiProviderName): AiProvider {
  const { ai } = getConfig();

  switch (name) {
    case 'openai':
      if (!ai.openaiApiKey) throw new ValidationError('OPENAI_API_KEY is not configured');
      return new OpenAiProvider(ai.openaiApiKey);

    case 'azure-openai':
      if (!ai.azure.apiKey || !ai.azure.endpoint) {
        throw new ValidationError('AZURE_OPENAI_API_KEY and AZURE_OPENAI_ENDPOINT are required');
      }
      return new OpenAiProvider(ai.azure.apiKey, {
        endpoint: ai.azure.endpoint,
        deployment: ai.azure.deployment ?? 'gpt-4o-mini',
        apiVersion: ai.azure.apiVersion ?? '2024-02-15-preview',
      });

    case 'gemini':
      if (!ai.geminiApiKey) throw new ValidationError('GEMINI_API_KEY is not configured');
      return new GeminiProvider(ai.geminiApiKey);

    default: {
      const exhaustive: never = name;
      throw new ValidationError(`Unsupported AI provider: ${String(exhaustive)}`);
    }
  }
}

/** Generate prose for a named purpose. */
export async function generateText(
  request: AiTextRequest,
  provider?: AiProviderName,
): Promise<AiResult<string>> {
  return getAiProvider(provider).generateText(request, renderPrompt(request));
}

/** Generate data validated against a Zod schema. */
export async function generateStructured<T>(
  request: AiStructuredRequest<T>,
  provider?: AiProviderName,
): Promise<AiResult<T>> {
  return getAiProvider(provider).generateStructured(request, renderPrompt(request));
}

/** Test-only. Drops cached provider clients. */
export function resetAiProvidersForTests(): void {
  cache.clear();
}

export { renderPrompt, listPurposes } from './prompts';
export { parseModelJson } from './parse';
export type * from './types';
