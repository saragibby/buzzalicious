-- AlterTable
ALTER TABLE "generation_requests" ADD COLUMN     "linkedinPostId" TEXT,
ADD COLUMN     "linkedinPostedAt" TIMESTAMP(3),
ADD COLUMN     "postedToLinkedIn" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "linkedinAccessToken" TEXT,
ADD COLUMN     "linkedinUserId" TEXT,
ADD COLUMN     "linkedinUsername" TEXT;
