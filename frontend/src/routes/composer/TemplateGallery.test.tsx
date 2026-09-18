import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TemplateGallery } from './TemplateGallery';
import { ScopeContext, type ScopeContextValue } from '../../lib/scope';
import type { Brand } from '../../lib/brandApi';

/**
 * The first screen of the core loop.
 *
 * The gallery's value is that it is *ranked by industry* — that is the product's wedge
 * (docs/00). So these tests are about whether the ranking is asked for, honoured and
 * explained, and about the three empty states, each of which has a different cause and a
 * different fix. A "no results" test that could not tell them apart would be exactly the
 * kind of green check that means nothing.
 */

const BRAND: Brand = {
  id: 'brand-1',
  name: 'Rise & Shore',
  categoryId: 'cat-vacation-rental',
  targetPlatforms: ['INSTAGRAM', 'X'],
} as unknown as Brand;

const TEMPLATES = [
  {
    id: 'tpl-1',
    slug: 'big-number',
    name: 'Big number',
    description: 'One statistic, large.',
    archetype: 'STAT',
    kind: 'IMAGE',
    supportedRatios: ['SQUARE_1_1', 'PORTRAIT_4_5'],
    matchedCategoryId: 'cat-vacation-rental',
    inherited: false,
    score: 0.9,
  },
  {
    id: 'tpl-2',
    slug: 'plain-text-take',
    name: 'Plain text take',
    description: null,
    archetype: 'OPINION',
    kind: 'TEXT',
    supportedRatios: ['SQUARE_1_1'],
    matchedCategoryId: null,
    inherited: false,
    score: 0.4,
  },
];

let lastTemplatesUrl = '';

function mockApi(templates: unknown = TEMPLATES, status = 200) {
  vi.mocked(fetch).mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/api/templates')) {
      lastTemplatesUrl = url;
      return Promise.resolve(
        new Response(status === 200 ? JSON.stringify({ templates }) : '{"error":{}}', {
          status,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }
    return Promise.resolve(
      new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
  });
}

function scope(overrides: Partial<ScopeContextValue> = {}): ScopeContextValue {
  return {
    workspaces: [],
    brands: [],
    workspace: null,
    brand: BRAND,
    selectWorkspace: () => undefined,
    selectBrand: () => undefined,
    isLoading: false,
    error: null,
    ...overrides,
  };
}

function renderGallery(value: ScopeContextValue = scope()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });

  return render(
    <QueryClientProvider client={queryClient}>
      <ScopeContext.Provider value={value}>
        <MemoryRouter
          initialEntries={['/composer']}
          future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
        >
          <TemplateGallery />
        </MemoryRouter>
      </ScopeContext.Provider>
    </QueryClientProvider>,
  );
}

describe('TemplateGallery', () => {
  beforeEach(() => {
    lastTemplatesUrl = '';
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => vi.unstubAllGlobals());

  it('asks the server to rank for this brand’s industry', async () => {
    // Without the category on the request the server cannot rank, and the gallery silently
    // degrades to an alphabetical list that still *looks* fine.
    mockApi();
    renderGallery();

    await waitFor(() => expect(lastTemplatesUrl).toContain('categoryId=cat-vacation-rental'));
  });

  it('renders in the order the server returned, rather than re-sorting', async () => {
    mockApi();
    renderGallery();

    await waitFor(() => expect(screen.getByText('Big number')).toBeInTheDocument());

    const headings = screen.getAllByRole('heading', { level: 2 }).map((node) => node.textContent);
    expect(headings).toEqual(['Big number', 'Plain text take']);
  });

  it('only claims industry relevance for the template that actually matched', async () => {
    // Labelling everything "popular in your industry" is worse than labelling nothing: the
    // claim stops carrying information and the ranking stops being believable.
    mockApi();
    renderGallery();

    await waitFor(() => expect(screen.getByText('Big number')).toBeInTheDocument());
    expect(screen.getAllByText(/Popular in your industry/)).toHaveLength(1);
  });

  it('distinguishes a direct category match from an inherited one', async () => {
    mockApi([{ ...TEMPLATES[0], inherited: true }]);
    renderGallery();

    await waitFor(() =>
      expect(screen.getByText('Works for businesses like yours')).toBeInTheDocument(),
    );
    expect(screen.queryByText('Popular in your industry')).not.toBeInTheDocument();
  });

  describe('empty states', () => {
    it('sends a user with no brand to onboarding', async () => {
      // Cause: onboarding is incomplete. Fix: the brand kit. Nothing about templates.
      mockApi();
      renderGallery(scope({ brand: null }));

      expect(
        await screen.findByText(/need a brand before you can make a post/),
      ).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /brand kit/i })).toBeInTheDocument();
    });

    it('tells an uncategorised brand which field fixes the ordering', async () => {
      // Cause: nothing to rank against. Fix: one field. This is the most recoverable of
      // the three and would be the worst one to collapse into a generic message.
      mockApi();
      renderGallery(scope({ brand: { ...BRAND, categoryId: null } as Brand }));

      await waitFor(() =>
        expect(screen.getByText(/does not have an industry set/)).toBeInTheDocument(),
      );
      expect(screen.getByRole('link', { name: /Pick your industry/ })).toBeInTheDocument();
      expect(lastTemplatesUrl).not.toContain('categoryId');
    });

    it('blames the filter, not the library, when a filter matches nothing', async () => {
      mockApi([]);
      renderGallery();

      await waitFor(() =>
        expect(screen.getByText(/no templates in the library yet/)).toBeInTheDocument(),
      );

      fireEvent.change(screen.getByLabelText(/Show templates I can post to/), {
        target: { value: 'X' },
      });

      // Cause: the filter. Fix: clear it. Saying "the library is empty" here would send
      // the user looking for a problem that is not there.
      await waitFor(() => expect(screen.getByText(/Clear the filter/)).toBeInTheDocument());
    });
  });

  it('offers a retry instead of an empty grid when the library fails to load', async () => {
    // A failed fetch and an empty library look identical in the DOM unless this is
    // distinguished, and the two need opposite responses from the user.
    mockApi(TEMPLATES, 500);
    renderGallery();

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be loaded/);
    expect(screen.getByRole('button', { name: /Try again/ })).toBeInTheDocument();
    expect(screen.queryByText(/no templates in the library yet/)).not.toBeInTheDocument();
  });
});
