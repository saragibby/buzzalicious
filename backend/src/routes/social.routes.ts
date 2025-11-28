import { Router, Request, Response } from 'express';
import prisma from '../db';
import { TwitterService } from '../services/twitter.service';

const router = Router();

// Store temporary OAuth tokens in memory (in production, use Redis or database)
const oauthTokenStore = new Map<string, { secret: string; userId: string }>();

// Initiate Twitter OAuth flow
router.get('/twitter/connect', async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    // Check for Twitter API credentials
    if (!process.env.TWITTER_API_KEY || !process.env.TWITTER_API_SECRET) {
      console.error('Twitter API credentials not configured');
      res.status(500).json({ 
        error: 'Twitter API credentials not configured. Please add TWITTER_API_KEY and TWITTER_API_SECRET to your .env file.' 
      });
      return;
    }

    const callbackUrl = `${process.env.BACKEND_URL || 'http://localhost:3001'}/api/social/twitter/callback`;
    console.log('Initiating Twitter OAuth with callback:', callbackUrl);
    
    const authLink = await TwitterService.generateAuthUrl(callbackUrl);

    // Store the oauth token secret temporarily
    oauthTokenStore.set(authLink.oauth_token, {
      secret: authLink.oauth_token_secret,
      userId: (req.user as any).id,
    });

    res.json({ authUrl: authLink.url });
  } catch (error: any) {
    console.error('Twitter OAuth error:', error);
    res.status(500).json({ 
      error: 'Failed to initiate Twitter authentication',
      details: error.message || 'Unknown error'
    });
  }
});

// Twitter OAuth callback
router.get('/twitter/callback', async (req: Request, res: Response): Promise<void> => {
  try {
    const { oauth_token, oauth_verifier } = req.query;

    if (!oauth_token || !oauth_verifier) {
      res.status(400).send('Missing OAuth parameters');
      return;
    }

    // Retrieve stored token secret
    const stored = oauthTokenStore.get(oauth_token as string);
    if (!stored) {
      res.status(400).send('Invalid OAuth token');
      return;
    }

    // Exchange for access token
    const { accessToken, accessSecret, userId, screenName } = await TwitterService.getAccessToken(
      oauth_token as string,
      oauth_verifier as string,
      stored.secret
    );

    // Clean up temporary storage
    oauthTokenStore.delete(oauth_token as string);

    // Save to database
    await prisma.socialAccount.upsert({
      where: {
        userId_platform_accountName: {
          userId: stored.userId,
          platform: 'twitter',
          accountName: screenName,
        },
      },
      update: {
        accessToken,
        refreshToken: accessSecret,
        accountId: userId,
        isActive: true,
      },
      create: {
        userId: stored.userId,
        platform: 'twitter',
        accountName: screenName,
        accountId: userId,
        accessToken,
        refreshToken: accessSecret,
        isActive: true,
      },
    });

    // Redirect back to frontend
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    res.redirect(`${frontendUrl}?twitter_connected=true`);
  } catch (error) {
    console.error('Twitter callback error:', error);
    res.status(500).send('Failed to complete Twitter authentication');
  }
});

// Post a tweet
router.post('/twitter/post', async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const { accountId, text, mediaUrls } = req.body;

    if (!accountId || !text) {
      res.status(400).json({ error: 'Account ID and text are required' });
      return;
    }

    // Get the Twitter account
    const account = await prisma.socialAccount.findFirst({
      where: {
        id: accountId,
        userId: (req.user as any).id,
        platform: 'twitter',
        isActive: true,
      },
    });

    if (!account || !account.accessToken || !account.refreshToken) {
      res.status(404).json({ error: 'Twitter account not found or not connected' });
      return;
    }

    // Create Twitter service instance
    const twitterService = new TwitterService(account.accessToken, account.refreshToken);

    // Post tweet
    let result;
    if (mediaUrls && mediaUrls.length > 0) {
      result = await twitterService.postTweetWithMedia(text, mediaUrls);
    } else {
      result = await twitterService.postTweet(text);
    }

    res.json({
      success: true,
      tweet: result,
      message: 'Tweet posted successfully!',
    });
  } catch (error: any) {
    console.error('Twitter post error:', error);
    res.status(500).json({ error: error.message || 'Failed to post tweet' });
  }
});

// Get Twitter account info
router.get('/twitter/profile/:accountId', async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const { accountId } = req.params;

    const account = await prisma.socialAccount.findFirst({
      where: {
        id: accountId,
        userId: (req.user as any).id,
        platform: 'twitter',
      },
    });

    if (!account || !account.accessToken || !account.refreshToken) {
      res.status(404).json({ error: 'Twitter account not found' });
      return;
    }

    const twitterService = new TwitterService(account.accessToken, account.refreshToken);
    const profile = await twitterService.getProfile();

    res.json({ profile });
  } catch (error: any) {
    console.error('Twitter profile error:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch Twitter profile' });
  }
});

export default router;
