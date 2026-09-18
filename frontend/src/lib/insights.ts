import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { apiFetch } from './api';

/**
 * Typed client for the W7 insight endpoints.
 *
 * The types mirror the API's response shapes, not the Prisma models. Every metric is
 * `number | null` all the way through, and that is load-bearing rather than defensive:
 * `null` means the platform did not report it, and the one thing this layer must never do
 * is default it to `0` on the way past. A `?? 0` anywhere below turns "we did not measure
 * this" into "this post earned nothing", which is a claim the user cannot audit.
 */

export type OutcomeComponent = 'click' | 'save' | 'share' | 'engage';

export interface OutcomeScore {
  score: number | null;
  components: OutcomeComponent[];
  coverage: number;
  weightedSum: number | null;
}

export interface TargetOutcome {
  postTargetId: string;
  postId: string;
  postTitle: string | null;
  platform: string;
  publishedAt: string | null;
  templateId: string | null;
  templateName: string | null;
  trendId: string | null;
  linkClicks: number | null;
  impressions: number | null;
  reach: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  videoViews: number | null;
  capturedAt: string | null;
  outcome: OutcomeScore;
}

export interface ClickGroup {
  key: string;
  clicks: number;
  measured: number;
  unmeasured: number;
  botClicks: number;
}

export interface OutcomeGroup {
  key: string;
  scored: number;
  unscored: number;
  meanScore: number | null;
  sharedComponents: OutcomeComponent[];
  clicks: ClickGroup | null;
}

export interface Headline {
  kind: 'template' | 'platform';
  key: string;
  meanScore: number;
  scored: number;
  runnerUpScore: number;
}

export interface InsightSummary {
  window: { from: string; to: string };
  headline: Headline | null;
  byPlatform: OutcomeGroup[];
  byTemplate: OutcomeGroup[];
  targets: TargetOutcome[];
}

export interface TimelinePoint {
  capturedAt: string;
  hoursSincePublish: number | null;
  linkClicks: number | null;
  impressions: number | null;
  reach: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  videoViews: number | null;
}

export const insightsQueryKey = (brandId: string, days: number) =>
  ['insights', brandId, days] as const;

export function useInsights(
  brandId: string | null,
  days = 30,
): UseQueryResult<InsightSummary, unknown> {
  return useQuery({
    queryKey: insightsQueryKey(brandId ?? 'none', days),
    enabled: Boolean(brandId),
    queryFn: () => apiFetch<InsightSummary>(`/api/brands/${brandId}/insights?days=${days}`),
  });
}

export function useMetricTimeline(
  brandId: string | null,
  postTargetId: string | null,
): UseQueryResult<{ points: TimelinePoint[] }, unknown> {
  return useQuery({
    queryKey: ['insights', brandId, 'timeline', postTargetId] as const,
    enabled: Boolean(brandId && postTargetId),
    queryFn: () =>
      apiFetch<{ points: TimelinePoint[] }>(
        `/api/brands/${brandId}/insights/targets/${postTargetId}/timeline`,
      ),
  });
}

/**
 * Render a metric, or say it is unavailable.
 *
 * The single place the null-versus-zero rule becomes pixels. Returning a dash rather than
 * `0` is the whole reason every type above stays nullable — see
 * `docs/06-outcome-and-feedback-loop.md`.
 */
export function formatMetric(value: number | null): string {
  if (value === null) return '—';
  return value.toLocaleString();
}
