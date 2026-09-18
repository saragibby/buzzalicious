-- CreateEnum
CREATE TYPE "UsageMetric" AS ENUM ('AI_TOKENS', 'POST_PUBLISHED', 'RENDITION_RENDERED', 'TREND_REFRESH', 'CONNECTED_ACCOUNT');

-- AlterTable
ALTER TABLE "workspaces" ADD COLUMN     "aiMonthlyCeilingUsd" DECIMAL(10,2);

-- CreateTable
CREATE TABLE "usage_events" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "brandId" TEXT,
    "metric" "UsageMetric" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "providerCostUsd" DECIMAL(12,6),
    "idempotencyKey" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "aiGenerationId" TEXT,
    "postTargetId" TEXT,
    "renditionId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_period_rollups" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "metric" "UsageMetric" NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "quantity" BIGINT NOT NULL DEFAULT 0,
    "providerCostUsd" DECIMAL(14,6) NOT NULL DEFAULT 0,
    "eventCount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "usage_period_rollups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "usage_events_idempotencyKey_key" ON "usage_events"("idempotencyKey");

-- CreateIndex
CREATE INDEX "usage_events_workspaceId_metric_periodStart_idx" ON "usage_events"("workspaceId", "metric", "periodStart");

-- CreateIndex
CREATE INDEX "usage_events_workspaceId_occurredAt_idx" ON "usage_events"("workspaceId", "occurredAt");

-- CreateIndex
CREATE INDEX "usage_events_aiGenerationId_idx" ON "usage_events"("aiGenerationId");

-- CreateIndex
CREATE INDEX "usage_period_rollups_workspaceId_periodStart_idx" ON "usage_period_rollups"("workspaceId", "periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "usage_period_rollups_workspaceId_metric_periodStart_key" ON "usage_period_rollups"("workspaceId", "metric", "periodStart");

-- AddForeignKey
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_aiGenerationId_fkey" FOREIGN KEY ("aiGenerationId") REFERENCES "ai_generations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_postTargetId_fkey" FOREIGN KEY ("postTargetId") REFERENCES "post_targets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_renditionId_fkey" FOREIGN KEY ("renditionId") REFERENCES "renditions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_period_rollups" ADD CONSTRAINT "usage_period_rollups_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The reserved platform workspace (ADR-0011).
--
-- Trend classification is platform-global by ADR-0010 — one LLM call per trend, reused by
-- every tenant — so there is no client workspace to charge, and charging one would be
-- wrong. `UsageEvent.workspaceId` is required because the workspace is the billing entity,
-- so platform-owned spend needs a workspace of its own. It has no memberships and no
-- brands, which keeps it out of every user-facing workspace list.
--
-- Seeded here rather than only in the development seed: the fuse must work on a production
-- database, and `prisma migrate deploy` is the only thing that runs there. The id is the
-- same value `seedId('workspace', 'platform')` derives, asserted by a test.
INSERT INTO "workspaces" ("id", "name", "slug", "createdAt", "updatedAt")
VALUES ('1bf69650-f06e-5901-8d12-f30ef2d3d038', 'Buzzalicious Platform', 'platform', NOW(), NOW())
ON CONFLICT ("slug") DO NOTHING;
