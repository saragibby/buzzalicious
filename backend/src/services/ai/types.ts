// AI Service Types
export enum AIProvider {
  OPENAI = 'openai',
  AZURE_OPENAI = 'azure-openai',
  GEMINI = 'gemini',
}

export enum ContentType {
  TEXT = 'text',
  IMAGE = 'image',
  VIDEO = 'video',
}

export interface AIRequest {
  provider: AIProvider;
  contentType: ContentType;
  prompt: string;
  context?: string;
  options?: {
    model?: string;
    temperature?: number;
    maxTokens?: number;
    size?: string; // For images: "1024x1024", etc.
    quality?: string; // For images: "standard" or "hd"
    style?: string; // For images: "vivid" or "natural"
  };
}

export interface AIResponse {
  provider: AIProvider;
  contentType: ContentType;
  content: string | string[]; // Text or URLs
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  model?: string;
}

// Abstract AI Service Interface
export interface IAIService {
  generateText(prompt: string, context?: string, options?: any): Promise<string>;
  generateImage(prompt: string, options?: any): Promise<string[]>;
  generateVideo(prompt: string, options?: any): Promise<string[]>;
}
