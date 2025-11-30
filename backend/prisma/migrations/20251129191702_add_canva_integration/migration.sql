-- AlterTable
ALTER TABLE "generation_requests" ADD COLUMN     "canvaCreatedAt" TIMESTAMP(3),
ADD COLUMN     "canvaDesignId" TEXT,
ADD COLUMN     "canvaDesignUrl" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "canvaAccessToken" TEXT,
ADD COLUMN     "canvaRefreshToken" TEXT,
ADD COLUMN     "canvaTokenExpiry" TIMESTAMP(3),
ADD COLUMN     "canvaUserId" TEXT,
ADD COLUMN     "linkedinTokenExpiry" TIMESTAMP(3);
