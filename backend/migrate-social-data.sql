-- Migrate Twitter tokens from social_accounts to users table
UPDATE users u
SET 
  "twitterAccessToken" = sa."accessToken",
  "twitterAccessSecret" = sa."refreshToken",
  "twitterUsername" = sa."accountName",
  "twitterUserId" = sa."accountId"
FROM social_accounts sa
WHERE sa."userId" = u.id 
  AND sa.platform = 'twitter'
  AND sa."isActive" = true
  AND sa."accessToken" IS NOT NULL;
