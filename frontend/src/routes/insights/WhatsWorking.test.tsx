import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WhatsWorking } from './WhatsWorking';

/**
 * Two claims are worth pinning here, and both are about *not* saying something.
 *
 * 1. A `null` cadence must never surface as a number. This is the same hazard the whole
 *    shrinkage design is built around, one layer further out: the backend keeps
 *    "unmeasured" and "measured" in different shapes, and the UI is the last place that
 *    distinction can be quietly flattened into a confident sentence.
 * 2. Exploration picks are excluded from "what's working", because an untried candidate
 *    is not evidence about what worked.
 *
 * Each has a positive control, because a component that rendered nothing at all would
 * otherwise satisfy both.
 */

const BASIS = {
  observed: 2.4,
  observations: 8,
  prior: 1,
  priorSource: 'neutral',
  brandWeight: 8 / 13,
  priorWeight: 5,
};

function archetype(overrides: Record<string, unknown> = {}) {
  return {
    archetype: 'BEFORE_AFTER',
    templateIds: ['tpl-1'],
    value: 1.9,
    basis: BASIS,
    scored: 8,
    posts: 8,
    userChoices: 6,
    selection: 'exploit',
    explanation: {
      kind: 'brand-claim',
      multiplier: 2.4,
      category: 'vacation rentals',
      sampleSize: 8,
      untried: false,
      selection: 'exploit',
      claimBasis: 'raw-observed',
    },
    ...overrides,
  };
}

function body(overrides: Record<string, unknown> = {}) {
  return {
    archetypes: [archetype()],
    sendTime: {
      suggested: { local: '2026-03-08T19:00', timeZone: 'America/Denver', bucket: 'weekend' },
      selection: 'exploit',
    },
    cadence: { suggested: null, currentPerWeek: null, fatigueAbove: null },
    ...overrides,
  };
}

function mock(payload: unknown) {
  vi.mocked(fetch).mockImplementation(() =>
    Promise.resolve(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  );
}

function renderPanel() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <WhatsWorking brandId="brand-1" />
    </QueryClientProvider>,
  );
}

describe('WhatsWorking', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it('names a suggested cadence when one was measured', async () => {
    // The positive control. Without it, "renders no number when null" is satisfied by a
    // component that renders no number ever.
    mock(
      body({
        cadence: {
          suggested: { minPerWeek: 3, maxPerWeek: 5 },
          currentPerWeek: 2,
          fatigueAbove: 7,
        },
      }),
    );

    renderPanel();

    expect(await screen.findByText(/3–5 posts a week/)).toBeInTheDocument();
    expect(screen.getByText(/averaging 2 a week/)).toBeInTheDocument();
    expect(screen.getByText(/above 7 posts have done worse/)).toBeInTheDocument();
  });

  it('says it does not know rather than naming a frequency, when cadence is null', async () => {
    mock(body());

    renderPanel();

    expect(await screen.findByText(/Not enough measured weeks/)).toBeInTheDocument();
    // The specific failure being excluded: a `null` rendered through a formatter and
    // arriving as a real-looking recommendation.
    expect(screen.queryByText(/posts a week/)).not.toBeInTheDocument();
    expect(screen.queryByText(/NaN|undefined|null/)).not.toBeInTheDocument();
  });

  it('leaves exploration picks out of what is working, while still showing exploits', async () => {
    mock(
      body({
        archetypes: [
          archetype(),
          archetype({
            archetype: 'LISTICLE',
            selection: 'explore',
            scored: 0,
            explanation: {
              kind: 'exploration',
              multiplier: null,
              category: 'vacation rentals',
              sampleSize: 0,
              untried: true,
              selection: 'explore',
              claimBasis: null,
            },
          }),
        ],
      }),
    );

    renderPanel();

    // Positive control and exclusion in one assertion pair: the exploit is present, so
    // the absence of the exploration pick is about `selection`, not about rendering.
    expect(await screen.findByText('Before After')).toBeInTheDocument();
    expect(screen.queryByText('Listicle')).not.toBeInTheDocument();
  });

  it('marks an exploration send-time as untested rather than as a finding', async () => {
    mock(
      body({
        sendTime: {
          suggested: { local: '2026-03-08T19:00', timeZone: 'America/Denver', bucket: 'weekend' },
          selection: 'explore',
        },
      }),
    );

    renderPanel();

    expect(await screen.findByText(/haven’t tested for you yet/)).toBeInTheDocument();
  });

  it('degrades itself, not the page, when the payload is missing sections', async () => {
    // Found by the existing Insights suite rather than by this file: a payload with only
    // `archetypes` threw inside this component and white-screened the entire Insights
    // route, taking the metric timeline down with it. The panel is additive to a page
    // that works without it, so a partial response must cost the suggestion, not the
    // numbers the user came for.
    mock({ archetypes: [archetype()] });

    renderPanel();

    // Positive control for the degradation: the part it *could* render, it still renders.
    expect(await screen.findByText('Before After')).toBeInTheDocument();
    expect(screen.getByText(/Not enough measured weeks/)).toBeInTheDocument();
    expect(screen.getByText(/No suggested time yet/)).toBeInTheDocument();
  });

  it('stays silent rather than guessing when the request fails', async () => {
    vi.mocked(fetch).mockImplementation(() => Promise.resolve(new Response('{}', { status: 500 })));

    const { container } = renderPanel();

    await waitFor(() => expect(container.querySelector('.insight-muted')).toBeNull());
    expect(screen.queryByRole('heading', { name: /What’s working/ })).not.toBeInTheDocument();
  });
});
