import { Router, Request, Response } from 'express';
import { AIServiceFactory } from '../services/ai/factory';
import { AIProvider, ContentType } from '../services/ai/types';
import { isAuthenticated } from '../middleware/auth';
import { PrismaClient } from '@prisma/client';

const router = Router();
const prisma = new PrismaClient();

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

    // Generate content
    const result = await AIServiceFactory.generate({
      provider,
      contentType,
      prompt,
      context,
      options,
    });

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
        },
      });
      requestId = savedRequest.id;
    }

    res.json({ ...result, requestId });
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
