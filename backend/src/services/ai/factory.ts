import { OpenAIService } from './openai.service';
import { GeminiService } from './gemini.service';
import { AIProvider, AIRequest, AIResponse, ContentType, IAIService } from './types';

export class AIServiceFactory {
  private static services: Map<string, IAIService> = new Map();

  private static getService(provider: AIProvider): IAIService {
    // Check if service is already instantiated
    const cacheKey = provider;
    if (this.services.has(cacheKey)) {
      return this.services.get(cacheKey)!;
    }

    // Create new service instance
    let service: IAIService;

    switch (provider) {
      case AIProvider.OPENAI:
        if (!process.env.OPENAI_API_KEY) {
          throw new Error('OPENAI_API_KEY not configured');
        }
        service = new OpenAIService(process.env.OPENAI_API_KEY);
        break;

      case AIProvider.AZURE_OPENAI:
        if (!process.env.AZURE_OPENAI_API_KEY || !process.env.AZURE_OPENAI_ENDPOINT) {
          throw new Error('Azure OpenAI credentials not configured');
        }
        service = new OpenAIService(
          process.env.AZURE_OPENAI_API_KEY,
          true,
          {
            endpoint: process.env.AZURE_OPENAI_ENDPOINT,
            deployment: process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4',
            apiVersion: process.env.AZURE_OPENAI_API_VERSION || '2024-02-15-preview',
          }
        );
        break;

      case AIProvider.GEMINI:
        if (!process.env.GEMINI_API_KEY) {
          throw new Error('GEMINI_API_KEY not configured');
        }
        service = new GeminiService(process.env.GEMINI_API_KEY);
        break;

      default:
        throw new Error(`Unsupported AI provider: ${provider}`);
    }

    this.services.set(cacheKey, service);
    return service;
  }

  static async generate(request: AIRequest): Promise<AIResponse> {
    const service = this.getService(request.provider);

    let content: string | string[];
    let usage: any = undefined;

    try {
      switch (request.contentType) {
        case ContentType.TEXT:
          content = await service.generateText(
            request.prompt,
            request.context,
            request.options
          );
          break;

        case ContentType.IMAGE:
          content = await service.generateImage(
            request.prompt,
            request.options
          );
          break;

        case ContentType.VIDEO:
          content = await service.generateVideo(
            request.prompt,
            request.options
          );
          break;

        default:
          throw new Error(`Unsupported content type: ${request.contentType}`);
      }

      return {
        provider: request.provider,
        contentType: request.contentType,
        content,
        usage,
        model: request.options?.model,
      };
    } catch (error: any) {
      throw new Error(`AI generation failed: ${error.message}`);
    }
  }
}
