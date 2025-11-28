import { Router, Request, Response } from 'express';
import { AIServiceFactory } from '../services/ai/factory';
import { AIProvider, ContentType } from '../services/ai/types';
import { isAuthenticated } from '../middleware/auth';

const router = Router();

// Generate AI content endpoint
router.post('/generate', isAuthenticated, async (req: Request, res: Response): Promise<void> => {
  try {
    const { provider, contentType, prompt, context, options } = req.body;

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

    res.json(result);
  } catch (error: any) {
    console.error('AI generation error:', error);
    res.status(500).json({
      error: error.message || 'AI generation failed',
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
