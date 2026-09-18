import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TrendFeed } from './TrendFeed';

/**
 * The feed's job is to remove the blank page, so these tests are about what the user is
 * told rather than about rendering mechanics: the angle is present, an empty feed says
 * *why* it is empty, and a brand with no category gets its actual fix instead of a shrug.
 */

const BRANDS = {
  brands: [
    {
      id: 'brand-1',
      name: 'Rise & Shore',
      categorySlug: 'vacation-rental',
      categoryName: 'Vacation Rental',
    },
  ],
};

const FEED = {
  brand: {
    id: 'brand-1',
    name: 'Rise & Shore',
    categorySlug: 'vacation-rental',
    categoryName: 'Vacation Rental',
    targetPlatforms: ['INSTAGRAM'],
  },
  needsCategory: false,
  items: [
    {
      trendId: 'trend-1',
      title: 'Shoulder-season value posts',
      description: 'Off-peak pricing framed as value.',
      kind: 'FORMAT',
      platform: 'INSTAGRAM',
      status: 'EMERGING',
      momentum: 0.72,
      velocity: 0.5,
      lastSeenAt: '2026-03-01T00:00:00.000Z',
      exampleUrls: ['https://example.test/post'],
      feedScore: 0.61,
      categoryScore: 0.92,
      platformFit: 1,
      freshness: 0.9,
      whyThisFitsYou: 'Strong match for Vacation Rental, and still early.',
      suggestedAngle: 'Post the same view in February and July with the price under each one.',
      hook: 'Same view. Half the people.',
      pairedTemplates: [
        {
          id: 'tpl-1',
          slug: 'before-after',
          name: 'Before / After',
          archetype: 'COMPARISON',
          fit: 0.8,
          viaCategorySlug: 'vacation-rental',
        },
      ],
    },
  ],
};

function mockRoutes(feed: unknown) {
  vi.mocked(fetch).mockImplementation((input) => {
    const url = String(input);
    const body = url.includes('/feed') ? feed : BRANDS;
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });
}

function renderFeed() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter
        initialEntries={['/trends']}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <TrendFeed />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('TrendFeed', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it('leads with something the user could actually post', async () => {
    mockRoutes(FEED);
    renderFeed();

    await waitFor(() =>
      expect(screen.getByText(/Post the same view in February and July/)).toBeInTheDocument(),
    );
  });

  it('explains why the trend fits this brand', async () => {
    // "Here is a trend" is a list. "Here is why it is yours" is the product.
    mockRoutes(FEED);
    renderFeed();

    await waitFor(() =>
      expect(screen.getByText(/Strong match for Vacation Rental/)).toBeInTheDocument(),
    );
  });

  it('offers a template to start from', async () => {
    mockRoutes(FEED);
    renderFeed();

    await waitFor(() => expect(screen.getByText('Before / After')).toBeInTheDocument());
  });

  it('tells an uncategorised brand what to do instead of showing nothing', async () => {
    mockRoutes({ ...FEED, needsCategory: true, items: [] });
    renderFeed();

    await waitFor(() =>
      expect(screen.getByText(/doesn’t have a business category yet/)).toBeInTheDocument(),
    );
  });

  it('says a thin feed is deliberate rather than looking broken', async () => {
    // A weak recommendation costs more trust than no recommendation, so an empty feed
    // needs to read as a decision.
    mockRoutes({ ...FEED, items: [] });
    renderFeed();

    await waitFor(() =>
      expect(screen.getByText(/weak match is worse than nothing/)).toBeInTheDocument(),
    );
  });

  it('tells a user with no brands why there is nothing to rank', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ brands: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    renderFeed();

    await waitFor(() => expect(screen.getByText(/don’t have a brand yet/)).toBeInTheDocument());
  });
});
