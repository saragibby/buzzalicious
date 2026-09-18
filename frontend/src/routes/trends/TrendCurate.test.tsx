import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TrendCurate } from './TrendCurate';

/**
 * The curation screen is a weekly tool, so what is tested is whether it tells the curator
 * what still needs doing — the counts and the flags — not whether a table renders.
 */

const TRENDS = {
  trends: [
    {
      id: 'trend-1',
      title: 'Shoulder-season value posts',
      description: null,
      kind: 'FORMAT',
      platform: 'INSTAGRAM',
      externalRef: null,
      exampleUrls: [],
      status: 'EMERGING',
      velocity: 0.5,
      momentum: 0.7,
      firstSeenAt: '2026-02-01T00:00:00.000Z',
      lastSeenAt: '2026-03-01T00:00:00.000Z',
      peakedAt: null,
      signalCount: 2,
      latestObservedAt: '2026-03-01T00:00:00.000Z',
      categoryScoreCount: 3,
      curation: null,
      mapping: {
        method: 'rules',
        confidence: 0.3,
        reviewStatus: 'NEEDS_REVIEW',
        mappedAt: '2026-03-01T00:00:00.000Z',
        inputHash: 'abc',
        evidence: [{ categorySlug: 'vacation-rental', score: 0.3, reason: 'mentions "rental"' }],
      },
      hasAngle: false,
      needsReview: true,
    },
  ],
};

function renderCurate() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });

  return render(
    <QueryClientProvider client={queryClient}>
      <TrendCurate />
    </QueryClientProvider>,
  );
}

describe('TrendCurate', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it('leads with what still needs work', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify(TRENDS), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    renderCurate();

    await waitFor(() => expect(screen.getByText(/1 need an angle/)).toBeInTheDocument());
    expect(screen.getByText(/1 need a category check/)).toBeInTheDocument();
  });

  it('flags a trend with no angle, because it is being withheld from every feed', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify(TRENDS), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    renderCurate();

    await waitFor(() => expect(screen.getByText('needs an angle')).toBeInTheDocument());
    expect(screen.getByText('check category')).toBeInTheDocument();
  });

  it('explains the restriction to a non-admin instead of showing a broken page', async () => {
    // The allow list is fail-closed, so this is the expected state for most signed-in
    // users rather than an exceptional one.
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'FORBIDDEN', message: 'nope' } }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    renderCurate();

    await waitFor(() =>
      expect(screen.getByText(/limited to platform\s+administrators/)).toBeInTheDocument(),
    );
  });
});
