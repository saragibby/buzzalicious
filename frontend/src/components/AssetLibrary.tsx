import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../lib/api';
import { useScope } from '../lib/scope';
import {
  deleteAsset,
  fetchAssets,
  setBrandLogo,
  uploadAsset,
  type AssetKind,
} from '../lib/brandApi';

const KINDS: { value: AssetKind | 'ALL'; label: string }[] = [
  { value: 'ALL', label: 'Everything' },
  { value: 'LOGO', label: 'Logos' },
  { value: 'PHOTO', label: 'Photos' },
];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * The brand's asset library.
 *
 * Scoped by the current brand, so there is no workspace-wide view to accidentally leak
 * one client's photos into another's composer. That is enforced server-side; this just
 * never offers the option.
 */
export function AssetLibrary() {
  const { brand } = useScope();
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<AssetKind | 'ALL'>('ALL');
  const [uploadKind, setUploadKind] = useState<AssetKind>('PHOTO');
  const [error, setError] = useState<string | null>(null);

  const brandId = brand?.id ?? '';
  const assetsKey = ['brands', brandId, 'assets', kind];

  const assetsQuery = useQuery({
    queryKey: assetsKey,
    queryFn: () => fetchAssets(brandId, kind === 'ALL' ? undefined : kind),
    enabled: Boolean(brandId),
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['brands', brandId, 'assets'] });

  const uploadMutation = useMutation({
    mutationFn: (file: File) => uploadAsset(brandId, file, { kind: uploadKind }),
    onSuccess: () => {
      setError(null);
      void invalidate();
    },
    // The server's message is the useful one — "that file is 6000x4000" beats "upload
    // failed", and it is already written to be safe to show.
    onError: (caught: unknown) =>
      setError(caught instanceof ApiError ? caught.message : 'That upload did not work.'),
  });

  const deleteMutation = useMutation({
    mutationFn: (assetId: string) => deleteAsset(brandId, assetId),
    onSuccess: invalidate,
  });

  const logoMutation = useMutation({
    mutationFn: (assetId: string) => setBrandLogo(brandId, assetId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['workspaces'] }),
  });

  if (!brand) return null;

  const assets = assetsQuery.data ?? [];

  return (
    <section className="asset-library">
      <header className="asset-header">
        <h2>Assets</h2>
        <div className="asset-controls">
          <label className="field inline">
            <span className="field-label">Show</span>
            <select
              value={kind}
              onChange={(event) => setKind(event.target.value as AssetKind | 'ALL')}
              aria-label="Filter assets"
            >
              {KINDS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label className="field inline">
            <span className="field-label">Upload as</span>
            <select
              value={uploadKind}
              onChange={(event) => setUploadKind(event.target.value as AssetKind)}
              aria-label="Upload kind"
            >
              <option value="PHOTO">Photo</option>
              <option value="LOGO">Logo</option>
            </select>
          </label>

          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            disabled={uploadMutation.isPending}
          >
            {uploadMutation.isPending ? 'Uploading…' : 'Upload'}
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) uploadMutation.mutate(file);
            }}
          />
        </div>
      </header>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      {assets.length === 0 && !assetsQuery.isLoading && (
        <p className="field-hint">
          Nothing here yet. Upload a logo and a few photos — templates use them automatically.
        </p>
      )}

      <ul className="asset-grid">
        {assets.map((asset) => (
          <li key={asset.id} className="asset-card">
            <img
              src={asset.thumbnailUrl ?? asset.url}
              alt={asset.altText ?? ''}
              loading="lazy"
              width={asset.width ?? undefined}
              height={asset.height ?? undefined}
            />
            <div className="asset-meta">
              <span>{asset.kind.toLowerCase()}</span>
              <span>
                {asset.width}×{asset.height} · {formatBytes(asset.bytes)}
              </span>
            </div>
            <div className="asset-actions">
              {brand.logoAssetId === asset.id ? (
                <span className="asset-badge">Current logo</span>
              ) : (
                <button
                  type="button"
                  onClick={() => logoMutation.mutate(asset.id)}
                  disabled={logoMutation.isPending}
                >
                  Use as logo
                </button>
              )}
              <button
                type="button"
                className="danger"
                onClick={() => deleteMutation.mutate(asset.id)}
                disabled={deleteMutation.isPending}
              >
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
