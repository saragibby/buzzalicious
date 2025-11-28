import { GoogleGenerativeAI } from '@google/generative-ai';
import { IAIService } from './types';

export class GeminiService implements IAIService {
  private client: GoogleGenerativeAI;

  constructor(apiKey: string) {
    this.client = new GoogleGenerativeAI(apiKey);
  }

  async generateText(prompt: string, context?: string, options?: {
    model?: string;
    temperature?: number;
    maxTokens?: number;
  }): Promise<string> {
    const model = this.client.getGenerativeModel({ 
      model: options?.model || 'gemini-pro' 
    });

    const fullPrompt = context 
      ? `Context: ${context}\n\nPrompt: ${prompt}` 
      : prompt;

    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: fullPrompt }] }],
      generationConfig: {
        temperature: options?.temperature || 0.7,
        maxOutputTokens: options?.maxTokens || 1000,
      },
    });

    const response = result.response;
    return response.text();
  }

  async generateImage(_prompt: string, _options?: any): Promise<string[]> {
    // Gemini Pro Vision can analyze images but not generate them
    // Use Imagen API separately if needed
    throw new Error('Image generation not directly supported by Gemini Pro. Use Google Imagen API.');
  }

  async generateVideo(_prompt: string, _options?: any): Promise<string[]> {
    // Gemini doesn't support video generation
    throw new Error('Video generation not supported by Gemini');
  }
}
