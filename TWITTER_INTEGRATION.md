# Twitter Integration Guide

This guide explains how to set up Twitter posting functionality for Buzzalicious.

## Overview

The platform allows users to:
1. Connect their Twitter accounts via OAuth 1.0a
2. Post tweets (text only or with images)
3. Manage multiple Twitter accounts
4. Toggle accounts active/inactive for posting

## Setup Steps

### 1. Create a Twitter Developer Account

1. Go to [Twitter Developer Portal](https://developer.twitter.com/)
2. Sign up for a developer account (if you don't have one)
3. Create a new Project and App
4. Enable OAuth 1.0a authentication

### 2. Get Your API Credentials

In your Twitter App settings, you need:
- **API Key** (also called Consumer Key)
- **API Secret** (also called Consumer Secret)

⚠️ **Important**: You need **Elevated Access** (not Basic) to post tweets.

To request Elevated Access:
1. Go to your Twitter Developer Portal
2. Click on your project
3. Request "Elevated" access
4. Fill out the form explaining your use case
5. Wait for approval (usually 1-2 days)

### 3. Configure App Permissions

In your Twitter App settings:
1. Go to "User authentication settings"
2. Enable OAuth 1.0a
3. Set App permissions to **Read and Write** (or Read, Write, and Direct Messages)
4. Set Callback URL to: `http://localhost:3001/api/social/twitter/callback`
5. For production, add your production URL: `https://your-domain.com/api/social/twitter/callback`

### 4. Add Environment Variables

Add these to your `backend/.env` file:

```env
TWITTER_API_KEY="your-api-key-here"
TWITTER_API_SECRET="your-api-secret-here"
BACKEND_URL="http://localhost:3001"
```

### 5. Update Frontend to Connect Twitter

The Profile page already supports adding social accounts. To enable OAuth connection:

Add a "Connect" button in the Profile component that calls:

```typescript
const connectTwitter = async () => {
  const res = await fetch(`${backendUrl}/api/social/twitter/connect`, {
    credentials: 'include',
  });
  const data = await res.json();
  window.location.href = data.authUrl; // Redirect to Twitter
};
```

## API Endpoints

### Connect Twitter Account
```
GET /api/social/twitter/connect
```
Returns an OAuth URL to redirect the user to Twitter for authentication.

### OAuth Callback (automatic)
```
GET /api/social/twitter/callback?oauth_token=...&oauth_verifier=...
```
Handles the Twitter OAuth callback and saves the access tokens.

### Post a Tweet
```
POST /api/social/twitter/post
Body: {
  "accountId": "social-account-uuid",
  "text": "Your tweet text here",
  "mediaUrls": ["https://url-to-image.jpg"] // optional
}
```
Posts a tweet to the specified Twitter account.

### Get Twitter Profile
```
GET /api/social/twitter/profile/:accountId
```
Fetches the Twitter profile information for verification.

## Usage Flow

1. **User connects Twitter account:**
   - User clicks "Connect Twitter" in Profile page
   - Redirected to Twitter for authorization
   - User approves the app
   - Redirected back with tokens saved to database

2. **User posts a tweet:**
   ```typescript
   const postTweet = async () => {
     const response = await fetch(`${backendUrl}/api/social/twitter/post`, {
       method: 'POST',
       credentials: 'include',
       headers: { 'Content-Type': 'application/json' },
       body: JSON.stringify({
         accountId: 'uuid-of-connected-twitter-account',
         text: 'Hello from Buzzalicious! 🐝',
       }),
     });
     const result = await response.json();
     console.log('Tweet posted:', result.tweet);
   };
   ```

3. **Post with AI-generated content:**
   - Generate content using AI Generator
   - Use the generated text to post to Twitter
   - Optionally include AI-generated images

## Security Notes

- **Access tokens are stored in the database** - In production, encrypt these tokens
- **OAuth token secrets** are temporarily stored in memory - Use Redis for production
- **Rate limits**: Twitter has rate limits (300 tweets per 3 hours for standard access)
- **Token refresh**: OAuth 1.0a tokens don't expire, but users may revoke access

## Database Schema

The `SocialAccount` model stores:
- `accessToken` - Twitter OAuth access token
- `refreshToken` - Twitter OAuth access secret (stored in refreshToken field)
- `accountId` - Twitter user ID
- `accountName` - Twitter username (screen name)
- `platform` - Set to 'twitter'
- `isActive` - Whether this account is active for posting

## Testing

1. Add your Twitter API credentials to `.env`
2. Start the server: `npm run dev`
3. Log in to the app
4. Go to Profile page
5. Add a Twitter account manually (or implement OAuth connect button)
6. Use the API to post a test tweet

## Production Considerations

1. **Encrypt tokens**: Use a library like `crypto` to encrypt access tokens before storing
2. **Use Redis**: Store temporary OAuth tokens in Redis instead of memory
3. **Add webhook**: Set up Twitter Account Activity API for real-time updates
4. **Implement retry logic**: Handle Twitter API failures gracefully
5. **Queue system**: Use a job queue (Bull, BullMQ) for posting tweets asynchronously
6. **Rate limiting**: Implement rate limiting to avoid hitting Twitter's limits
7. **Update callback URLs**: Add production URLs to Twitter App settings

## Common Issues

**Error: "Read-only application cannot POST"**
- Your app permissions are set to Read-only
- Change to "Read and Write" in Twitter App settings

**Error: "403 Forbidden"**
- You don't have Elevated Access
- Request it in the Twitter Developer Portal

**Error: "Invalid or expired token"**
- User revoked access
- Re-authenticate the user

**Error: "Status is a duplicate"**
- Twitter doesn't allow posting the same text twice
- Add variation to your tweets (timestamp, emoji, etc.)

## Next Steps

To complete the Twitter integration:
1. Add "Connect Twitter" button to Profile page
2. Create a UI for posting tweets
3. Integrate with AI Generator to post AI-generated content
4. Add scheduling functionality for future posts
5. Implement analytics to track tweet performance
