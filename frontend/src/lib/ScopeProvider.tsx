import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchBrands, fetchWorkspaces } from './brandApi';
import { ScopeContext, brandsQueryKey, workspacesQueryKey, type ScopeContextValue } from './scope';

/**
 * The current workspace and brand.
 *
 * Held in React state with a `localStorage` echo rather than in the URL. The URL would be
 * the better answer for a single-brand product, but almost every screen here is
 * brand-scoped, and putting the brand in the path means either prefixing every route or
 * carrying a query parameter through every link — and forgetting it once silently drops
 * the user back to a different brand's data.
 *
 * The stored value is treated as a *hint*, never as authority: it is validated against
 * what the API actually returns on every load. A stale id from a workspace the user was
 * removed from resolves to the first workspace they do have, not to a broken screen. The
 * server would refuse it anyway — this just means the UI does not have to show that
 * refusal to explain itself.
 */

const STORAGE_KEY = 'buzz.scope';

interface StoredScope {
  workspaceId?: string;
  brandId?: string;
}

function readStored(): StoredScope {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as StoredScope) : {};
  } catch {
    // A corrupt or unavailable localStorage (private mode, disabled storage) must not
    // stop the app loading — it only costs the user their last selection.
    return {};
  }
}

function writeStored(scope: StoredScope): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(scope));
  } catch {
    /* Non-fatal, as above. */
  }
}

export function ScopeProvider({ children }: { children: ReactNode }) {
  const [stored] = useState(readStored);
  const [workspaceId, setWorkspaceId] = useState<string | undefined>(stored.workspaceId);
  const [brandId, setBrandId] = useState<string | undefined>(stored.brandId);

  const workspacesQuery = useQuery({
    queryKey: workspacesQueryKey,
    queryFn: fetchWorkspaces,
  });

  const workspaces = useMemo(() => workspacesQuery.data ?? [], [workspacesQuery.data]);

  // Resolve the stored hint against reality. `find` rather than trust, so an id the user
  // no longer has access to simply does not match.
  const workspace = useMemo(
    () => workspaces.find((candidate) => candidate.id === workspaceId) ?? workspaces[0] ?? null,
    [workspaces, workspaceId],
  );

  const brandsQuery = useQuery({
    queryKey: brandsQueryKey(workspace?.id ?? ''),
    queryFn: () => fetchBrands(workspace!.id),
    enabled: Boolean(workspace),
  });

  const brands = useMemo(() => brandsQuery.data ?? [], [brandsQuery.data]);

  const brand = useMemo(
    () => brands.find((candidate) => candidate.id === brandId) ?? brands[0] ?? null,
    [brands, brandId],
  );

  // Persist what was actually resolved, not what was asked for, so a stale id is repaired
  // rather than retried on every load.
  useEffect(() => {
    if (workspace) writeStored({ workspaceId: workspace.id, brandId: brand?.id });
  }, [workspace, brand]);

  const value = useMemo<ScopeContextValue>(
    () => ({
      workspaces,
      brands,
      workspace,
      brand,
      selectWorkspace: (id: string) => {
        setWorkspaceId(id);
        // Clear the brand: it belongs to the workspace being left, and keeping it would
        // leave the UI asking for a brand the new scope cannot see.
        setBrandId(undefined);
      },
      selectBrand: setBrandId,
      isLoading: workspacesQuery.isLoading || brandsQuery.isLoading,
      error: workspacesQuery.error ?? brandsQuery.error,
    }),
    [
      workspaces,
      brands,
      workspace,
      brand,
      workspacesQuery.isLoading,
      workspacesQuery.error,
      brandsQuery.isLoading,
      brandsQuery.error,
    ],
  );

  return <ScopeContext.Provider value={value}>{children}</ScopeContext.Provider>;
}
