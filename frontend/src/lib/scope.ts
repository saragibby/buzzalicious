import { createContext, useContext } from 'react';
import type { Brand, WorkspaceSummary } from './brandApi';

/**
 * The scope context and its hooks.
 *
 * Separated from the provider component so this module exports no components: mixing the
 * two breaks React Fast Refresh, which silently degrades to a full reload and makes
 * editing the brand-kit form lose its state on every keystroke-triggered rebuild.
 */

export interface ScopeContextValue {
  workspaces: WorkspaceSummary[];
  brands: Brand[];
  workspace: WorkspaceSummary | null;
  brand: Brand | null;
  selectWorkspace: (workspaceId: string) => void;
  selectBrand: (brandId: string) => void;
  isLoading: boolean;
  error: unknown;
}

export const ScopeContext = createContext<ScopeContextValue | null>(null);

export const workspacesQueryKey = ['workspaces'] as const;

export const brandsQueryKey = (workspaceId: string) => ['workspaces', workspaceId, 'brands'];

/** Throws outside the provider, rather than returning a null scope a caller may ignore. */
export function useScope(): ScopeContextValue {
  const context = useContext(ScopeContext);
  if (!context) {
    throw new Error('useScope must be used inside <ScopeProvider>');
  }
  return context;
}

/**
 * The current brand, or `null` while it loads.
 *
 * Separate from `useScope` because most screens want exactly this and nothing else, and a
 * component that destructures the whole scope tends to acquire dependencies on it.
 */
export function useCurrentBrand(): Brand | null {
  return useScope().brand;
}
