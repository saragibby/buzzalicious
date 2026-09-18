import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RequireAuth } from './RequireAuth';

function renderAt(path: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter
        initialEntries={[path]}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <Routes>
          <Route path="/login" element={<div>Login page</div>} />
          <Route
            path="/composer"
            element={
              <RequireAuth>
                <div>Composer page</div>
              </RequireAuth>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('RequireAuth', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('redirects to login when signed out', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: 'no' } }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    renderAt('/composer');

    await waitFor(() => expect(screen.getByText('Login page')).toBeInTheDocument());
    expect(screen.queryByText('Composer page')).not.toBeInTheDocument();
  });

  it('renders the guarded route when signed in', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ id: 'u1', email: 'a@b.com', name: null, picture: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    renderAt('/composer');

    await waitFor(() => expect(screen.getByText('Composer page')).toBeInTheDocument());
  });

  it('shows neither page while the session is still unknown', () => {
    vi.mocked(fetch).mockReturnValue(new Promise(() => {}));

    renderAt('/composer');

    // Treating "loading" as "signed out" is what produces a flash of the login page on
    // every refresh.
    expect(screen.queryByText('Login page')).not.toBeInTheDocument();
    expect(screen.queryByText('Composer page')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('sends credentials with the session check', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ id: 'u1', email: 'a@b.com', name: null, picture: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    renderAt('/composer');

    // Without `credentials: 'include'` the cookie is not sent and every request is
    // anonymous — a bug that only appears once the API is on another origin.
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect(init?.credentials).toBe('include');
  });
});
