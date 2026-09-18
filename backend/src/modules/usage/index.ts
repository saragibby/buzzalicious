/**
 * The usage meter. See ./README.md and docs/adr/0011-usage-metering-spine.md.
 *
 * Other modules import from here, never from a file inside — the surface is small on
 * purpose, and the raw rollup writer is not part of it.
 */
export {
  emitUsage,
  type EmitUsageInput,
  type EmitUsageResult,
  type UsageWriter,
} from './usage.service';
export {
  AI_METRICS,
  assertAiBudgetAvailable,
  getAiBudgetStatus,
  resolveAiCeilingUsd,
  type AiBudgetStatus,
  type BudgetReader,
} from './budget';
export { BudgetExceededError, isBudgetExceededError } from './usage.errors';
export {
  computePeriodFromEvents,
  rebuildAllPeriods,
  rebuildWorkspacePeriod,
  type RebuiltRollup,
} from './rollup';
export { parsePeriodKey, periodEndFor, periodKeyFor, periodStartFor } from './period';
export { getUsagePeriodSummary, getWorkspaceUsage } from './usage.read';
export type { UsageMetricTotal, UsagePeriodSummary, WorkspaceUsageSummary } from './usage.read';
export { assertPlatformAdmin, isPlatformAdmin } from './usage.access';
export { UsageMetadataSchema, PeriodKeySchema, type UsageMetadata } from './usage.schemas';
export {
  PLATFORM_WORKSPACE_ID,
  PLATFORM_WORKSPACE_NAME,
  PLATFORM_WORKSPACE_SLUG,
  getPlatformWorkspaceId,
} from './platform-workspace';
