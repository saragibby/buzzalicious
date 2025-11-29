import { Router, Request, Response } from 'express';
import prisma from '../db';
import { TwitterService } from '../services/twitter.service';
import { LinkedInService } from '../services/linkedin.service';

const router = Router();

// Store temporary OAuth tokens in memory (in production, use Redis or database)
const oauthTokenStore = new Map<string, { secret: string; userId: string }>();
const linkedinStateStore = new Map<string, string>(); // state -> userId

// Get Twitter authorization status
router.get('/twitter/status', async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const userId = (req.user as any).id;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        twitterAccessToken: true,
        twitterAccessSecret: true,
        twitterUsername: true,
        twitterUserId: true,
      },
    });

    const isConnected = !!(user?.twitterAccessToken && user?.twitterAccessSecret);

    res.json({
      isConnected,
      username: user?.twitterUsername || null,
      userId: user?.twitterUserId || null,
    });
  } catch (error: any) {
    console.error('Twitter status error:', error);
    res.status(500).json({ error: 'Failed to fetch Twitter status' });
  }
});

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

    // Save tokens directly to user record
    await prisma.user.update({
      where: { id: stored.userId },
      data: {
        twitterAccessToken: accessToken,
        twitterAccessSecret: accessSecret,
        twitterUserId: userId,
        twitterUsername: screenName,
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

    const { text, mediaUrls, generationRequestId } = req.body;

    if (!text) {
      res.status(400).json({ error: 'Text is required' });
      return;
    }

    const userId = (req.user as any).id;

    // Get the user's Twitter credentials
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        twitterAccessToken: true,
        twitterAccessSecret: true,
        twitterUsername: true,
      },
    });

    if (!user || !user.twitterAccessToken || !user.twitterAccessSecret) {
      res.status(404).json({ 
        error: 'Twitter account not connected. Please connect your Twitter account in your Profile.' 
      });
      return;
    }

    // Create Twitter service instance
    const twitterService = new TwitterService(user.twitterAccessToken, user.twitterAccessSecret);

    // Post tweet
    let result;
    if (mediaUrls && mediaUrls.length > 0) {
      result = await twitterService.postTweetWithMedia(text, mediaUrls);
    } else {
      result = await twitterService.postTweet(text);
    }

    // Mark generation request as posted if provided
    if (generationRequestId) {
      await prisma.generationRequest.update({
        where: { id: generationRequestId },
        data: {
          postedToTwitter: true,
          twitterPostId: result.id,
          twitterPostedAt: new Date(),
        },
      });
    }

    res.json({
      success: true,
      tweet: result,
      message: `Tweet posted successfully to @${user.twitterUsername}!`,
    });
  } catch (error: any) {
    console.error('Twitter post error:', error);
    res.status(500).json({ error: error.message || 'Failed to post tweet' });
  }
});

// Get Twitter account info
router.get('/twitter/status', async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const userId = (req.user as any).id;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        twitterUsername: true,
        twitterUserId: true,
        twitterAccessToken: true,
      },
    });

    const isConnected = !!(user?.twitterAccessToken && user?.twitterUsername);

    res.json({ 
      isConnected,
      username: user?.twitterUsername || null,
      userId: user?.twitterUserId || null,
    });
  } catch (error: any) {
    console.error('Twitter status error:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch Twitter status' });
  }
});

// ============= LinkedIn Routes =============

// Get LinkedIn authorization status
router.get('/linkedin/status', async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const userId = (req.user as any).id;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        linkedinAccessToken: true,
        linkedinUsername: true,
        linkedinUserId: true,
      },
    });

    const isConnected = !!(user?.linkedinAccessToken);

    res.json({
      isConnected,
      username: user?.linkedinUsername || null,
      userId: user?.linkedinUserId || null,
    });
  } catch (error: any) {
    console.error('LinkedIn status error:', error);
    res.status(500).json({ error: 'Failed to fetch LinkedIn status' });
  }
});

// Initiate LinkedIn OAuth flow
router.get('/linkedin/connect', async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    // Log environment variables for debugging
    console.log('LinkedIn OAuth Debug:');
    console.log('- CLIENT_ID:', process.env.LINKEDIN_CLIENT_ID ? 'SET' : 'NOT SET');
    console.log('- CLIENT_SECRET:', process.env.LINKEDIN_CLIENT_SECRET ? 'SET' : 'NOT SET');
    console.log('- REDIRECT_URI:', process.env.LINKEDIN_REDIRECT_URI || 'NOT SET');

    if (!process.env.LINKEDIN_CLIENT_ID || !process.env.LINKEDIN_CLIENT_SECRET) {
      console.error('LinkedIn API credentials not configured');
      res.status(500).json({ 
        error: 'LinkedIn API credentials not configured. Please add LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET to your .env file.' 
      });
      return;
    }

    const callbackUrl = process.env.LINKEDIN_REDIRECT_URI || `${process.env.BACKEND_URL || 'http://localhost:3001'}/api/social/linkedin/callback`;
    
    // Generate a random state for CSRF protection
    const state = Math.random().toString(36).substring(7);
    
    const authUrl = LinkedInService.generateAuthUrl(callbackUrl, state);
    
    console.log('Generated LinkedIn OAuth URL:', authUrl);

    // Store state with user ID
    linkedinStateStore.set(state, (req.user as any).id);

    res.json({ authUrl });
  } catch (error: any) {
    console.error('LinkedIn OAuth error:', error);
    res.status(500).json({ 
      error: 'Failed to initiate LinkedIn authentication',
      details: error.message || 'Unknown error'
    });
  }
});

// LinkedIn OAuth callback
router.get('/linkedin/callback', async (req: Request, res: Response): Promise<void> => {
  try {
    console.log('LinkedIn callback received with query params:', req.query);
    
    const { code, state, error, error_description } = req.query;

    // Check if LinkedIn returned an error
    if (error) {
      console.error('LinkedIn OAuth error:', error, error_description);
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
      const errorMsg = typeof error_description === 'string' ? error_description : (typeof error === 'string' ? error : 'Unknown error');
      res.redirect(`${frontendUrl}?linkedin_error=${encodeURIComponent(errorMsg)}`);
      return;
    }

    if (!code || !state) {
      console.error('Missing OAuth parameters. Received:', { code: !!code, state: !!state });
      res.status(400).send('Missing OAuth parameters from LinkedIn');
      return;
    }

    // Retrieve user ID from state
    const userId = linkedinStateStore.get(state as string);
    if (!userId) {
      console.error('Invalid OAuth state. State not found in store.');
      res.status(400).send('Invalid OAuth state');
      return;
    }

    // Clean up state
    linkedinStateStore.delete(state as string);

    const callbackUrl = process.env.LINKEDIN_REDIRECT_URI || `${process.env.BACKEND_URL || 'http://localhost:3001'}/api/social/linkedin/callback`;
    
    console.log('Exchanging code for access token with redirect URI:', callbackUrl);
    
    // Exchange code for access token
    const { accessToken } = await LinkedInService.getAccessToken(code as string, callbackUrl);

    // Get user profile
    const linkedinService = new LinkedInService(accessToken);
    const profile = await linkedinService.getProfile();

    // Save tokens to database
    await prisma.user.update({
      where: { id: userId },
      data: {
        linkedinAccessToken: accessToken,
        linkedinUsername: profile.name,
        linkedinUserId: profile.id,
      },
    });

    // Redirect back to frontend
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    res.redirect(`${frontendUrl}?linkedin_connected=true`);
  } catch (error: any) {
    console.error('LinkedIn callback error:', error);
    res.status(500).send('Failed to complete LinkedIn authentication');
  }
});

// Post to LinkedIn
router.post('/linkedin/post', async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const { text, generationRequestId } = req.body;

    if (!text) {
      res.status(400).json({ error: 'Text is required' });
      return;
    }

    const userId = (req.user as any).id;

    // Get the user's LinkedIn credentials
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        linkedinAccessToken: true,
        linkedinUsername: true,
      },
    });

    if (!user || !user.linkedinAccessToken) {
      res.status(404).json({ 
        error: 'LinkedIn account not connected. Please connect your LinkedIn account in your Profile.' 
      });
      return;
    }

    // Create LinkedIn service instance
    const linkedinService = new LinkedInService(user.linkedinAccessToken);

    // Post to LinkedIn
    const result = await linkedinService.postText(text);

    // Mark generation request as posted if provided
    if (generationRequestId) {
      await prisma.generationRequest.update({
        where: { id: generationRequestId },
        data: {
          postedToLinkedIn: true,
          linkedinPostId: result.id,
          linkedinPostedAt: new Date(),
        },
      });
    }

    res.json({
      success: true,
      post: result,
      message: `Post published successfully to LinkedIn (${user.linkedinUsername})!`,
    });
  } catch (error: any) {
    console.error('LinkedIn post error:', error);
    res.status(500).json({ error: error.message || 'Failed to post to LinkedIn' });
  }
});

export default router;
