import { apiFetch, apiFetchRaw } from './api';
import type { LinkPreview } from './captionCount';
import type { Platform } from './brandApi';

/**
 * Typed client for the composer: templates, drafts, preview and export.
 *
 * As with `trends.ts`, the types mirror the API's response shapes rather than the Prisma
 * models, so a schema change that does not change the API does not ripple into the UI.
 */

/**
 * The placeholder W7 swaps for a tracked short link at publish time.
 *
 * Must match `LINK_MARKER` in `backend/src/modules/post/post.schemas.ts` exactly. A UI
 * looking for `{{link}}` against a backend emitting `{link}` fails silently, and stays
 * invisible until nobody's clicks are attributed.
 */
export const LINK_MARKER = '{{link}}';

export type AspectRatio = 'SQUARE_1_1' | 'PORTRAIT_4_5' | 'STORY_9_16' | 'LANDSCAPE_16_9';

export const ASPECT_RATIOS: AspectRatio[] = [
  'SQUARE_1_1',
  'PORTRAIT_4_5',
  'STORY_9_16',
  'LANDSCAPE_16_9',
];

/** Human labels and proportions, so a ratio switcher can size its own previews. */
export const RATIO_META: Record<AspectRatio, { label: string; width: number; height: number }> = {
  SQUARE_1_1: { label: 'Square', width: 1, height: 1 },
  PORTRAIT_4_5: { label: 'Portrait', width: 4, height: 5 },
  STORY_9_16: { label: 'Story', width: 9, height: 16 },
  LANDSCAPE_16_9: { label: 'Landscape', width: 16, height: 9 },
};

export interface RankedTemplate {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  archetype: string;
  kind: string;
  supportedRatios: AspectRatio[];
  version: number;
  score: number;
  /** Non-null when the template was matched through the brand's category tree. */
  matchedCategoryId: string | null;
  /** True when the match came from an ancestor category rather than the brand's own. */
  inherited: boolean;
}

export interface TextSlot {
  type: 'text';
  label?: string;
  maxLength: number;
  minLength?: number;
  multiline?: boolean;
  aiHint?: string;
  default?: string;
}

export interface ImageSlot {
  type: 'image';
  label?: string;
  minWidth?: number;
  minHeight?: number;
  aspectHint?: string;
  aiHint?: string;
}

export type Slot = TextSlot | ImageSlot;

export interface TemplateDetail {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  archetype: string;
  kind: string;
  version: number;
  supportedRatios: AspectRatio[];
  slotSchema: Record<string, Slot>;
  canvas: Record<string, unknown>;
}

export type SlotValues = Record<string, string>;

export interface DraftTarget {
  platform: Platform;
  /** `null` means "inherit the base caption" — not the same as an empty string. */
  caption: string | null;
}

export interface Draft {
  id: string;
  brandId: string;
  title: string | null;
  templateId: string | null;
  templateSlug: string | null;
  templateName: string | null;
  templateVersion: number | null;
  slotValues: SlotValues;
  baseCopy: string | null;
  status: string;
  targets: DraftTarget[];
  updatedAt: string;
  createdAt: string;
}

export interface Readiness {
  ready: boolean;
  issues: { slot: string; message: string }[];
}

export interface PreviewResult {
  svg: string;
  width: number;
  height: number;
  /** Slots whose text did not fit. Reported, never thrown — the user is mid-sentence. */
  overflows: { slot: string; message: string }[];
  fittedDown: string[];
}

export interface PlatformSpec {
  platform: Platform;
  label: string;
  captionMaxLength: number;
  captionLimitVerified: boolean;
  captionCountUnit: 'codepoints' | 'x-weighted' | 'utf8-bytes';
  supportedRatios: AspectRatio[];
  feedRatios: AspectRatio[];
  mediaRequired: boolean;
  hashtagLimit?: number;
  maxLinks?: number;
  linkBehavior: 'inline' | 'bio-only' | 'first-comment';
  linkNote?: string;
}

// --- Query keys -------------------------------------------------------------

export const templatesQueryKey = (filters: Record<string, string | undefined>) =>
  ['templates', filters] as const;

export const templateQueryKey = (slug: string) => ['templates', slug] as const;

export const draftsQueryKey = (brandId: string) => ['brands', brandId, 'posts'] as const;

export const draftQueryKey = (brandId: string, postId: string) =>
  ['brands', brandId, 'posts', postId] as const;

export const platformSpecsQueryKey = ['platforms'] as const;

// --- Requests ---------------------------------------------------------------

export interface TemplateFilters {
  categoryId?: string;
  archetype?: string;
  kind?: string;
  /** Comma-joined platform names; the API turns these into a ratio filter. */
  platform?: string;
  limit?: number;
}

export async function fetchTemplates(filters: TemplateFilters = {}): Promise<RankedTemplate[]> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }

  const query = params.toString();
  const { templates } = await apiFetch<{ templates: RankedTemplate[] }>(
    `/api/templates${query ? `?${query}` : ''}`,
  );
  return templates;
}

export async function fetchTemplate(slug: string): Promise<TemplateDetail> {
  const { template } = await apiFetch<{ template: TemplateDetail }>(`/api/templates/${slug}`);
  return template;
}

export async function fetchPlatformSpecs(): Promise<{
  platforms: PlatformSpec[];
  linkPreview: LinkPreview | null;
}> {
  const body = await apiFetch<{ platforms: PlatformSpec[]; linkPreview?: LinkPreview }>(
    '/api/platforms',
  );
  // `linkPreview` is optional on the wire so a browser running against an older API keeps
  // counting rather than crashing — it just counts without the link, which is the old
  // behaviour rather than a wrong number dressed up as a right one.
  return { platforms: body.platforms, linkPreview: body.linkPreview ?? null };
}

export async function renderPreview(
  slug: string,
  body: { brandId: string; aspectRatio: AspectRatio; slotValues: SlotValues },
): Promise<PreviewResult> {
  return apiFetch<PreviewResult>(`/api/templates/${slug}/preview`, { method: 'POST', body });
}

export async function fetchDrafts(brandId: string): Promise<Draft[]> {
  const { drafts } = await apiFetch<{ drafts: Draft[] }>(`/api/brands/${brandId}/posts`);
  return drafts;
}

export async function fetchDraft(
  brandId: string,
  postId: string,
): Promise<{ draft: Draft; readiness: Readiness }> {
  return apiFetch(`/api/brands/${brandId}/posts/${postId}`);
}

export async function createDraft(
  brandId: string,
  body: { templateSlug: string; title?: string; slotValues?: SlotValues },
): Promise<Draft> {
  const { draft } = await apiFetch<{ draft: Draft }>(`/api/brands/${brandId}/posts`, {
    method: 'POST',
    body,
  });
  return draft;
}

export interface DraftPatch {
  title?: string | null;
  slotValues?: SlotValues;
  baseCopy?: string | null;
  captionOverrides?: Partial<Record<Platform, string | null>>;
  platforms?: Platform[];
}

export async function updateDraft(
  brandId: string,
  postId: string,
  patch: DraftPatch,
): Promise<{ draft: Draft; readiness: Readiness }> {
  return apiFetch(`/api/brands/${brandId}/posts/${postId}`, { method: 'PATCH', body: patch });
}

export async function deleteDraft(brandId: string, postId: string): Promise<void> {
  await apiFetch(`/api/brands/${brandId}/posts/${postId}`, { method: 'DELETE' });
}

export interface GeneratedCaption {
  caption: string;
  platform: Platform;
  model: string;
  generated: true;
}

export async function generateCaption(
  brandId: string,
  postId: string,
  body: { notes?: string; platform?: Platform; includeLinkMarker?: boolean },
): Promise<GeneratedCaption> {
  return apiFetch(`/api/brands/${brandId}/posts/${postId}/caption`, { method: 'POST', body });
}

/**
 * Download the export bundle.
 *
 * Not routed through `apiFetch`: the response is a zip, and `apiFetch` calls
 * `response.json()` on every success, which would throw on binary and lose the download.
 * The error path still has to parse JSON, because a failure *before* the stream starts is
 * a normal API error and the user deserves to be told which slot is empty.
 */
export async function downloadExport(
  brandId: string,
  postId: string,
  aspectRatios?: AspectRatio[],
): Promise<{ blob: Blob; filename: string }> {
  const response = await apiFetchRaw(`/api/brands/${brandId}/posts/${postId}/export`, {
    method: 'POST',
    body: aspectRatios?.length ? { aspectRatios } : {},
  });

  const disposition = response.headers.get('Content-Disposition') ?? '';
  const match = /filename="([^"]+)"/.exec(disposition);

  return { blob: await response.blob(), filename: match?.[1] ?? 'buzzalicious-export.zip' };
}
