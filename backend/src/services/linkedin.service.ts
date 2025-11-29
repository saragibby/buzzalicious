import axios from 'axios';

export class LinkedInService {
  private accessToken: string;

  constructor(accessToken: string) {
    this.accessToken = accessToken;
  }

  // Generate LinkedIn OAuth URL
  static generateAuthUrl(callbackUrl: string, state: string): string {
    const clientId = process.env.LINKEDIN_CLIENT_ID;
    const scope = 'openid profile w_member_social email';

    return `https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(callbackUrl)}&state=${state}&scope=${encodeURIComponent(scope)}`;
  }

  // Exchange authorization code for access token
  static async getAccessToken(code: string, redirectUri: string): Promise<{
    accessToken: string;
    expiresIn: number;
  }> {
    try {
      const response = await axios.post(
        'https://www.linkedin.com/oauth/v2/accessToken',
        null,
        {
          params: {
            grant_type: 'authorization_code',
            code,
            redirect_uri: redirectUri,
            client_id: process.env.LINKEDIN_CLIENT_ID,
            client_secret: process.env.LINKEDIN_CLIENT_SECRET,
          },
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        }
      );

      return {
        accessToken: response.data.access_token,
        expiresIn: response.data.expires_in,
      };
    } catch (error: any) {
      console.error('LinkedIn token exchange error:', error.response?.data || error.message);
      throw new Error('Failed to exchange LinkedIn authorization code');
    }
  }

  // Get user profile
  async getProfile(): Promise<{ id: string; name: string; email?: string }> {
    try {
      const response = await axios.get('https://api.linkedin.com/v2/userinfo', {
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
        },
      });

      return {
        id: response.data.sub,
        name: response.data.name,
        email: response.data.email,
      };
    } catch (error: any) {
      console.error('LinkedIn profile error:', error.response?.data || error.message);
      throw new Error('Failed to fetch LinkedIn profile');
    }
  }

  // Post to LinkedIn
  async postText(text: string): Promise<{ id: string; url: string }> {
    try {
      // First, get the user's LinkedIn ID
      const profile = await this.getProfile();

      // Create a post (share)
      const response = await axios.post(
        'https://api.linkedin.com/v2/ugcPosts',
        {
          author: `urn:li:person:${profile.id}`,
          lifecycleState: 'PUBLISHED',
          specificContent: {
            'com.linkedin.ugc.ShareContent': {
              shareCommentary: {
                text: text,
              },
              shareMediaCategory: 'NONE',
            },
          },
          visibility: {
            'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC',
          },
        },
        {
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json',
            'X-Restli-Protocol-Version': '2.0.0',
          },
        }
      );

      const postId = response.data.id;
      const postUrl = `https://www.linkedin.com/feed/update/${postId}`;

      return {
        id: postId,
        url: postUrl,
      };
    } catch (error: any) {
      console.error('LinkedIn post error:', error.response?.data || error.message);
      throw new Error('Failed to post to LinkedIn');
    }
  }
}
