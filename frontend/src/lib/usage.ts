import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { apiFetch } from './api';

/**
 * Typed client for the W10 usage endpoints.
 *
 * Money arrives as a **string**, and stays one all the way to the DOM. Parsing it into a
 * JS number to format it reintroduces exactly the float that the backend went to some
 * trouble to keep out of the arithmetic.
 */

export type UsageMetric =
  'AI_TOKENS' | 'POST_PUBLISHED' | 'RENDITION_RENDERED' | 'TREND_REFRESH' | 'CONNECTED_ACCOUNT';

export interface UsageMetricTotal {
  metric: UsageMetric;
  quantity: number;
  providerCostUsd: string;
  eventCount: number;
}

export interface WorkspaceUsage {
  workspaceId: string;
  workspaceName: string;
  workspaceSlug: string;
  isPlatformWorkspace: boolean;
  periodStart: string;
  periodEnd: string;
  metrics: UsageMetricTotal[];
  aiSpendUsd: string;
  aiCeilingUsd: string;
  exhausted: boolean;
  aiUtilization: number;
}

export interface UsagePeriod {
  period: string;
  periodStart: string;
  periodEnd: string;
  workspaces: WorkspaceUsage[];
  totals: UsageMetricTotal[];
  exhausted: {
    workspaceId: string;
    workspaceName: string;
    aiSpendUsd: string;
    aiCeilingUsd: string;
    isPlatformWorkspace: boolean;
  }[];
}

export function useUsagePeriod(period?: string): UseQueryResult<UsagePeriod> {
  return useQuery({
    queryKey: ['admin', 'usage', period ?? 'current'],
    queryFn: () => apiFetch<UsagePeriod>(`/api/admin/usage${period ? `?period=${period}` : ''}`),
  });
}

/** `2.5` → `$2.50`. Two decimal places for display; the full precision stays in the string. */
export function formatUsd(value: string): string {
  const [whole = '0', fraction = ''] = value.split('.');
  const cents = `${fraction}00`.slice(0, 2);
  return `$${whole}.${cents}`;
}

/** `1234567` → `1,234,567`. */
export function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}
