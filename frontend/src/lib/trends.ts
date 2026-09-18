import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { apiFetch } from './api';

/**
 * Typed client for the W9 trend endpoints.
 *
 * The types mirror the API's response shapes rather than the Prisma models, so a change to
 * the database schema that does not change the API does not ripple into the UI.
 */

export type TrendStatus = 'EMERGING' | 'PEAKING' | 'DECLINING' | 'STALE';
export type TrendKind = 'HASHTAG' | 'SOUND' | 'FORMAT' | 'TOPIC';
export type MappingReviewStatus = 'OK' | 'NEEDS_REVIEW' | 'CONFIRMED' | 'REJECTED';

export interface PairedTemplate {
  id: string;
  slug: string;
  name: string;
  archetype: string;
  fit: number;
  viaCategorySlug: string;
}

export interface FeedItem {
  trendId: string;
  title: string;
  description: string | null;
  kind: TrendKind;
  platform: string | null;
  status: TrendStatus;
  momentum: number;
  velocity: number;
  lastSeenAt: string;
  exampleUrls: string[];
  feedScore: number;
  categoryScore: number;
  platformFit: number;
  freshness: number;
  whyThisFitsYou: string;
  suggestedAngle: string;
  hook?: string;
  pairedTemplates: PairedTemplate[];
}

export interface BrandFeed {
  brand: {
    id: string;
    name: string;
    categorySlug: string | null;
    categoryName: string | null;
    targetPlatforms: string[];
  };
  needsCategory: boolean;
  items: FeedItem[];
}

export interface SuggestedAngle {
  categorySlug: string;
  angle: string;
  hook?: string;
}

export interface TrendCuration {
  curatedBy?: string;
  curatedAt?: string;
  rationale?: string;
  angles: SuggestedAngle[];
  defaultAngle?: string;
}

export interface TrendCategoryMapping {
  method: 'rules' | 'llm' | 'manual';
  confidence: number;
  reviewStatus: MappingReviewStatus;
  mappedAt: string;
  inputHash: string;
  evidence: { categorySlug: string; score: number; reason: string }[];
  reviewedBy?: string;
  reviewedAt?: string;
}

export interface AdminTrend {
  id: string;
  title: string;
  description: string | null;
  kind: TrendKind;
  platform: string | null;
  externalRef: string | null;
  exampleUrls: string[];
  status: TrendStatus;
  velocity: number | null;
  momentum: number | null;
  firstSeenAt: string;
  lastSeenAt: string;
  peakedAt: string | null;
  signalCount: number;
  latestObservedAt: string | null;
  categoryScoreCount: number;
  curation: TrendCuration | null;
  mapping: TrendCategoryMapping | null;
  hasAngle: boolean;
  needsReview: boolean;
}

export interface ObservationInput {
  platform: string | null;
  kind: TrendKind;
  externalRef: string | null;
  title: string;
  description?: string | null;
  exampleUrls: string[];
  observedAt: string;
  metrics: Record<string, number>;
  sourceNote?: string;
}

export const trendKeys = {
  brands: ['trends', 'brands'] as const,
  feed: (brandId: string) => ['trends', 'feed', brandId] as const,
  adminList: (params: { search?: string; needsReview?: boolean }) =>
    ['trends', 'admin', params] as const,
};

export interface FeedBrand {
  id: string;
  name: string;
  categorySlug: string | null;
  categoryName: string | null;
}

export function useFeedBrands(): UseQueryResult<{ brands: FeedBrand[] }> {
  return useQuery({
    queryKey: trendKeys.brands,
    queryFn: () => apiFetch<{ brands: FeedBrand[] }>('/api/trends/brands'),
  });
}

export function useBrandFeed(brandId: string | null): UseQueryResult<BrandFeed> {
  return useQuery({
    queryKey: trendKeys.feed(brandId ?? ''),
    queryFn: () => apiFetch<BrandFeed>(`/api/trends/brands/${brandId!}/feed`),
    enabled: Boolean(brandId),
  });
}

export function useAdminTrends(params: {
  search?: string;
  needsReview?: boolean;
}): UseQueryResult<{ trends: AdminTrend[] }> {
  const query = new URLSearchParams();
  if (params.search) query.set('search', params.search);
  if (params.needsReview) query.set('needsReview', 'true');

  return useQuery({
    queryKey: trendKeys.adminList(params),
    queryFn: () => apiFetch<{ trends: AdminTrend[] }>(`/api/admin/trends?${query.toString()}`),
    retry: false,
  });
}

/**
 * Invalidates every trend query after a curation write.
 *
 * Broad on purpose: recording an observation rescores and re-maps the trend, which can
 * change its status and therefore which brand feeds contain it. Invalidating only the one
 * row would leave a feed showing a trend that no longer qualifies.
 */
function useInvalidateTrends() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ['trends'] });
}

export function useRecordObservation() {
  const invalidate = useInvalidateTrends();

  return useMutation({
    mutationFn: (input: ObservationInput) =>
      apiFetch<AdminTrend>('/api/admin/trends/observations', { method: 'POST', body: input }),
    onSuccess: invalidate,
  });
}

export function useSaveCuration() {
  const invalidate = useInvalidateTrends();

  return useMutation({
    mutationFn: ({
      trendId,
      ...body
    }: {
      trendId: string;
      angles: SuggestedAngle[];
      defaultAngle?: string;
      rationale?: string;
    }) => apiFetch<AdminTrend>(`/api/admin/trends/${trendId}/curation`, { method: 'PUT', body }),
    onSuccess: invalidate,
  });
}

export function useReviewMapping() {
  const invalidate = useInvalidateTrends();

  return useMutation({
    mutationFn: ({
      trendId,
      reviewStatus,
    }: {
      trendId: string;
      reviewStatus: MappingReviewStatus;
    }) =>
      apiFetch<AdminTrend>(`/api/admin/trends/${trendId}/mapping/review`, {
        method: 'POST',
        body: { reviewStatus },
      }),
    onSuccess: invalidate,
  });
}

export interface RescoreResponse {
  dryRun: boolean;
  total: number;
  changed: number;
  results: {
    trendId: string;
    title: string;
    changed: boolean;
    before: { velocity: number | null; momentum: number | null; status: string };
    after: { velocity: number; momentum: number; status: string; usableSignals: number };
  }[];
}

export function useRescore() {
  const invalidate = useInvalidateTrends();

  return useMutation({
    mutationFn: (dryRun: boolean) =>
      apiFetch<RescoreResponse>('/api/admin/trends/rescore', {
        method: 'POST',
        body: { dryRun },
      }),
    // A dry run changes nothing, so invalidating would discard good cache for no reason.
    onSuccess: (result) => (result.dryRun ? undefined : invalidate()),
  });
}
