-- CreateEnum
CREATE TYPE "PublishErrorClass" AS ENUM ('TRANSIENT', 'AUTH', 'CREDENTIAL', 'VALIDATION', 'POLICY', 'QUOTA');

-- AlterEnum
ALTER TYPE "TargetStatus" ADD VALUE 'BLOCKED';

-- AlterTable
ALTER TABLE "post_targets" ADD COLUMN     "errorClass" "PublishErrorClass",
ADD COLUMN     "nextAttemptAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "oauth_handshakes" (
    "id" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "brandId" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "requestToken" TEXT,
    "requestTokenSecret" TEXT,
    "initiatedByUserId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_handshakes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "oauth_handshakes_nonce_key" ON "oauth_handshakes"("nonce");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_handshakes_requestToken_key" ON "oauth_handshakes"("requestToken");

-- CreateIndex
CREATE INDEX "oauth_handshakes_credentialId_idx" ON "oauth_handshakes"("credentialId");

-- CreateIndex
CREATE INDEX "oauth_handshakes_expiresAt_idx" ON "oauth_handshakes"("expiresAt");

-- AddForeignKey
ALTER TABLE "oauth_handshakes" ADD CONSTRAINT "oauth_handshakes_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "platform_credentials"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_handshakes" ADD CONSTRAINT "oauth_handshakes_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_handshakes" ADD CONSTRAINT "oauth_handshakes_initiatedByUserId_fkey" FOREIGN KEY ("initiatedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

