import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CaptionPanel } from './CaptionPanel';
import type { Draft } from '../../lib/composerApi';

/**
 * The caption editor.
 *
 * The thing worth protecting here is that the *limit the user is shown is the limit that
 * will be enforced*. A counter reading 270/280 while X rejects the post is worse than no
 * counter, because the user believes it — so the numbers come from `GET /api/platforms`
 * and never from a constant in this bundle. The first test is deliberately built to fail
 * if anyone reintroduces a local table: it serves a limit no platform actually has, and
 * asserts the UI shows *that*.
 */

const SPECS = [
  {
    platform: 'INSTAGRAM',
    label: 'Instagram',
    captionMaxLength: 2200,
    captionLimitVerified: true,
    captionCountUnit: 'codepoints',
    supportedRatios: ['SQUARE_1_1'],
    feedRatios: ['SQUARE_1_1'],
    mediaRequired: true,
    hashtagLimit: 30,
    linkBehavior: 'bio-only',
    linkNote: 'Put the link in your bio and say “link in bio”.',
  },
  {
    platform: 'X',
    label: 'X',
    captionMaxLength: 280,
    captionLimitVerified: true,
    captionCountUnit: 'x-weighted',
    supportedRatios: ['SQUARE_1_1'],
    feedRatios: ['SQUARE_1_1'],
    mediaRequired: false,
    linkBehavior: 'inline',
  },
  {
    platform: 'FACEBOOK',
    label: 'Facebook',
    captionMaxLength: 5000,
    captionLimitVerified: false,
    captionCountUnit: 'codepoints',
    supportedRatios: ['SQUARE_1_1'],
    feedRatios: ['SQUARE_1_1'],
    mediaRequired: false,
    linkBehavior: 'inline',
  },
];

function draft(targets: { platform: string; caption: string | null }[]): Draft {
  return {
    id: 'post-1',
    brandId: 'brand-1',
    title: null,
    templateSlug: 'big-number',
    templateName: 'Big number',
    slotValues: {},
    baseCopy: '',
    status: 'DRAFT',
    targets,
  } as unknown as Draft;
}

function mockSpecs(specs: unknown = SPECS) {
  vi.mocked(fetch).mockResolvedValue(
    new Response(JSON.stringify({ platforms: specs }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

function renderPanel(props: Partial<Parameters<typeof CaptionPanel>[0]> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });

  return render(
    <QueryClientProvider client={queryClient}>
      <CaptionPanel
        draft={draft([{ platform: 'X', caption: null }])}
        baseCopy=""
        onBaseCopyChange={() => undefined}
        onOverrideChange={() => undefined}
        onGenerate={() => undefined}
        generating={false}
        generateError={null}
        {...props}
      />
    </QueryClientProvider>,
  );
}

describe('CaptionPanel', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it('takes the limit from the server, not from a constant in the bundle', async () => {
    // 999 is not any real platform's limit. If this test ever shows 280, someone has
    // reintroduced a local table and the displayed limit has stopped tracking the enforced
    // one.
    mockSpecs([{ ...SPECS[1], captionMaxLength: 999 }]);
    renderPanel({ baseCopy: 'hello' });

    fireEvent.click(await screen.findByRole('tab', { name: /^X/ }));

    await waitFor(() => expect(screen.getByText(/5 \/ 999/)).toBeInTheDocument());
  });

  it('counts the way the selected platform counts', async () => {
    // A URL costs a flat 23 on X. Showing its literal length would tell the user to cut
    // text they did not need to cut.
    mockSpecs();
    renderPanel({
      baseCopy: 'https://example.com/an/extremely/long/booking/path',
      draft: draft([{ platform: 'X', caption: null }]),
    });

    fireEvent.click(await screen.findByRole('tab', { name: /^X/ }));

    await waitFor(() => expect(screen.getByText(/23 \/ 280/)).toBeInTheDocument());
  });

  it('says how much to cut when a caption is over the limit', async () => {
    mockSpecs();
    renderPanel({ baseCopy: 'a'.repeat(300), draft: draft([{ platform: 'X', caption: null }]) });

    fireEvent.click(await screen.findByRole('tab', { name: /^X/ }));

    await waitFor(() => expect(screen.getByText(/20 over/)).toBeInTheDocument());
    expect(screen.getByLabelText('X')).toHaveAttribute('aria-invalid', 'true');
  });

  it('marks an unverified limit as approximate rather than stating it as fact', async () => {
    // Facebook publishes no caption limit. Presenting our conservative figure as theirs
    // would be inventing a number — the docs are explicit about not doing that.
    mockSpecs();
    renderPanel({ baseCopy: 'hi', draft: draft([{ platform: 'FACEBOOK', caption: null }]) });

    fireEvent.click(await screen.findByRole('tab', { name: /^Facebook/ }));

    await waitFor(() => expect(screen.getByText(/\(approximate\)/)).toBeInTheDocument());
  });

  it('does not call a documented limit approximate', async () => {
    // The control for the test above: if everything were labelled approximate, the label
    // would carry no information.
    mockSpecs();
    renderPanel({ baseCopy: 'hi', draft: draft([{ platform: 'X', caption: null }]) });

    fireEvent.click(await screen.findByRole('tab', { name: /^X/ }));

    await waitFor(() => expect(screen.getByText(/2 \/ 280/)).toBeInTheDocument());
    expect(screen.queryByText(/\(approximate\)/)).not.toBeInTheDocument();
  });

  it('warns that an Instagram link will not be clickable', async () => {
    mockSpecs();
    renderPanel({
      baseCopy: 'Book now https://example.com',
      draft: draft([{ platform: 'INSTAGRAM', caption: null }]),
    });

    fireEvent.click(await screen.findByRole('tab', { name: /^Instagram/ }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/not clickable/i));
    expect(screen.getByRole('status')).toHaveTextContent(/link in bio/i);
  });

  it('does not warn about a link on a platform where links work', async () => {
    mockSpecs();
    renderPanel({
      baseCopy: 'Book now https://example.com',
      draft: draft([{ platform: 'X', caption: null }]),
    });

    fireEvent.click(await screen.findByRole('tab', { name: /^X/ }));

    // "Book now " is 9, and the URL a flat 23.
    await waitFor(() => expect(screen.getByText(/32 \/ 280/)).toBeInTheDocument());
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('refuses to check a caption it has no rules for, rather than guessing', async () => {
    // If the spec request fails, silently falling back to some default limit would show a
    // confident number that nothing stands behind.
    mockSpecs([]);
    renderPanel({ baseCopy: 'hi', draft: draft([{ platform: 'X', caption: null }]) });

    fireEvent.click(await screen.findByRole('tab', { name: /^X/ }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/could not be loaded/));
  });

  it('shows which platforms have been edited away from the shared caption', async () => {
    mockSpecs();
    renderPanel({
      baseCopy: 'shared',
      draft: draft([
        { platform: 'X', caption: 'just for X' },
        { platform: 'INSTAGRAM', caption: null },
      ]),
    });

    const edited = await screen.findByTitle('Edited for this platform');
    expect(edited).toBeInTheDocument();
    // Exactly one: the other target still inherits, and marking both would make the dot
    // meaningless.
    expect(screen.getAllByTitle('Edited for this platform')).toHaveLength(1);
  });

  it('reports clearing an override as null, not as an empty string', async () => {
    // `null` means "inherit again"; `''` means "deliberately blank". Collapsing them is
    // how a caption someone cleared comes back at publish time.
    mockSpecs();
    const onOverrideChange = vi.fn();
    renderPanel({
      baseCopy: 'shared',
      draft: draft([{ platform: 'X', caption: 'just for X' }]),
      onOverrideChange,
    });

    fireEvent.click(await screen.findByRole('tab', { name: /^X/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Use the shared caption again/ }));

    expect(onOverrideChange).toHaveBeenCalledWith('X', null);
  });

  it('asks the user to pick a platform rather than showing an empty editor', async () => {
    mockSpecs();
    renderPanel({ draft: draft([]) });

    expect(await screen.findByText(/Pick at least one platform/)).toBeInTheDocument();
  });
});
