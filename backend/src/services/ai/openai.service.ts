import OpenAI from 'openai';
import { IAIService } from './types';

export class OpenAIService implements IAIService {
  private client: OpenAI;

  constructor(apiKey: string, isAzure: boolean = false, azureConfig?: {
    endpoint: string;
    deployment: string;
    apiVersion: string;
  }) {
    if (isAzure && azureConfig) {
      this.client = new OpenAI({
        apiKey,
        baseURL: `${azureConfig.endpoint}/openai/deployments/${azureConfig.deployment}`,
        defaultQuery: { 'api-version': azureConfig.apiVersion },
        defaultHeaders: { 'api-key': apiKey },
      });
    } else {
      this.client = new OpenAI({ apiKey });
    }
  }

  async generateText(prompt: string, context?: string, options?: {
    model?: string;
    temperature?: number;
    maxTokens?: number;
  }): Promise<string> {
    const messages: any[] = [];
    
    if (context) {
      messages.push({
        role: 'system',
        content: context,
      });
    }
    
    messages.push({
      role: 'user',
      content: prompt,
    });

    const response = await this.client.chat.completions.create({
      model: options?.model || 'gpt-4-turbo-preview',
      messages,
      temperature: options?.temperature || 0.7,
      max_tokens: options?.maxTokens || 1000,
    });

    return response.choices[0]?.message?.content || '';
  }

  async generateImage(prompt: string, options?: {
    model?: string;
    size?: string;
    quality?: string;
    style?: string;
    n?: number;
  }): Promise<string[]> {
    const response = await this.client.images.generate({
      model: options?.model || 'dall-e-3',
      prompt,
      n: options?.n || 1,
      size: (options?.size as any) || '1024x1024',
      quality: (options?.quality as any) || 'standard',
      style: (options?.style as any) || 'vivid',
    });

    return response.data?.map(img => img.url || '').filter(Boolean) || [];
  }

  async generateVideo(_prompt: string, _options?: any): Promise<string[]> {
    // OpenAI doesn't currently support video generation via API
    throw new Error('Video generation not supported by OpenAI');
  }
}
