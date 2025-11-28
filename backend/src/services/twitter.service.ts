import { TwitterApi } from 'twitter-api-v2';

export class TwitterService {
  private client: TwitterApi;

  constructor(accessToken: string, accessSecret: string) {
    this.client = new TwitterApi({
      appKey: process.env.TWITTER_API_KEY!,
      appSecret: process.env.TWITTER_API_SECRET!,
      accessToken,
      accessSecret,
    });
  }

  /**
   * Post a tweet
   */
  async postTweet(text: string): Promise<{ id: string; text: string }> {
    const tweet = await this.client.v2.tweet(text);
    return {
      id: tweet.data.id,
      text: tweet.data.text,
    };
  }

  /**
   * Post a tweet with media (images)
   */
  async postTweetWithMedia(text: string, mediaUrls: string[]): Promise<{ id: string; text: string }> {
    // Upload media first
    const mediaIds: string[] = [];
    
    for (const url of mediaUrls) {
      // Fetch image from URL
      const response = await fetch(url);
      const buffer = Buffer.from(await response.arrayBuffer());
      
      // Upload to Twitter
      const mediaId = await this.client.v1.uploadMedia(buffer, { mimeType: response.headers.get('content-type') || 'image/jpeg' });
      mediaIds.push(mediaId);
    }

    // Post tweet with media (max 4 images)
    const tweet = await this.client.v2.tweet(text, {
      media: { media_ids: mediaIds.slice(0, 4) as [string] | [string, string] | [string, string, string] | [string, string, string, string] },
    });

    return {
      id: tweet.data.id,
      text: tweet.data.text,
    };
  }

  /**
   * Get user's Twitter profile
   */
  async getProfile() {
    const user = await this.client.v2.me();
    return user.data;
  }

  /**
   * Generate OAuth 1.0a authorization URL
   */
  static async generateAuthUrl(callbackUrl: string): Promise<{ url: string; oauth_token: string; oauth_token_secret: string }> {
    try {
      const client = new TwitterApi({
        appKey: process.env.TWITTER_API_KEY!,
        appSecret: process.env.TWITTER_API_SECRET!,
      });

      console.log('Generating Twitter auth link with callback:', callbackUrl);
      const authLink = await client.generateAuthLink(callbackUrl);
      console.log('Successfully generated auth link');
      return authLink;
    } catch (error: any) {
      console.error('Twitter API Error Details:', {
        message: error.message,
        code: error.code,
        data: error.data,
      });
      throw error;
    }
  }

  /**
   * Complete OAuth flow and get access tokens
   */
  static async getAccessToken(oauthToken: string, oauthVerifier: string, oauthTokenSecret: string): Promise<{
    accessToken: string;
    accessSecret: string;
    userId: string;
    screenName: string;
  }> {
    const client = new TwitterApi({
      appKey: process.env.TWITTER_API_KEY!,
      appSecret: process.env.TWITTER_API_SECRET!,
      accessToken: oauthToken,
      accessSecret: oauthTokenSecret,
    });

    const { accessToken, accessSecret, userId, screenName } = await client.login(oauthVerifier);

    return {
      accessToken,
      accessSecret,
      userId,
      screenName,
    };
  }
}
