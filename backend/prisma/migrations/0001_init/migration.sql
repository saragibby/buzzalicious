-- CreateEnum
CREATE TYPE "Role" AS ENUM ('OWNER', 'ADMIN', 'MEMBER');

-- CreateEnum
CREATE TYPE "PersonaStatus" AS ENUM ('SUGGESTED', 'APPROVED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "Platform" AS ENUM ('INSTAGRAM', 'FACEBOOK', 'THREADS', 'X', 'LINKEDIN', 'TIKTOK', 'YOUTUBE');

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'REVOKED', 'ERROR');

-- CreateEnum
CREATE TYPE "CredentialMode" AS ENUM ('DIRECT_TOKEN', 'CLIENT_APP', 'PLATFORM_APP');

-- CreateEnum
CREATE TYPE "CredentialStatus" AS ENUM ('PENDING', 'ACTIVE', 'INSUFFICIENT', 'INVALID', 'REVOKED');

-- CreateEnum
CREATE TYPE "AssetKind" AS ENUM ('LOGO', 'PHOTO', 'VIDEO', 'FONT', 'RENDITION');

-- CreateEnum
CREATE TYPE "TemplateKind" AS ENUM ('IMAGE', 'CAROUSEL', 'TEXT_ONLY', 'VIDEO');

-- CreateEnum
CREATE TYPE "TemplateStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "AspectRatio" AS ENUM ('SQUARE_1_1', 'PORTRAIT_4_5', 'STORY_9_16', 'LANDSCAPE_16_9');

-- CreateEnum
CREATE TYPE "TrendKind" AS ENUM ('HASHTAG', 'SOUND', 'FORMAT', 'TOPIC');

-- CreateEnum
CREATE TYPE "TrendStatus" AS ENUM ('EMERGING', 'PEAKING', 'DECLINING', 'STALE');

-- CreateEnum
CREATE TYPE "MediaType" AS ENUM ('IMAGE', 'TEXT', 'VIDEO');

-- CreateEnum
CREATE TYPE "ScheduleSource" AS ENUM ('USER', 'SUGGESTED', 'EXPLORATION');

-- CreateEnum
CREATE TYPE "PostStatus" AS ENUM ('DRAFT', 'READY', 'SCHEDULED', 'PUBLISHING', 'PUBLISHED', 'PARTIALLY_PUBLISHED', 'FAILED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "TargetStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'PUBLISHING', 'PUBLISHED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "googleId" TEXT,
    "picture" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspaces" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'OWNER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "business_categories" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parentId" TEXT,
    "priors" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "business_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brands" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "website" TEXT,
    "categoryId" TEXT,
    "logoAssetId" TEXT,
    "palette" JSONB NOT NULL,
    "typography" JSONB NOT NULL,
    "voiceGuide" JSONB NOT NULL,
    "goals" JSONB,
    "targetPlatforms" "Platform"[],
    "timezone" TEXT NOT NULL DEFAULT 'America/New_York',
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "brands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "persona_layers" (
    "id" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "modifiers" JSONB NOT NULL,
    "status" "PersonaStatus" NOT NULL DEFAULT 'SUGGESTED',
    "source" TEXT NOT NULL DEFAULT 'ai',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "persona_layers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "social_accounts" (
    "id" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "externalId" TEXT NOT NULL,
    "handle" TEXT,
    "displayName" TEXT,
    "avatarUrl" TEXT,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT,
    "tokenSecret" TEXT,
    "expiresAt" TIMESTAMP(3),
    "scopes" TEXT[],
    "credentialId" TEXT,
    "platformMeta" JSONB,
    "status" "AccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "lastError" TEXT,
    "lastValidatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "social_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_credentials" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "brandId" TEXT,
    "platform" "Platform" NOT NULL,
    "mode" "CredentialMode" NOT NULL,
    "label" TEXT NOT NULL,
    "appId" TEXT,
    "appSecret" TEXT,
    "redirectUri" TEXT,
    "directToken" TEXT,
    "directTokenSecret" TEXT,
    "systemUserToken" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "grantedScopes" TEXT[],
    "requiredScopes" TEXT[],
    "capabilities" JSONB,
    "status" "CredentialStatus" NOT NULL DEFAULT 'PENDING',
    "lastValidatedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "rotatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credential_access_logs" (
    "id" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "context" JSONB,

    CONSTRAINT "credential_access_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assets" (
    "id" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "kind" "AssetKind" NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "bytes" INTEGER NOT NULL,
    "checksum" TEXT,
    "source" TEXT NOT NULL DEFAULT 'upload',
    "altText" TEXT,
    "tags" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "templates" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "archetype" TEXT NOT NULL,
    "kind" "TemplateKind" NOT NULL DEFAULT 'IMAGE',
    "workspaceId" TEXT,
    "slotSchema" JSONB NOT NULL,
    "layout" JSONB NOT NULL,
    "supportedRatios" "AspectRatio"[],
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" "TemplateStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "template_category_tags" (
    "templateId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "source" TEXT NOT NULL DEFAULT 'manual',

    CONSTRAINT "template_category_tags_pkey" PRIMARY KEY ("templateId","categoryId")
);

-- CreateTable
CREATE TABLE "trends" (
    "id" TEXT NOT NULL,
    "platform" "Platform",
    "kind" "TrendKind" NOT NULL,
    "externalRef" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "exampleUrls" TEXT[],
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "peakedAt" TIMESTAMP(3),
    "status" "TrendStatus" NOT NULL DEFAULT 'EMERGING',
    "velocity" DOUBLE PRECISION,
    "momentum" DOUBLE PRECISION,
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trends_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trend_signals" (
    "id" TEXT NOT NULL,
    "trendId" TEXT NOT NULL,
    "collectorId" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metrics" JSONB NOT NULL,

    CONSTRAINT "trend_signals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trend_category_scores" (
    "trendId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trend_category_scores_pkey" PRIMARY KEY ("trendId","categoryId")
);

-- CreateTable
CREATE TABLE "posts" (
    "id" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "templateId" TEXT,
    "templateVersion" INTEGER,
    "trendId" TEXT,
    "personaId" TEXT,
    "title" TEXT,
    "slotValues" JSONB,
    "baseCopy" TEXT,
    "status" "PostStatus" NOT NULL DEFAULT 'DRAFT',
    "mediaType" "MediaType" NOT NULL DEFAULT 'IMAGE',
    "scheduledAt" TIMESTAMP(3),
    "scheduledLocal" TEXT,
    "scheduledTz" TEXT,
    "scheduleSource" "ScheduleSource" NOT NULL DEFAULT 'USER',
    "scheduleSlot" TEXT,
    "variantGroupId" TEXT,
    "variantLabel" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "post_targets" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "socialAccountId" TEXT,
    "caption" TEXT,
    "renditionId" TEXT,
    "scheduledFor" TIMESTAMP(3),
    "status" "TargetStatus" NOT NULL DEFAULT 'DRAFT',
    "externalPostId" TEXT,
    "externalUrl" TEXT,
    "publishedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "post_targets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "renditions" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "mediaType" "MediaType" NOT NULL DEFAULT 'IMAGE',
    "aspectRatio" "AspectRatio" NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL DEFAULT 'image/png',
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "durationMs" INTEGER,
    "bytes" INTEGER NOT NULL,
    "renderedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rendererMeta" JSONB,

    CONSTRAINT "renditions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "short_links" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "postId" TEXT,
    "platform" "Platform",
    "destinationUrl" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "short_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "link_clicks" (
    "id" TEXT NOT NULL,
    "shortLinkId" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ipHash" TEXT,
    "userAgent" TEXT,
    "referrer" TEXT,
    "country" TEXT,
    "deviceType" TEXT,
    "isBot" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "link_clicks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "post_metrics" (
    "id" TEXT NOT NULL,
    "postTargetId" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL,
    "impressions" INTEGER,
    "reach" INTEGER,
    "likes" INTEGER,
    "comments" INTEGER,
    "shares" INTEGER,
    "saves" INTEGER,
    "videoViews" INTEGER,
    "profileVisits" INTEGER,
    "linkClicks" INTEGER,
    "raw" JSONB,

    CONSTRAINT "post_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_generations" (
    "id" TEXT NOT NULL,
    "brandId" TEXT,
    "postId" TEXT,
    "purpose" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT,
    "prompt" TEXT NOT NULL,
    "response" TEXT NOT NULL,
    "responseTimeMs" INTEGER,
    "promptTokens" INTEGER,
    "completionTokens" INTEGER,
    "estimatedCost" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_generations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_googleId_key" ON "users"("googleId");

-- CreateIndex
CREATE UNIQUE INDEX "workspaces_slug_key" ON "workspaces"("slug");

-- CreateIndex
CREATE INDEX "memberships_workspaceId_role_idx" ON "memberships"("workspaceId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_userId_workspaceId_key" ON "memberships"("userId", "workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "business_categories_slug_key" ON "business_categories"("slug");

-- CreateIndex
CREATE INDEX "business_categories_parentId_idx" ON "business_categories"("parentId");

-- CreateIndex
CREATE INDEX "brands_workspaceId_deletedAt_idx" ON "brands"("workspaceId", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "brands_workspaceId_slug_key" ON "brands"("workspaceId", "slug");

-- CreateIndex
CREATE INDEX "persona_layers_brandId_status_idx" ON "persona_layers"("brandId", "status");

-- CreateIndex
CREATE INDEX "social_accounts_status_expiresAt_idx" ON "social_accounts"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "social_accounts_credentialId_idx" ON "social_accounts"("credentialId");

-- CreateIndex
CREATE UNIQUE INDEX "social_accounts_brandId_platform_externalId_key" ON "social_accounts"("brandId", "platform", "externalId");

-- CreateIndex
CREATE INDEX "platform_credentials_workspaceId_platform_status_idx" ON "platform_credentials"("workspaceId", "platform", "status");

-- CreateIndex
CREATE INDEX "platform_credentials_status_tokenExpiresAt_idx" ON "platform_credentials"("status", "tokenExpiresAt");

-- CreateIndex
CREATE INDEX "platform_credentials_brandId_idx" ON "platform_credentials"("brandId");

-- CreateIndex
CREATE INDEX "credential_access_logs_credentialId_occurredAt_idx" ON "credential_access_logs"("credentialId", "occurredAt");

-- CreateIndex
CREATE INDEX "assets_brandId_kind_idx" ON "assets"("brandId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "templates_slug_key" ON "templates"("slug");

-- CreateIndex
CREATE INDEX "templates_status_archetype_idx" ON "templates"("status", "archetype");

-- CreateIndex
CREATE INDEX "templates_workspaceId_idx" ON "templates"("workspaceId");

-- CreateIndex
CREATE INDEX "template_category_tags_categoryId_weight_idx" ON "template_category_tags"("categoryId", "weight");

-- CreateIndex
CREATE INDEX "trends_status_momentum_idx" ON "trends"("status", "momentum");

-- CreateIndex
CREATE UNIQUE INDEX "trends_platform_kind_externalRef_key" ON "trends"("platform", "kind", "externalRef");

-- CreateIndex
CREATE INDEX "trend_signals_trendId_observedAt_idx" ON "trend_signals"("trendId", "observedAt");

-- CreateIndex
CREATE INDEX "trend_category_scores_categoryId_score_idx" ON "trend_category_scores"("categoryId", "score");

-- CreateIndex
CREATE INDEX "posts_brandId_status_createdAt_idx" ON "posts"("brandId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "posts_brandId_deletedAt_idx" ON "posts"("brandId", "deletedAt");

-- CreateIndex
CREATE INDEX "posts_brandId_scheduleSlot_idx" ON "posts"("brandId", "scheduleSlot");

-- CreateIndex
CREATE INDEX "posts_variantGroupId_idx" ON "posts"("variantGroupId");

-- CreateIndex
CREATE INDEX "post_targets_status_scheduledFor_idx" ON "post_targets"("status", "scheduledFor");

-- CreateIndex
CREATE INDEX "post_targets_publishedAt_idx" ON "post_targets"("publishedAt");

-- CreateIndex
CREATE UNIQUE INDEX "post_targets_postId_platform_key" ON "post_targets"("postId", "platform");

-- CreateIndex
CREATE INDEX "renditions_postId_aspectRatio_idx" ON "renditions"("postId", "aspectRatio");

-- CreateIndex
CREATE UNIQUE INDEX "short_links_slug_key" ON "short_links"("slug");

-- CreateIndex
CREATE INDEX "short_links_brandId_createdAt_idx" ON "short_links"("brandId", "createdAt");

-- CreateIndex
CREATE INDEX "short_links_postId_idx" ON "short_links"("postId");

-- CreateIndex
CREATE INDEX "link_clicks_shortLinkId_occurredAt_idx" ON "link_clicks"("shortLinkId", "occurredAt");

-- CreateIndex
CREATE INDEX "link_clicks_shortLinkId_isBot_occurredAt_idx" ON "link_clicks"("shortLinkId", "isBot", "occurredAt");

-- CreateIndex
CREATE INDEX "post_metrics_postTargetId_capturedAt_idx" ON "post_metrics"("postTargetId", "capturedAt");

-- CreateIndex
CREATE UNIQUE INDEX "post_metrics_postTargetId_capturedAt_key" ON "post_metrics"("postTargetId", "capturedAt");

-- CreateIndex
CREATE INDEX "ai_generations_brandId_createdAt_idx" ON "ai_generations"("brandId", "createdAt");

-- CreateIndex
CREATE INDEX "ai_generations_postId_idx" ON "ai_generations"("postId");

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_categories" ADD CONSTRAINT "business_categories_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "business_categories"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "brands" ADD CONSTRAINT "brands_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brands" ADD CONSTRAINT "brands_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "business_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brands" ADD CONSTRAINT "brands_logoAssetId_fkey" FOREIGN KEY ("logoAssetId") REFERENCES "assets"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "persona_layers" ADD CONSTRAINT "persona_layers_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_accounts" ADD CONSTRAINT "social_accounts_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_accounts" ADD CONSTRAINT "social_accounts_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "platform_credentials"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_credentials" ADD CONSTRAINT "platform_credentials_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_credentials" ADD CONSTRAINT "platform_credentials_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credential_access_logs" ADD CONSTRAINT "credential_access_logs_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "platform_credentials"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "templates" ADD CONSTRAINT "templates_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_category_tags" ADD CONSTRAINT "template_category_tags_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_category_tags" ADD CONSTRAINT "template_category_tags_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "business_categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trend_signals" ADD CONSTRAINT "trend_signals_trendId_fkey" FOREIGN KEY ("trendId") REFERENCES "trends"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trend_category_scores" ADD CONSTRAINT "trend_category_scores_trendId_fkey" FOREIGN KEY ("trendId") REFERENCES "trends"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trend_category_scores" ADD CONSTRAINT "trend_category_scores_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "business_categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "posts" ADD CONSTRAINT "posts_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "posts" ADD CONSTRAINT "posts_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "posts" ADD CONSTRAINT "posts_trendId_fkey" FOREIGN KEY ("trendId") REFERENCES "trends"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "posts" ADD CONSTRAINT "posts_personaId_fkey" FOREIGN KEY ("personaId") REFERENCES "persona_layers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_targets" ADD CONSTRAINT "post_targets_postId_fkey" FOREIGN KEY ("postId") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_targets" ADD CONSTRAINT "post_targets_socialAccountId_fkey" FOREIGN KEY ("socialAccountId") REFERENCES "social_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_targets" ADD CONSTRAINT "post_targets_renditionId_fkey" FOREIGN KEY ("renditionId") REFERENCES "renditions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "renditions" ADD CONSTRAINT "renditions_postId_fkey" FOREIGN KEY ("postId") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "short_links" ADD CONSTRAINT "short_links_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "short_links" ADD CONSTRAINT "short_links_postId_fkey" FOREIGN KEY ("postId") REFERENCES "posts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "link_clicks" ADD CONSTRAINT "link_clicks_shortLinkId_fkey" FOREIGN KEY ("shortLinkId") REFERENCES "short_links"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_metrics" ADD CONSTRAINT "post_metrics_postTargetId_fkey" FOREIGN KEY ("postTargetId") REFERENCES "post_targets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_generations" ADD CONSTRAINT "ai_generations_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_generations" ADD CONSTRAINT "ai_generations_postId_fkey" FOREIGN KEY ("postId") REFERENCES "posts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
