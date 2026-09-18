import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScopeSwitcher } from './ScopeSwitcher';
import { ScopeProvider } from '../lib/ScopeProvider';
import * as brandApi from '../lib/brandApi';

/**
 * The switcher is the one place a user can cross a tenancy boundary on purpose, so the
 * behaviour worth pinning is what happens around that: that only their own workspaces are
 * offered, and that switching does not carry the previous workspace's brand across.
 */

const WORKSPACES: brandApi.WorkspaceSummary[] = [
  { id: 'ws-rise', name: 'Rise & Shore', slug: 'rise-and-shore', role: 'OWNER' },
  { id: 'ws-tax', name: 'TaxDedux', slug: 'taxdedux', role: 'ADMIN' },
];

function brand(id: string, workspaceId: string, name: string): brandApi.Brand {
  return {
    id,
    workspaceId,
    name,
    slug: name.toLowerCase().replace(/\W+/g, '-'),
    website: null,
    categoryId: null,
    logoAssetId: null,
    palette: {
      primary: '#000000',
      secondary: '#111111',
      accent: '#222222',
      neutral: '#888888',
      background: '#ffffff',
      text: '#000000',
    },
    typography: {
      headingFamily: 'Inter',
      bodyFamily: 'Inter',
      headingWeight: 700,
      bodyWeight: 400,
    },
    voiceGuide: {
      summary: '',
      toneAttributes: [],
      doSay: [],
      dontSay: [],
      vocabulary: [],
      sampleCopy: [],
      readingLevel: 'standard',
      emojiPolicy: 'sparing',
      bannedOpeners: [],
    },
    goals: null,
    targetPlatforms: [],
    timezone: 'America/New_York',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };
}

const BRANDS: Record<string, brandApi.Brand[]> = {
  'ws-rise': [brand('brand-rise', 'ws-rise', 'Rise & Shore')],
  'ws-tax': [brand('brand-tax', 'ws-tax', 'TaxDedux')],
};

function renderSwitcher() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <ScopeProvider>
        <ScopeSwitcher />
      </ScopeProvider>
    </QueryClientProvider>,
  );
}

/**
 * jsdom here does not provide a usable `localStorage`, and the component treats a missing
 * one as "no stored preference" by design. The stored-hint test needs a real store to
 * assert against, so one is installed rather than skipping the case that matters most —
 * a stale id pointing at a workspace the user was removed from.
 */
function installLocalStorage(): void {
  const store = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
      clear: () => store.clear(),
    },
  });
}

describe('ScopeSwitcher', () => {
  beforeEach(() => {
    installLocalStorage();
    vi.spyOn(brandApi, 'fetchWorkspaces').mockResolvedValue(WORKSPACES);
    vi.spyOn(brandApi, 'fetchBrands').mockImplementation((workspaceId: string) =>
      Promise.resolve(BRANDS[workspaceId] ?? []),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('offers only the workspaces the API returned', async () => {
    renderSwitcher();

    const select = await screen.findByLabelText('Workspace');
    const options = [...select.querySelectorAll('option')].map((option) => option.textContent);

    // The server already refuses anything else; this asserts the UI never even offers it,
    // so a cross-tenant switch is not one click plus a failed request.
    expect(options).toEqual(['Rise & Shore', 'TaxDedux']);
  });

  it('loads the brands of the workspace that was selected', async () => {
    renderSwitcher();

    await screen.findByLabelText('Workspace');
    fireEvent.change(screen.getByLabelText('Workspace'), { target: { value: 'ws-tax' } });

    await waitFor(() => {
      expect(brandApi.fetchBrands).toHaveBeenCalledWith('ws-tax');
    });

    await waitFor(() => {
      expect(screen.getByLabelText('Brand')).toHaveValue('brand-tax');
    });
  });

  it('does not carry a brand across a workspace switch', async () => {
    renderSwitcher();

    await waitFor(() => expect(screen.getByLabelText('Brand')).toHaveValue('brand-rise'));

    fireEvent.change(screen.getByLabelText('Workspace'), { target: { value: 'ws-tax' } });

    // Keeping the old brand id would leave the UI asking the new scope for a brand it
    // cannot see — a 404 that looks like the app is broken rather than like a switch.
    await waitFor(() => expect(screen.getByLabelText('Brand')).toHaveValue('brand-tax'));
  });

  it('hides the workspace select for a single-tenant user', async () => {
    vi.spyOn(brandApi, 'fetchWorkspaces').mockResolvedValue([WORKSPACES[0]]);

    renderSwitcher();

    await screen.findByLabelText('Brand');
    expect(screen.queryByLabelText('Workspace')).toBeNull();
  });

  it('ignores a stored workspace the user no longer belongs to', async () => {
    window.localStorage.setItem(
      'buzz.scope',
      JSON.stringify({ workspaceId: 'ws-gone', brandId: 'brand-gone' }),
    );

    renderSwitcher();

    // Falls back to a workspace they do have rather than rendering an empty or broken
    // scope. The stored value is a hint, never authority.
    await waitFor(() => expect(screen.getByLabelText('Workspace')).toHaveValue('ws-rise'));
    expect(brandApi.fetchBrands).toHaveBeenCalledWith('ws-rise');
  });
});
