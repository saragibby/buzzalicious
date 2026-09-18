import { ApiError, apiFetch, getBackendUrl } from './api';

/**
 * Typed client for the identity and brand endpoints.
 *
 * Types are hand-written mirrors of the API's response shapes rather than imports from
 * the backend: the two workspaces build separately, and a shared type would couple the
 * SPA's build to the server's `tsconfig`. The cost is that a server change can drift from
 * here — which is why the shapes are deliberately narrow projections, matching the
 * explicit `toBrandView` on the other side rather than the Prisma model.
 */

export type Role = 'OWNER' | 'ADMIN' | 'MEMBER';

export type Platform = 'INSTAGRAM' | 'FACEBOOK' | 'THREADS' | 'X';

export const PLATFORMS: Platform[] = ['INSTAGRAM', 'FACEBOOK', 'THREADS', 'X'];

export type AssetKind = 'LOGO' | 'PHOTO' | 'VIDEO' | 'FONT' | 'RENDITION';

export interface WorkspaceSummary {
  id: string;
  name: string;
  slug: string;
  role: Role;
}

export interface BrandPalette {
  primary: string;
  secondary: string;
  accent: string;
  neutral: string;
  background: string;
  text: string;
}

export interface BrandTypography {
  headingFamily: string;
  bodyFamily: string;
  headingWeight: number;
  bodyWeight: number;
  scale?: number;
}

export interface BrandVoiceGuide {
  summary: string;
  toneAttributes: string[];
  doSay: string[];
  dontSay: string[];
  vocabulary: string[];
  sampleCopy: string[];
  readingLevel: 'simple' | 'standard' | 'expert';
  emojiPolicy: 'none' | 'sparing' | 'liberal';
  bannedOpeners: string[];
}

export interface Brand {
  id: string;
  workspaceId: string;
  name: string;
  slug: string;
  website: string | null;
  categoryId: string | null;
  logoAssetId: string | null;
  palette: BrandPalette;
  typography: BrandTypography;
  voiceGuide: BrandVoiceGuide;
  goals: unknown;
  targetPlatforms: Platform[];
  timezone: string;
  createdAt: string;
  updatedAt: string;
}

export interface CategoryNode {
  id: string;
  slug: string;
  name: string;
  children: CategoryNode[];
}

export interface CategoryMatch {
  id: string;
  slug: string;
  name: string;
  parentName: string | null;
}

export interface FontOption {
  family: string;
  weights: number[];
  role: 'heading' | 'body' | 'both';
  description?: string;
}

export interface AssetView {
  id: string;
  kind: AssetKind;
  mimeType: string;
  width: number | null;
  height: number | null;
  bytes: number;
  altText: string | null;
  tags: string[];
  createdAt: string;
  url: string;
  thumbnailUrl: string | null;
}

export async function fetchWorkspaces(): Promise<WorkspaceSummary[]> {
  const { workspaces } = await apiFetch<{ workspaces: WorkspaceSummary[] }>('/api/workspaces');
  return workspaces;
}

export async function fetchBrands(workspaceId: string): Promise<Brand[]> {
  const { brands } = await apiFetch<{ brands: Brand[] }>(`/api/workspaces/${workspaceId}/brands`);
  return brands;
}

export async function fetchBrand(brandId: string): Promise<Brand> {
  const { brand } = await apiFetch<{ brand: Brand }>(`/api/brands/${brandId}`);
  return brand;
}

export async function updateBrand(brandId: string, patch: Partial<Brand>): Promise<Brand> {
  const { brand } = await apiFetch<{ brand: Brand }>(`/api/brands/${brandId}`, {
    method: 'PATCH',
    body: patch,
  });
  return brand;
}

export async function fetchCategoryTree(): Promise<CategoryNode[]> {
  const { categories } = await apiFetch<{ categories: CategoryNode[] }>('/api/brands/categories');
  return categories;
}

export async function searchCategories(query: string): Promise<CategoryMatch[]> {
  const { categories } = await apiFetch<{ categories: CategoryMatch[] }>(
    `/api/brands/categories/search?q=${encodeURIComponent(query)}`,
  );
  return categories;
}

export async function fetchFonts(): Promise<FontOption[]> {
  const { fonts } = await apiFetch<{ fonts: FontOption[] }>('/api/brands/fonts');
  return fonts;
}

export async function fetchAssets(brandId: string, kind?: AssetKind): Promise<AssetView[]> {
  const query = kind ? `?kind=${kind}` : '';
  const { assets } = await apiFetch<{ assets: AssetView[] }>(
    `/api/brands/${brandId}/assets${query}`,
  );
  return assets;
}

export async function deleteAsset(brandId: string, assetId: string): Promise<void> {
  await apiFetch(`/api/brands/${brandId}/assets/${assetId}`, { method: 'DELETE' });
}

export async function setBrandLogo(brandId: string, assetId: string | null): Promise<Brand> {
  const { brand } = await apiFetch<{ brand: Brand }>(`/api/brands/${brandId}/logo`, {
    method: 'PUT',
    body: { assetId },
  });
  return brand;
}

export interface VoiceGuideDraft {
  draft: BrandVoiceGuide;
  generated: true;
  model: string;
}

export async function draftVoiceGuide(
  brandId: string,
  input: { audience?: string; notes?: string },
): Promise<VoiceGuideDraft> {
  return apiFetch<VoiceGuideDraft>(`/api/brands/${brandId}/voice-guide/draft`, {
    method: 'POST',
    body: input,
  });
}

/**
 * Multipart uploads bypass `apiFetch`.
 *
 * Setting `Content-Type` manually on a `FormData` body omits the multipart boundary the
 * browser would otherwise generate, and the server then cannot parse the request at all.
 * `apiFetch` always sets a JSON content type when there is a body, so these two go direct
 * — with `credentials: 'include'` repeated, which is the one thing `apiFetch` exists to
 * centralise, so it is called out here rather than left to be noticed.
 */
async function postFile<T>(path: string, file: File, fields: Record<string, string> = {}) {
  const form = new FormData();
  form.append('file', file);
  for (const [key, value] of Object.entries(fields)) form.append(key, value);

  const response = await fetch(`${getBackendUrl()}${path}`, {
    method: 'POST',
    credentials: 'include',
    body: form,
  });

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const error = (payload as { error?: { code: string; message: string } } | null)?.error;
    throw new ApiError(
      response.status,
      error?.code ?? 'UNKNOWN',
      error?.message ?? response.statusText,
    );
  }

  return payload as T;
}

export interface UploadedAsset {
  asset: { id: string };
  url: string;
  thumbnailUrl: string | null;
}

export async function uploadAsset(
  brandId: string,
  file: File,
  options: { kind?: AssetKind; altText?: string; tags?: string[] } = {},
): Promise<UploadedAsset> {
  return postFile<UploadedAsset>(`/api/brands/${brandId}/assets`, file, {
    ...(options.kind ? { kind: options.kind } : {}),
    ...(options.altText ? { altText: options.altText } : {}),
    ...(options.tags?.length ? { tags: options.tags.join(',') } : {}),
  });
}

export async function suggestPalette(brandId: string, file: File): Promise<BrandPalette> {
  const { palette } = await postFile<{ palette: BrandPalette }>(
    `/api/brands/${brandId}/palette-suggestion`,
    file,
  );
  return palette;
}
