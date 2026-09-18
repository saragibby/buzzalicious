-- Which bot filter fired, so a layer can be retuned retroactively against real traffic.
-- Nullable: null means no filter flagged this click.
ALTER TABLE "link_clicks" ADD COLUMN     "botReason" TEXT;

-- One short link per (post, platform). Get-or-create genuinely races: pg-boss is
-- at-least-once, and the publish retry path and the sweep can both run the same target.
-- Two rows for one (post, platform) splits that post's click stream and under-reports.
-- Postgres treats NULLs as distinct here, so unlimited postId IS NULL links remain legal.
CREATE UNIQUE INDEX "short_links_postId_platform_key" ON "short_links"("postId", "platform");
