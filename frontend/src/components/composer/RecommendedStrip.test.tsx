import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RecommendedStrip } from './RecommendedStrip';
import type { RankedTemplate } from '../../lib/composerApi';

/**
 * The feedback loop's only pixels, and the guardrail that keeps it honest.
 *
 * `docs/06`: the gallery must **never** collapse to recommendations only, because
 * `template acceptance rate` is a success metric and a rate needs alternatives to exist.
 * The strongest version of that guarantee is structural — the grid is not conditional on
 * this component — so the tests here pin the two things that could still break it: this
 * component failing loudly, and this component claiming more than the backend allowed.
 */

const TEMPLATES = [
  { id: 'tpl-1', slug: 'before-after', name: 'Before & after' },
  { id: 'tpl-2', slug: 'listicle', name: 'Five things' },
] as unknown as RankedTemplate[];

function recommendation(overrides: Record<string, unknown> = {}) {
  return {
    archetype: 'BEFORE_AFTER',
    templateIds: ['tpl-1'],
    value: 1.9,
    basis: {
      observed: 2.4,
      observations: 8,
      prior: 1,
      priorSource: 'neutral',
      brandWeight: 8 / 13,
      priorWeight: 5,
    },
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

function mockRecommendations(body: unknown, status = 200) {
  vi.mocked(fetch).mockImplementation(() =>
    Promise.resolve(
      new Response(status === 200 ? JSON.stringify(body) : '{"error":{}}', {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  );
}

function renderStrip() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });

  return render(
    <QueryClientProvider client={queryClient}>
      <RecommendedStrip
        brandId="brand-1"
        templates={TEMPLATES}
        onUse={() => undefined}
        pendingSlug={null}
        isPending={false}
      />
    </QueryClientProvider>,
  );
}

describe('RecommendedStrip', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it('shows the claim the backend authorised, with its multiplier', async () => {
    // The positive control for every silence assertion below. Without it, a component
    // that rendered nothing under all conditions would pass the whole rest of this file.
    mockRecommendations({ archetypes: [recommendation()] });

    renderStrip();

    expect(await screen.findByRole('heading', { name: 'Before After' })).toBeInTheDocument();
    expect(screen.getByText(/2\.4× your average outcome/)).toBeInTheDocument();
  });

  it('never prints the shrunk estimate as if it were measured', async () => {
    // `value` is 1.9 here and `explanation.multiplier` is 2.4 -- deliberately different,
    // so this can tell "rendered the right number" apart from "rendered a number".
    // 1.9 is partly other businesses' data; printing it as this brand's result would be
    // the exact provenance confusion the branded ShrunkScore exists to prevent.
    mockRecommendations({ archetypes: [recommendation()] });

    renderStrip();

    await screen.findByRole('heading', { name: 'Before After' });
    expect(screen.queryByText(/1\.9×/)).not.toBeInTheDocument();
  });

  it('says nothing numeric when the backend withheld a claim', async () => {
    mockRecommendations({
      archetypes: [
        recommendation({
          explanation: {
            kind: 'no-claim',
            multiplier: null,
            category: null,
            sampleSize: 2,
            untried: false,
            selection: 'exploit',
            claimBasis: 'raw-observed',
          },
        }),
      ],
    });

    renderStrip();

    expect(await screen.findByText(/Not enough measured posts yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/×/)).not.toBeInTheDocument();
  });

  it('labels an exploration pick as an experiment rather than a finding', async () => {
    mockRecommendations({
      archetypes: [
        recommendation({
          selection: 'explore',
          templateIds: ['tpl-2'],
          archetype: 'LISTICLE',
          explanation: {
            kind: 'no-claim',
            multiplier: null,
            category: null,
            sampleSize: 0,
            untried: true,
            selection: 'explore',
            claimBasis: 'raw-observed',
          },
        }),
      ],
    });

    renderStrip();

    expect(await screen.findByText('Trying something new')).toBeInTheDocument();
    expect(screen.getByText(/haven't tried Listicle yet/i)).toBeInTheDocument();
  });

  it('disappears rather than erroring when recommendations fail', async () => {
    // The additive guarantee. This component sits above the template grid, so anything it
    // throws takes the entire library down with it -- turning "the loop is unavailable"
    // into "you cannot make a post".
    mockRecommendations(null, 500);

    const { container } = renderStrip();

    await waitFor(() => expect(container.querySelector('.recommend-strip')).toBeNull());
  });

  it('survives a response with no archetypes array at all', async () => {
    mockRecommendations({});

    const { container } = renderStrip();

    await waitFor(() => expect(container.querySelector('.recommend-strip')).toBeNull());
  });

  it('skips a recommendation whose template is not in the visible library', async () => {
    // A filtered gallery can hide the only template carrying an archetype. The card would
    // have nothing to press, so it is omitted rather than rendered dead.
    mockRecommendations({ archetypes: [recommendation({ templateIds: ['tpl-missing'] })] });

    const { container } = renderStrip();

    await waitFor(() => expect(container.querySelector('.recommend-strip')).toBeNull());
  });
});
