import crypto from 'crypto';
import axios from 'axios';

export class CanvaService {
  private accessToken: string;

  constructor(accessToken: string) {
    this.accessToken = accessToken;
  }

  // Generate PKCE code verifier and challenge
  static generatePKCE(): { codeVerifier: string; codeChallenge: string } {
    // Generate code verifier (random string 43-128 characters)
    const codeVerifier = crypto.randomBytes(96).toString('base64url');
    
    // Generate code challenge (SHA256 hash of verifier, base64url encoded)
    const codeChallenge = crypto
      .createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');

    return { codeVerifier, codeChallenge };
  }

  // Generate Canva OAuth URL with PKCE
  static generateAuthUrl(
    redirectUri: string,
    state: string,
    codeChallenge: string
  ): string {
    const clientId = process.env.CANVA_CLIENT_ID;
    const scopes = [
      'asset:read',
      'asset:write',
      'brandtemplate:content:read',
      'brandtemplate:meta:read',
      'design:content:read',
      'design:content:write',
      'design:meta:read',
      'profile:read',
    ];
    const scopeString = scopes.join(' ');

    const authBaseUrl = process.env.CANVA_AUTH_URL || 'https://www.canva.com';

    const url = new URL(`${authBaseUrl}/api/oauth/authorize`);
    url.searchParams.append('code_challenge', codeChallenge);
    url.searchParams.append('code_challenge_method', 'S256');
    url.searchParams.append('scope', scopeString);
    url.searchParams.append('response_type', 'code');
    url.searchParams.append('client_id', clientId!);
    url.searchParams.append('state', state);
    url.searchParams.append('redirect_uri', redirectUri);

    return url.toString();
  }

  // Exchange authorization code for access token
  static async getAccessToken(
    code: string,
    codeVerifier: string,
    redirectUri: string
  ): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
  }> {
    try {
      const clientId = process.env.CANVA_CLIENT_ID;
      const clientSecret = process.env.CANVA_CLIENT_SECRET;
      const apiBaseUrl = process.env.CANVA_API_URL || 'https://api.canva.com';

      // Create Basic Auth header
      const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

      const params = new URLSearchParams({
        grant_type: 'authorization_code',
        code_verifier: codeVerifier,
        code: code,
        redirect_uri: redirectUri,
      });

      const response = await axios.post(
        `${apiBaseUrl}/rest/v1/oauth/token`,
        params.toString(),
        {
          headers: {
            'Authorization': `Basic ${credentials}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        }
      );

      return {
        accessToken: response.data.access_token,
        refreshToken: response.data.refresh_token,
        expiresIn: response.data.expires_in,
      };
    } catch (error: any) {
      console.error('Canva token exchange error:', error.response?.data || error.message);
      throw new Error('Failed to exchange Canva authorization code');
    }
  }

  // Refresh access token
  static async refreshAccessToken(refreshToken: string): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
  }> {
    try {
      const clientId = process.env.CANVA_CLIENT_ID;
      const clientSecret = process.env.CANVA_CLIENT_SECRET;
      const apiBaseUrl = process.env.CANVA_API_URL || 'https://api.canva.com';

      const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

      const params = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      });

      const response = await axios.post(
        `${apiBaseUrl}/rest/v1/oauth/token`,
        params.toString(),
        {
          headers: {
            'Authorization': `Basic ${credentials}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        }
      );

      return {
        accessToken: response.data.access_token,
        refreshToken: response.data.refresh_token,
        expiresIn: response.data.expires_in,
      };
    } catch (error: any) {
      console.error('Canva token refresh error:', error.response?.data || error.message);
      throw new Error('Failed to refresh Canva access token');
    }
  }

  // Get user profile
  async getProfile(): Promise<{ id: string; displayName: string; email?: string }> {
    try {
      const apiBaseUrl = process.env.CANVA_API_URL || 'https://api.canva.com';
      
      const response = await axios.get(`${apiBaseUrl}/rest/v1/users/me/profile`, {
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
        },
      });

      console.log('Canva profile response data:', JSON.stringify(response.data, null, 2));

      // Canva returns profile data nested under 'profile' key
      const profileData = response.data.profile || response.data;
      
      // Extract user ID from token by making a separate call to get user info
      // For now, use display_name as a unique identifier since Canva doesn't return user ID in profile
      const userId = profileData.user_id || profileData.id || profileData.display_name;

      return {
        id: userId,
        displayName: profileData.display_name,
        email: profileData.email,
      };
    } catch (error: any) {
      console.error('Canva profile error:', error.response?.data || error.message);
      throw new Error('Failed to fetch Canva profile');
    }
  }

  // Create design from template with autofill data
  async createDesignFromText(
    brandTemplateId: string,
    text: string,
    title: string
  ): Promise<{ designId: string; url: string }> {
    try {
      const apiBaseUrl = process.env.CANVA_API_URL || 'https://api.canva.com';

      // First, get the brand template dataset to see what fields are available
      const datasetResponse = await axios.get(
        `${apiBaseUrl}/rest/v1/brand-templates/${brandTemplateId}/dataset`,
        {
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
          },
        }
      );

      const dataset = datasetResponse.data.dataset || {};
      
      // Build autofill data - look for text fields and populate with our text
      const autofillData: Record<string, any> = {};
      for (const [fieldName, fieldDef] of Object.entries(dataset)) {
        if ((fieldDef as any).type === 'text') {
          autofillData[fieldName] = {
            type: 'text',
            text: text,
          };
        }
      }

      // Create autofill job
      const autofillResponse = await axios.post(
        `${apiBaseUrl}/rest/v1/autofills`,
        {
          brand_template_id: brandTemplateId,
          title: title,
          data: autofillData,
        },
        {
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json',
          },
        }
      );

      const jobId = autofillResponse.data.job.id;

      // Poll for job completion
      let attempts = 0;
      const maxAttempts = 30; // 30 seconds max
      
      while (attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        const statusResponse = await axios.get(
          `${apiBaseUrl}/rest/v1/autofills/${jobId}`,
          {
            headers: {
              Authorization: `Bearer ${this.accessToken}`,
            },
          }
        );

        const job = statusResponse.data.job;
        
        if (job.status === 'success' && job.result?.design) {
          const designId = job.result.design.id;
          
          // Get full design details including edit URL
          const designResponse = await axios.get(
            `${apiBaseUrl}/rest/v1/designs/${designId}`,
            {
              headers: {
                Authorization: `Bearer ${this.accessToken}`,
              },
            }
          );

          return {
            designId: designId,
            url: designResponse.data.urls.edit_url,
          };
        } else if (job.status === 'failed') {
          throw new Error(job.error?.message || 'Autofill job failed');
        }

        attempts++;
      }

      throw new Error('Autofill job timed out');
    } catch (error: any) {
      console.error('Canva design creation error:', error.response?.data || error.message);
      throw new Error('Failed to create Canva design: ' + (error.response?.data?.message || error.message));
    }
  }

  // List available brand templates
  async listBrandTemplates(): Promise<Array<{ id: string; name: string; thumbnail?: string }>> {
    try {
      const apiBaseUrl = process.env.CANVA_API_URL || 'https://api.canva.com';
      
      const response = await axios.get(`${apiBaseUrl}/rest/v1/brand-templates`, {
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
        },
        params: {
          dataset: 'non_empty', // Only templates with autofill fields
        },
      });

      return response.data.items.map((template: any) => ({
        id: template.id,
        name: template.name,
        thumbnail: template.thumbnail?.url,
      }));
    } catch (error: any) {
      console.error('Canva list templates error:', error.response?.data || error.message);
      throw new Error('Failed to list Canva brand templates');
    }
  }
}
