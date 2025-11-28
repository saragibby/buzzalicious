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
        // Use gemini-1.5-flash or gemini-1.5-pro for the latest SDK
        const modelName = options?.model || "gemini-2.5-flash";
        const model = this.client.getGenerativeModel({ model: modelName });

        const fullPrompt = context
            ? `Context: ${context}\n\nPrompt: ${prompt}`
            : prompt;

        const result = await model.generateContent(fullPrompt);
        const response = await result.response;
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
