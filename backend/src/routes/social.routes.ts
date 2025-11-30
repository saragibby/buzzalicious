import { Router, Request, Response } from 'express';
import prisma from '../db';
import { TwitterService } from '../services/twitter.service';
import { LinkedInService } from '../services/linkedin.service';
import { CanvaService } from '../services/canva.service';

const router = Router();

// Helper function to get frontend URL based on environment
const getFrontendUrl = () => {
  if (process.env.NODE_ENV === 'production') {
    return process.env.FRONTEND_URL || 'https://your-app.herokuapp.com';
  }
  return 'http://127.0.0.1:3000';
};

// Store temporary OAuth tokens in memory (in production, use Redis or database)
const oauthTokenStore = new Map<string, { secret: string; userId: string }>();
const linkedinStateStore = new Map<string, string>(); // state -> userId
const canvaStateStore = new Map<string, { userId: string; codeVerifier: string }>(); // state -> userId + codeVerifier

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

// Disconnect Twitter
router.post('/twitter/disconnect', async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const userId = (req.user as any).id;
    
    await prisma.user.update({
      where: { id: userId },
      data: {
        twitterAccessToken: null,
        twitterAccessSecret: null,
        twitterUsername: null,
        twitterUserId: null,
      },
    });

    res.json({ success: true, message: 'Twitter account disconnected' });
  } catch (error: any) {
    console.error('Twitter disconnect error:', error);
    res.status(500).json({ error: 'Failed to disconnect Twitter account' });
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

    const callbackUrl = `${process.env.BACKEND_URL || 'http://127.0.0.1:3001'}/api/social/twitter/callback`;
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
    const frontendUrl = getFrontendUrl();
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

    const callbackUrl = process.env.LINKEDIN_REDIRECT_URI || `${process.env.BACKEND_URL || 'http://127.0.0.1:3001'}/api/social/linkedin/callback`;
    
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
      const frontendUrl = getFrontendUrl();
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

    const callbackUrl = process.env.LINKEDIN_REDIRECT_URI || `${process.env.BACKEND_URL || 'http://127.0.0.1:3001'}/api/social/linkedin/callback`;
    
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
    const frontendUrl = getFrontendUrl();
    res.redirect(`${frontendUrl}?linkedin_connected=true`);
  } catch (error: any) {
    console.error('LinkedIn callback error:', error);
    res.status(500).send('Failed to complete LinkedIn authentication');
  }
});

// Disconnect LinkedIn
router.post('/linkedin/disconnect', async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const userId = (req.user as any).id;
    
    await prisma.user.update({
      where: { id: userId },
      data: {
        linkedinAccessToken: null,
        linkedinUsername: null,
      },
    });

    res.json({ success: true, message: 'LinkedIn account disconnected' });
  } catch (error: any) {
    console.error('LinkedIn disconnect error:', error);
    res.status(500).json({ error: 'Failed to disconnect LinkedIn account' });
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

// ============= Canva Routes =============

// Get Canva authorization status
router.get('/canva/status', async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const userId = (req.user as any).id;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        canvaAccessToken: true,
        canvaUserId: true,
        canvaTokenExpiry: true,
      },
    });

    console.log('Canva status check for user:', userId);
    console.log('Has access token:', !!user?.canvaAccessToken);
    console.log('Has userId:', !!user?.canvaUserId);
    console.log('Token expiry:', user?.canvaTokenExpiry);

    const isConnected = !!(user?.canvaAccessToken && user?.canvaUserId);
    const isExpired = user?.canvaTokenExpiry ? new Date(user.canvaTokenExpiry) < new Date() : true;

    console.log('Is connected:', isConnected);
    console.log('Is expired:', isExpired);
    console.log('Final status:', isConnected && !isExpired);

    res.json({
      isConnected: isConnected && !isExpired,
      userId: user?.canvaUserId || null,
    });
  } catch (error: any) {
    console.error('Canva status error:', error);
    res.status(500).json({ error: 'Failed to fetch Canva status' });
  }
});

// Initiate Canva OAuth flow
router.get('/canva/connect', async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    console.log('Canva OAuth Debug:');
    console.log('- CLIENT_ID:', process.env.CANVA_CLIENT_ID ? 'SET' : 'NOT SET');
    console.log('- CLIENT_SECRET:', process.env.CANVA_CLIENT_SECRET ? 'SET' : 'NOT SET');

    if (!process.env.CANVA_CLIENT_ID || !process.env.CANVA_CLIENT_SECRET) {
      console.error('Canva API credentials not configured');
      res.status(500).json({ 
        error: 'Canva API credentials not configured. Please add CANVA_CLIENT_ID and CANVA_CLIENT_SECRET to your .env file.' 
      });
      return;
    }

    const callbackUrl = `${process.env.BACKEND_URL || 'http://127.0.0.1:3001'}/api/social/canva/callback`;
    
    console.log('Using callback URL:', callbackUrl);
    
    // Generate PKCE parameters
    const { codeVerifier, codeChallenge } = CanvaService.generatePKCE();
    
    // Generate a random state for CSRF protection
    const state = Math.random().toString(36).substring(7);
    
    const authUrl = CanvaService.generateAuthUrl(callbackUrl, state, codeChallenge);
    
    console.log('Generated Canva OAuth URL');
    console.log('Full auth URL:', authUrl);

    // Store state with user ID and code verifier
    canvaStateStore.set(state, {
      userId: (req.user as any).id,
      codeVerifier,
    });

    res.json({ authUrl });
  } catch (error: any) {
    console.error('Canva OAuth error:', error);
    res.status(500).json({ 
      error: 'Failed to initiate Canva authentication',
      details: error.message || 'Unknown error'
    });
  }
});

// Canva OAuth callback
router.get('/canva/callback', async (req: Request, res: Response): Promise<void> => {
  try {
    console.log('========== CANVA CALLBACK START ==========');
    console.log('Canva callback received with query params:', req.query);
    
    const { code, state, error, error_description } = req.query;

    // Check if Canva returned an error
    if (error) {
      console.error('Canva OAuth error:', error, error_description);
      const frontendUrl = getFrontendUrl();
      const errorMsg = typeof error_description === 'string' ? error_description : (typeof error === 'string' ? error : 'Unknown error');
      res.redirect(`${frontendUrl}?canva_error=${encodeURIComponent(errorMsg)}`);
      return;
    }

    if (!code || !state) {
      console.error('Missing OAuth parameters. Received:', { code: !!code, state: !!state });
      res.status(400).send('Missing OAuth parameters from Canva');
      return;
    }

    // Retrieve user ID and code verifier from state
    const stored = canvaStateStore.get(state as string);
    if (!stored) {
      console.error('Invalid OAuth state. State not found in store.');
      console.error('Available states in store:', Array.from(canvaStateStore.keys()));
      res.status(400).send('Invalid OAuth state');
      return;
    }

    console.log('Found stored state for userId:', stored.userId);

    // Clean up state
    canvaStateStore.delete(state as string);

    const callbackUrl = `${process.env.BACKEND_URL || 'http://127.0.0.1:3001'}/api/social/canva/callback`;
    
    console.log('Exchanging code for access token with callback URL:', callbackUrl);
    
    // Exchange code for access token
    const { accessToken, refreshToken, expiresIn } = await CanvaService.getAccessToken(
      code as string,
      stored.codeVerifier,
      callbackUrl
    );

    console.log('Successfully received tokens from Canva');
    console.log('Access token length:', accessToken?.length);
    console.log('Refresh token length:', refreshToken?.length);
    console.log('Expires in:', expiresIn);

    // Get user profile
    const canvaService = new CanvaService(accessToken);
    const profile = await canvaService.getProfile();
    
    console.log('Got Canva profile:', { id: profile.id, displayName: profile.displayName });

    // Calculate token expiry
    const tokenExpiry = new Date(Date.now() + expiresIn * 1000);

    // Save tokens to database
    console.log('Saving tokens to database for user:', stored.userId);
    const updatedUser = await prisma.user.update({
      where: { id: stored.userId },
      data: {
        canvaAccessToken: accessToken,
        canvaRefreshToken: refreshToken,
        canvaUserId: profile.id,
        canvaTokenExpiry: tokenExpiry,
      },
    });

    console.log('Successfully saved Canva tokens to database');
    console.log('Updated user canvaUserId:', updatedUser.canvaUserId);

    // Redirect back to frontend (use 127.0.0.1 to match Canva's requirement)
    const frontendUrl = getFrontendUrl();
    console.log('Redirecting to frontend:', `${frontendUrl}?canva_connected=true`);
    console.log('========== CANVA CALLBACK END ==========');
    res.redirect(`${frontendUrl}?canva_connected=true`);
  } catch (error: any) {
    console.error('========== CANVA CALLBACK ERROR ==========');
    console.error('Canva callback error:', error);
    console.error('Error stack:', error.stack);
    res.status(500).send('Failed to complete Canva authentication');
  }
});

// Create Canva design from text
router.post('/canva/create-design', async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const { text, title, brandTemplateId, generationRequestId } = req.body;

    if (!text || !brandTemplateId) {
      res.status(400).json({ error: 'Text and brandTemplateId are required' });
      return;
    }

    const userId = (req.user as any).id;

    // Get the user's Canva credentials
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        canvaAccessToken: true,
        canvaRefreshToken: true,
        canvaTokenExpiry: true,
        canvaUserId: true,
      },
    });

    if (!user || !user.canvaAccessToken) {
      res.status(404).json({ 
        error: 'Canva account not connected. Please connect your Canva account in your Profile.' 
      });
      return;
    }

    // Check if token is expired and refresh if needed
    let accessToken = user.canvaAccessToken;
    if (user.canvaTokenExpiry && new Date(user.canvaTokenExpiry) < new Date()) {
      console.log('Canva token expired, refreshing...');
      const refreshed = await CanvaService.refreshAccessToken(user.canvaRefreshToken!);
      accessToken = refreshed.accessToken;
      
      // Update tokens in database
      await prisma.user.update({
        where: { id: userId },
        data: {
          canvaAccessToken: refreshed.accessToken,
          canvaRefreshToken: refreshed.refreshToken,
          canvaTokenExpiry: new Date(Date.now() + refreshed.expiresIn * 1000),
        },
      });
    }

    // Create Canva service instance
    const canvaService = new CanvaService(accessToken);

    // Create design from text
    const designTitle = title || 'AI Generated Design';
    const result = await canvaService.createDesignFromText(brandTemplateId, text, designTitle);

    // Mark generation request with Canva design if provided
    if (generationRequestId) {
      await prisma.generationRequest.update({
        where: { id: generationRequestId },
        data: {
          canvaDesignId: result.designId,
          canvaDesignUrl: result.url,
          canvaCreatedAt: new Date(),
        },
      });
    }

    res.json({
      success: true,
      design: result,
      message: 'Canva design created successfully!',
    });
  } catch (error: any) {
    console.error('Canva design creation error:', error);
    res.status(500).json({ error: error.message || 'Failed to create Canva design' });
  }
});

// List Canva brand templates
router.get('/canva/templates', async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const userId = (req.user as any).id;

    // Get the user's Canva credentials
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        canvaAccessToken: true,
        canvaRefreshToken: true,
        canvaTokenExpiry: true,
      },
    });

    if (!user || !user.canvaAccessToken) {
      res.status(404).json({ 
        error: 'Canva account not connected. Please connect your Canva account in your Profile.' 
      });
      return;
    }

    // Check if token is expired and refresh if needed
    let accessToken = user.canvaAccessToken;
    if (user.canvaTokenExpiry && new Date(user.canvaTokenExpiry) < new Date()) {
      const refreshed = await CanvaService.refreshAccessToken(user.canvaRefreshToken!);
      accessToken = refreshed.accessToken;
      
      // Update tokens in database
      await prisma.user.update({
        where: { id: userId },
        data: {
          canvaAccessToken: refreshed.accessToken,
          canvaRefreshToken: refreshed.refreshToken,
          canvaTokenExpiry: new Date(Date.now() + refreshed.expiresIn * 1000),
        },
      });
    }

    // Create Canva service instance
    const canvaService = new CanvaService(accessToken);

    // List brand templates
    const templates = await canvaService.listBrandTemplates();

    res.json({
      templates,
    });
  } catch (error: any) {
    console.error('Canva list templates error:', error);
    res.status(500).json({ error: error.message || 'Failed to list Canva templates' });
  }
});

// Disconnect Canva
router.post('/canva/disconnect', async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const userId = (req.user as any).id;
    
    await prisma.user.update({
      where: { id: userId },
      data: {
        canvaAccessToken: null,
        canvaRefreshToken: null,
        canvaUserId: null,
        canvaTokenExpiry: null,
      },
    });

    res.json({ success: true, message: 'Canva account disconnected' });
  } catch (error: any) {
    console.error('Canva disconnect error:', error);
    res.status(500).json({ error: 'Failed to disconnect Canva account' });
  }
});

export default router;
