import type { Db } from '../../platform/db';
import { PlatformWorkspaceMissingError } from './usage.errors';

/**
 * The reserved platform workspace.
 *
 * Trend classification is platform-global by ADR-0010: one LLM call per trend, cached and
 * reused by every tenant. So the most financially exposed call site in the product has no
 * workspace to charge, and charging one client for an answer every client reads would be
 * wrong.
 *
 * `UsageEvent.workspaceId` stays required — the workspace is the billing entity, and a
 * nullable tenant column on a billing ledger is how "unattributed" quietly becomes a
 * category. Platform-owned spend gets a workspace of its own instead: no memberships, no
 * brands, so it appears in nobody's workspace list, and its ceiling is a real fuse over
 * shared work rather than an exemption from one.
 *
 * It is created by the migration, not only by the development seed, because the fuse has to
 * work on a production database and `migrate deploy` is the only thing that runs there.
 */

export const PLATFORM_WORKSPACE_SLUG = 'platform';

/**
 * Fixed id, matching the `INSERT` in `0002_usage_metering` and
 * `seedId('workspace', 'platform')`. A test asserts all three agree — a drift here would
 * silently create a second platform workspace and split the meter in half.
 */
export const PLATFORM_WORKSPACE_ID = '1bf69650-f06e-5901-8d12-f30ef2d3d038';

export const PLATFORM_WORKSPACE_NAME = 'Buzzalicious Platform';

let cached: string | undefined;

/**
 * Resolve the platform workspace id, verifying it exists.
 *
 * Looked up by slug rather than trusting the constant, so a database restored from before
 * this migration fails loudly at the call site instead of writing events that violate a
 * foreign key halfway through a curation run.
 */
export async function getPlatformWorkspaceId(db: Db): Promise<string> {
  if (cached) return cached;

  const workspace = await db.workspace.findUnique({
    where: { slug: PLATFORM_WORKSPACE_SLUG },
    select: { id: true },
  });

  if (!workspace) {
    throw new PlatformWorkspaceMissingError(
      `The reserved "${PLATFORM_WORKSPACE_SLUG}" workspace is missing. It is created by ` +
        `migration 0002_usage_metering; run "prisma migrate deploy". Platform-global AI ` +
        `spend (trend classification) has nowhere to be metered without it.`,
    );
  }

  cached = workspace.id;
  return cached;
}

/** Test-only. Drops the memoized id. */
export function resetPlatformWorkspaceCacheForTests(): void {
  cached = undefined;
}
