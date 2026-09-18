import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Insights } from './Insights';
import { formatMetric } from '../../lib/insights';
import { ScopeContext, type ScopeContextValue } from '../../lib/scope';
import type { Brand } from '../../lib/brandApi';

/**
 * What this screen is tested on is what it refuses to say.
 *
 * Rendering a table is not the risk. The risks are printing `0` for something nobody
 * measured, and printing a confident "your best template is…" over three posts. Both look
 * completely normal on screen, which is exactly why they need assertions rather than a
 * glance.
 */

const BRAND = { id: 'brand-1', name: 'Rise & Shore' } as unknown as Brand;

function scopeValue(): ScopeContextValue {
  return {
    workspaces: [],
    brands: [BRAND],
    workspace: null,
    brand: BRAND,
    selectWorkspace: () => {},
    selectBrand: () => {},
    isLoading: false,
    error: null,
  };
}

function target(overrides: Record<string, unknown> = {}) {
  return {
    postTargetId: 'target-1',
    postId: 'post-1',
    postTitle: 'Shoulder season deals',
    platform: 'X',
    publishedAt: '2026-03-01T12:00:00.000Z',
    templateId: 'tpl-1',
    templateName: 'Promo card',
    trendId: null,
    linkClicks: 12,
    impressions: null,
    reach: null,
    likes: 3,
    comments: null,
    shares: null,
    saves: null,
    videoViews: null,
    capturedAt: '2026-03-01T13:00:00.000Z',
    outcome: { score: 7.5, components: ['click', 'engage'], coverage: 0.55, weightedSum: 4.1 },
    ...overrides,
  };
}

function summary(overrides: Record<string, unknown> = {}) {
  return {
    window: { from: '2026-02-01T00:00:00.000Z', to: '2026-03-03T00:00:00.000Z' },
    headline: null,
    byPlatform: [],
    byTemplate: [],
    targets: [target()],
    ...overrides,
  };
}

function renderInsights() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });

  return render(
    <QueryClientProvider client={queryClient}>
      <ScopeContext.Provider value={scopeValue()}>
        <Insights />
      </ScopeContext.Provider>
    </QueryClientProvider>,
  );
}

function respondWith(body: unknown) {
  vi.mocked(fetch).mockResolvedValue(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

describe('Insights', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  describe('a zero is a lie', () => {
    it('says clicks are unavailable rather than showing none', async () => {
      respondWith(summary({ targets: [target({ linkClicks: null })] }));

      renderInsights();

      await waitFor(() => expect(screen.getByText('clicks n/a')).toBeInTheDocument());
      // The literal a zero would have produced. Asserting its absence is the point: the
      // positive assertion above would still pass if "0 clicks" were rendered beside it.
      expect(screen.queryByText('0 clicks')).not.toBeInTheDocument();
    });

    it('shows a measured click count, proving the n/a above is a real distinction', async () => {
      respondWith(summary({ targets: [target({ linkClicks: 0 })] }));

      renderInsights();

      // A genuine zero is information and must render as a zero. Without this the
      // previous test could be satisfied by a screen that never shows clicks at all.
      await waitFor(() => expect(screen.getByText('0 clicks')).toBeInTheDocument());
      expect(screen.queryByText('clicks n/a')).not.toBeInTheDocument();
    });

    it('renders an unmeasured group click total as a dash, not zero', async () => {
      respondWith(
        summary({
          byPlatform: [
            {
              key: 'INSTAGRAM',
              scored: 3,
              unscored: 0,
              meanScore: 2,
              sharedComponents: ['save'],
              clicks: { key: 'INSTAGRAM', clicks: 0, measured: 0, unmeasured: 3, botClicks: 0 },
            },
          ],
        }),
      );

      renderInsights();

      const row = await screen.findByText('instagram');
      const cells = within(row.closest('tr')!).getAllByRole('cell');
      expect(cells[2]).toHaveTextContent('—');
      expect(cells[2]).not.toHaveTextContent('0');
    });
  });

  describe('the metric timeline', () => {
    it('dashes the metrics this platform never reported', async () => {
      // Two responses: the summary, then the timeline fetched when the row is expanded.
      vi.mocked(fetch)
        .mockResolvedValueOnce(
          new Response(JSON.stringify(summary()), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              points: [
                {
                  capturedAt: '2026-03-01T13:00:00.000Z',
                  hoursSincePublish: 1,
                  linkClicks: 4,
                  impressions: null,
                  reach: null,
                  likes: 0,
                  comments: null,
                  shares: null,
                  saves: null,
                  videoViews: null,
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );

      renderInsights();
      await screen.findByText('Shoulder season deals');
      fireEvent.click(screen.getByRole('button', { name: /Shoulder season deals/ }));

      const row = await screen.findByText('1h');
      const cells = within(row.closest('tr')!).getAllByRole('cell');

      // clicks 4, reach unreported, likes a genuine 0. The zero and the dashes sitting in
      // the same row is the assertion: a `?? 0` would make all three read as numbers.
      expect(cells[1]).toHaveTextContent('4');
      expect(cells[2]).toHaveTextContent('—');
      expect(cells[2]).not.toHaveTextContent('0');
      expect(cells[3]).toHaveTextContent('0');
    });

    it('formatMetric keeps a real zero and a missing value distinct', () => {
      expect(formatMetric(null)).toBe('—');
      expect(formatMetric(0)).toBe('0');
    });
  });

  describe('it will not claim a finding it does not have', () => {
    it('explains the absence instead of ranking when the server named no winner', async () => {
      respondWith(summary({ headline: null }));

      renderInsights();

      await waitFor(() =>
        expect(screen.getByText(/Not enough comparable posts yet/)).toBeInTheDocument(),
      );
      expect(screen.queryByText(/Your best/)).not.toBeInTheDocument();
    });

    it('states the headline when the server did name one', async () => {
      respondWith(
        summary({
          headline: {
            kind: 'template',
            key: 'tpl-1',
            meanScore: 8.2,
            scored: 5,
            runnerUpScore: 3.1,
          },
        }),
      );

      renderInsights();

      // The sample size is in the sentence on purpose: "your best template" without it
      // reads as a fact rather than an average over five posts.
      await waitFor(() => expect(screen.getByText(/Your best template/)).toBeInTheDocument());
      expect(screen.getByText(/5 posts/)).toBeInTheDocument();
      expect(screen.queryByText(/Not enough comparable posts yet/)).not.toBeInTheDocument();
    });

    it('flags a group whose posts were measured differently', async () => {
      respondWith(
        summary({
          byTemplate: [
            {
              key: 'tpl-1',
              scored: 4,
              unscored: 2,
              meanScore: 5,
              sharedComponents: [],
              clicks: null,
            },
          ],
        }),
      );

      renderInsights();

      await waitFor(() => expect(screen.getByText('mixed')).toBeInTheDocument());
      // The unmeasured tail is shown rather than folded into the post count, so "4" is
      // not read as the whole story.
      expect(screen.getByText(/\+2 unmeasured/)).toBeInTheDocument();
    });

    it('does not flag a group whose posts share their components', async () => {
      respondWith(
        summary({
          byTemplate: [
            {
              key: 'tpl-1',
              scored: 4,
              unscored: 0,
              meanScore: 5,
              sharedComponents: ['click', 'engage'],
              clicks: { key: 'tpl-1', clicks: 40, measured: 4, unmeasured: 0, botClicks: 9 },
            },
          ],
        }),
      );

      renderInsights();

      await waitFor(() => expect(screen.getByText('Promo card')).toBeInTheDocument());
      expect(screen.queryByText('mixed')).not.toBeInTheDocument();
      expect(screen.queryByText(/unmeasured/)).not.toBeInTheDocument();
    });
  });

  it('asks for a brand rather than rendering an empty dashboard', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <ScopeContext.Provider value={{ ...scopeValue(), brand: null }}>
          <Insights />
        </ScopeContext.Provider>
      </QueryClientProvider>,
    );

    expect(screen.getByText(/Pick a brand/)).toBeInTheDocument();
    // No brand, no request: a fetch here would be a call to `/api/brands/null/insights`.
    expect(fetch).not.toHaveBeenCalled();
  });
});
