-- AlterTable
ALTER TABLE "generation_requests" ADD COLUMN     "completionTokens" INTEGER,
ADD COLUMN     "estimatedCost" DOUBLE PRECISION,
ADD COLUMN     "modelUsed" TEXT,
ADD COLUMN     "promptTokens" INTEGER,
ADD COLUMN     "responseTimeMs" INTEGER,
ADD COLUMN     "totalTokens" INTEGER;
