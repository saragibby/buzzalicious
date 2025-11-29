/*
  Warnings:

  - You are about to drop the `social_accounts` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "social_accounts" DROP CONSTRAINT "social_accounts_userId_fkey";

-- AlterTable
ALTER TABLE "generation_requests" ADD COLUMN     "postedToTwitter" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "twitterPostId" TEXT,
ADD COLUMN     "twitterPostedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "twitterAccessSecret" TEXT,
ADD COLUMN     "twitterAccessToken" TEXT,
ADD COLUMN     "twitterUserId" TEXT,
ADD COLUMN     "twitterUsername" TEXT;

-- Migrate existing Twitter tokens from social_accounts to users
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

-- DropTable
DROP TABLE "social_accounts";
