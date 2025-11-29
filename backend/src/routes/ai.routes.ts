import { Router, Request, Response } from 'express';
import { AIServiceFactory } from '../services/ai/factory';
import { AIProvider, ContentType } from '../services/ai/types';
import { isAuthenticated } from '../middleware/auth';
import { PrismaClient } from '@prisma/client';

const router = Router();
const prisma = new PrismaClient();

// Pricing per 1M tokens (as of Nov 2024)
const PRICING = {
  'openai': {
    'gpt-4o-mini': { input: 0.150, output: 0.600 }, // per 1M tokens
    'gpt-4o': { input: 2.50, output: 10.00 },
    'gpt-4-turbo': { input: 10.00, output: 30.00 },
    'dall-e-3': { standard: 0.040, hd: 0.080 }, // per image
  },
  'azure-openai': {
    'gpt-4': { input: 10.00, output: 30.00 },
    'gpt-35-turbo': { input: 0.50, output: 1.50 },
  },
  'gemini': {
    'gemini-1.5-flash': { input: 0.075, output: 0.30 },
    'gemini-1.5-pro': { input: 1.25, output: 5.00 },
  }
};

function calculateCost(provider: string, model: string, promptTokens: number, completionTokens: number): number {
  const providerPricing = PRICING[provider as keyof typeof PRICING];
  if (!providerPricing) return 0;

  const modelPricing = providerPricing[model as keyof typeof providerPricing] as any;
  if (!modelPricing || !modelPricing.input) return 0;

  const inputCost = (promptTokens / 1000000) * modelPricing.input;
  const outputCost = (completionTokens / 1000000) * modelPricing.output;
  return inputCost + outputCost;
}

// Generate AI content endpoint
router.post('/generate', isAuthenticated, async (req: Request, res: Response): Promise<void> => {
  try {
    const { provider, contentType, prompt, context, options } = req.body;
    const userId = (req.user as any)?.id;

    // Validation
    if (!provider || !contentType || !prompt) {
      res.status(400).json({
        error: 'Missing required fields: provider, contentType, prompt',
      });
      return;
    }

    if (!Object.values(AIProvider).includes(provider)) {
      res.status(400).json({
        error: `Invalid provider. Must be one of: ${Object.values(AIProvider).join(', ')}`,
      });
      return;
    }

    if (!Object.values(ContentType).includes(contentType)) {
      res.status(400).json({
        error: `Invalid contentType. Must be one of: ${Object.values(ContentType).join(', ')}`,
      });
      return;
    }

    // Track response time
    const startTime = Date.now();

    // Generate content
    const result = await AIServiceFactory.generate({
      provider,
      contentType,
      prompt,
      context,
      options,
    });

    const responseTimeMs = Date.now() - startTime;

    // Calculate cost
    const modelUsed = result.model || options?.model || 'unknown';
    const promptTokens = result.usage?.promptTokens || 0;
    const completionTokens = result.usage?.completionTokens || 0;
    const totalTokens = result.usage?.totalTokens || promptTokens + completionTokens;
    const estimatedCost = calculateCost(provider, modelUsed, promptTokens, completionTokens);

    // Save generation request to database
    let requestId = null;
    if (userId) {
      const savedRequest = await prisma.generationRequest.create({
        data: {
          userId,
          provider,
          contentType,
          prompt,
          response: typeof result.content === 'string' ? result.content : JSON.stringify(result.content),
          modelUsed,
          responseTimeMs,
          promptTokens,
          completionTokens,
          totalTokens,
          estimatedCost,
        },
      });
      requestId = savedRequest.id;
    }

    res.json({ ...result, requestId, metrics: { responseTimeMs, estimatedCost, totalTokens } });
  } catch (error: any) {
    console.error('AI generation error:', error);
    res.status(500).json({
      error: error.message || 'AI generation failed',
    });
  }
});

// Get recent generation requests
router.get('/recent', isAuthenticated, async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = (req.user as any)?.id;

    if (!userId) {
      res.status(401).json({ error: 'User not authenticated' });
      return;
    }

    const recentRequests = await prisma.generationRequest.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: {
        id: true,
        provider: true,
        prompt: true,
        response: true,
        contentType: true,
        createdAt: true,
        postedToTwitter: true,
        twitterPostId: true,
        modelUsed: true,
        responseTimeMs: true,
        totalTokens: true,
        estimatedCost: true,
      },
    });

    res.json({ requests: recentRequests });
  } catch (error: any) {
    console.error('Error fetching recent requests:', error);
    res.status(500).json({
      error: error.message || 'Failed to fetch recent requests',
    });
  }
});

// Get analytics/stats comparing AI providers
router.get('/analytics', isAuthenticated, async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = (req.user as any)?.id;

    if (!userId) {
      res.status(401).json({ error: 'User not authenticated' });
      return;
    }

    // Get all generation requests for this user
    const requests = await prisma.generationRequest.findMany({
      where: { userId },
      select: {
        provider: true,
        modelUsed: true,
        responseTimeMs: true,
        totalTokens: true,
        estimatedCost: true,
        createdAt: true,
        postedToTwitter: true,
      },
    });

    // Group by provider
    const stats: Record<string, any> = {};
    
    requests.forEach((req: any) => {
      if (!stats[req.provider]) {
        stats[req.provider] = {
          provider: req.provider,
          totalRequests: 0,
          totalCost: 0,
          totalTokens: 0,
          totalResponseTime: 0,
          avgResponseTime: 0,
          avgCost: 0,
          avgTokens: 0,
          postsCreated: 0,
          modelsUsed: {} as Record<string, number>,
        };
      }

      const providerStats = stats[req.provider];
      providerStats.totalRequests++;
      providerStats.totalCost += req.estimatedCost || 0;
      providerStats.totalTokens += req.totalTokens || 0;
      providerStats.totalResponseTime += req.responseTimeMs || 0;
      
      if (req.postedToTwitter) {
        providerStats.postsCreated++;
      }

      if (req.modelUsed) {
        providerStats.modelsUsed[req.modelUsed] = (providerStats.modelsUsed[req.modelUsed] || 0) + 1;
      }
    });

    // Calculate averages
    Object.values(stats).forEach((providerStats: any) => {
      if (providerStats.totalRequests > 0) {
        providerStats.avgResponseTime = Math.round(providerStats.totalResponseTime / providerStats.totalRequests);
        providerStats.avgCost = providerStats.totalCost / providerStats.totalRequests;
        providerStats.avgTokens = Math.round(providerStats.totalTokens / providerStats.totalRequests);
      }
      // Round total cost to 4 decimal places
      providerStats.totalCost = Math.round(providerStats.totalCost * 10000) / 10000;
      providerStats.avgCost = Math.round(providerStats.avgCost * 10000) / 10000;
    });

    res.json({ 
      stats: Object.values(stats),
      totalRequests: requests.length,
      totalCost: requests.reduce((sum: number, r: any) => sum + (r.estimatedCost || 0), 0),
    });
  } catch (error: any) {
    console.error('Error fetching analytics:', error);
    res.status(500).json({
      error: error.message || 'Failed to fetch analytics',
    });
  }
});

// Get available providers
router.get('/providers', isAuthenticated, (_req: Request, res: Response) => {
  const providers = [];

  if (process.env.OPENAI_API_KEY) {
    providers.push({
      id: AIProvider.OPENAI,
      name: 'OpenAI',
      supports: [ContentType.TEXT, ContentType.IMAGE],
    });
  }

  if (process.env.AZURE_OPENAI_API_KEY) {
    providers.push({
      id: AIProvider.AZURE_OPENAI,
      name: 'Azure OpenAI',
      supports: [ContentType.TEXT, ContentType.IMAGE],
    });
  }

  if (process.env.GEMINI_API_KEY) {
    providers.push({
      id: AIProvider.GEMINI,
      name: 'Google Gemini',
      supports: [ContentType.TEXT],
    });
  }

  res.json({ providers });
});

export default router;
