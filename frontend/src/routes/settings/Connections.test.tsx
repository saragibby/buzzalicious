import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Connections } from './Connections';

/**
 * These tests are about what the page *tells* a user, not about markup.
 *
 * The screen exists for one moment: a post did not go out and somebody wants to know why.
 * So the assertions are on the sentence that explains the cause and the sentence that
 * names the fix — and on the two things that would be actively harmful, namely leaking a
 * token into the DOM and revoking a credential on a single click.
 */

vi.mock('../../lib/scope', () => ({
  useScope: () => ({
    workspace: { id: 'ws-1', name: 'Acme' },
    brand: { id: 'brand-1', name: 'Rise & Shore' },
  }),
}));

const ACCOUNTS = {
  accounts: [
    {
      id: 'acc-ok',
      platform: 'INSTAGRAM',
      externalId: 'ig-1',
      handle: 'riseandshore',
      displayName: 'Rise & Shore',
      avatarUrl: null,
      status: 'ACTIVE',
      lastError: null,
      lastValidatedAt: new Date().toISOString(),
      expiresAt: null,
      scopes: ['instagram_content_publish'],
      credentialId: 'cred-1',
      credentialLabel: 'Acme Meta app',
      needsAttention: false,
    },
    {
      id: 'acc-dead',
      platform: 'FACEBOOK',
      externalId: 'fb-1',
      handle: null,
      displayName: 'Rise & Shore Page',
      avatarUrl: null,
      status: 'REVOKED',
      lastError: 'Session has been invalidated.',
      lastValidatedAt: null,
      expiresAt: null,
      scopes: [],
      credentialId: 'cred-1',
      credentialLabel: 'Acme Meta app',
      needsAttention: true,
    },
  ],
};

const CREDENTIALS = {
  credentials: [
    {
      id: 'cred-1',
      platform: 'FACEBOOK',
      label: 'Acme Meta app',
      kind: 'CLIENT_APP',
      status: 'ACTIVE',
      brandId: null,
      lastError: null,
      expiresAt: null,
    },
  ],
};

let revokeCalls: { url: string; body: unknown }[] = [];

function mockApi(accounts: unknown = ACCOUNTS, credentials: unknown = CREDENTIALS) {
  vi.mocked(fetch).mockImplementation((input, init) => {
    const url = String(input);
    if (url.includes('/revoke')) {
      revokeCalls.push({ url, body: init?.body });
      return Promise.resolve(
        new Response(
          JSON.stringify({
            revoked: { credentialId: 'cred-1', accountsRevoked: 2, targetsBlocked: 3 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    }
    const body = url.includes('/credentials') ? credentials : accounts;
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter
        initialEntries={['/settings/connections']}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <Connections />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Settings → Connections', () => {
  beforeEach(() => {
    revokeCalls = [];
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => vi.unstubAllGlobals());

  it('leads with the accounts that cannot publish', async () => {
    mockApi();
    renderPage();

    await waitFor(() => expect(screen.getByText(/1 account need attention/)).toBeInTheDocument());
    // The banner has to say the consequence, not just the count. "One account has a
    // problem" does not tell a user their Tuesday post is not going out.
    expect(screen.getByText(/will not go out/)).toBeInTheDocument();
  });

  it('distinguishes a revoked account from an expired one by what the user must do', async () => {
    mockApi();
    renderPage();

    // Both statuses look like "token bad" in the database and need opposite actions: an
    // expired token usually fixes itself on the next sweep, a revoked one never does.
    await waitFor(() => expect(screen.getByText('Access revoked')).toBeInTheDocument());
    expect(screen.getByText(/Reconnect to publish again/)).toBeInTheDocument();
    expect(screen.queryByText(/try to refresh this/)).not.toBeInTheDocument();
  });

  it('tells the user which app an account is publishing through', async () => {
    mockApi();
    renderPage();

    // When four accounts die at once the cause is almost always one credential. Naming it
    // per account is what turns four incidents into one.
    await waitFor(() => expect(screen.getAllByText('Acme Meta app').length).toBeGreaterThan(0));
  });

  it('will not revoke on a single click', async () => {
    mockApi();
    renderPage();

    await waitFor(() => expect(screen.getByRole('button', { name: 'Revoke' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));

    // The first click opens the confirmation, and crucially sends nothing.
    expect(revokeCalls).toHaveLength(0);
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('names the blast radius before revoking', async () => {
    mockApi();
    renderPage();

    await waitFor(() => expect(screen.getByRole('button', { name: 'Revoke' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));

    // Two accounts in the fixture point at this credential. A confirmation that does not
    // say so is a confirmation nobody reads.
    expect(screen.getByRole('alertdialog')).toHaveTextContent('2 accounts');
    expect(screen.getByRole('alertdialog')).toHaveTextContent(/blocks anything already queued/);
  });

  it('revokes and reports what it actually stopped', async () => {
    mockApi();
    renderPage();

    await waitFor(() => expect(screen.getByRole('button', { name: 'Revoke' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, revoke it' }));

    await waitFor(() => expect(revokeCalls).toHaveLength(1));
    expect(revokeCalls[0]!.url).toContain('/api/workspaces/ws-1/credentials/cred-1/revoke');
    await waitFor(() =>
      expect(screen.getByText(/2 accounts marked and 3 queued posts blocked/)).toBeInTheDocument(),
    );
  });

  it('puts no token in the DOM even when the API is careless', async () => {
    // The API is meant to never send one. This asserts the page does not render an
    // unexpected field either, so a future `select` slip does not become a screen leak.
    const leaky = {
      accounts: [
        {
          ...ACCOUNTS.accounts[0],
          accessToken: 'EAAG-super-secret-token',
          refreshToken: 'refresh-super-secret',
        },
      ],
    };
    mockApi(leaky);
    const { container } = renderPage();

    await waitFor(() => expect(screen.getByText('Connected')).toBeInTheDocument());
    expect(container.innerHTML).not.toContain('EAAG-super-secret-token');
    expect(container.innerHTML).not.toContain('refresh-super-secret');
  });

  it('says an unreported expiry is unknown rather than implying it never expires', async () => {
    mockApi();
    renderPage();

    await waitFor(() => expect(screen.getAllByText('not reported').length).toBe(2));
  });
});
