/**
 * PARKED — carried over from the prototype for W6, not wired into anything.
 *
 * Nothing imports this file. It is kept because the API-shape knowledge in it is real
 * and worth preserving: `v1.uploadMedia` for media and `v2.tweet` for posting, in the
 * same client, and the fixed-length tuple that `media_ids` demands.
 *
 * **W6 must rewrite the constructor before using this.** It reads
 * `process.env.TWITTER_API_KEY` / `TWITTER_API_SECRET`, which contradicts ADR-0009: every
 * `PlatformAdapter` method takes an already-resolved credential and no adapter reads the
 * environment. The app key and secret belong to the *client's* X app, resolved per
 * workspace by the `CredentialResolver`, and differ between workspaces.
 *
 * The OAuth 1.0a handshake that produces `accessToken`/`accessSecret` is not here — it
 * lived in the deleted `social.routes.ts` and is captured in
 * `docs/reference/x-oauth1a.md`. Read that before implementing the adapter.
 */
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
  async postTweetWithMedia(
    text: string,
    mediaUrls: string[],
  ): Promise<{ id: string; text: string }> {
    // Upload media first
    const mediaIds: string[] = [];

    for (const url of mediaUrls) {
      // Fetch image from URL
      const response = await fetch(url);
      const buffer = Buffer.from(await response.arrayBuffer());

      // Upload to Twitter
      const mediaId = await this.client.v1.uploadMedia(buffer, {
        mimeType: response.headers.get('content-type') || 'image/jpeg',
      });
      mediaIds.push(mediaId);
    }

    // Post tweet with media (max 4 images)
    const tweet = await this.client.v2.tweet(text, {
      media: {
        media_ids: mediaIds.slice(0, 4) as
          [string] | [string, string] | [string, string, string] | [string, string, string, string],
      },
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
  static async generateAuthUrl(
    callbackUrl: string,
  ): Promise<{ url: string; oauth_token: string; oauth_token_secret: string }> {
    // W6: the prototype wrapped this in a try/catch that logged the provider's error
    // detail to the console and rethrew unchanged. The replacement should raise an
    // ExternalServiceError carrying the cause, so the error handler logs the detail
    // server-side and the client is told nothing.
    const client = new TwitterApi({
      appKey: process.env.TWITTER_API_KEY!,
      appSecret: process.env.TWITTER_API_SECRET!,
    });

    return client.generateAuthLink(callbackUrl);
  }

  /**
   * Complete OAuth flow and get access tokens
   */
  static async getAccessToken(
    oauthToken: string,
    oauthVerifier: string,
    oauthTokenSecret: string,
  ): Promise<{
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
