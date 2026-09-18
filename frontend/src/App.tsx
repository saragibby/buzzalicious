import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppLayout } from './components/AppLayout';
import { RequireAuth } from './components/RequireAuth';
import { ScopeProvider } from './lib/ScopeProvider';
import { BrandKit } from './routes/BrandKit';
import { Login } from './routes/Login';
import { TrendFeed } from './routes/trends/TrendFeed';
import { TrendCurate } from './routes/trends/TrendCurate';
import { UsageAdmin } from './routes/admin/UsageAdmin';
import { Calendar, Composer, Dashboard, Insights, NotFound, Settings } from './routes/Placeholder';

/**
 * The routing shell. Structure only — W5 builds the real UI.
 *
 * This replaces the prototype's `useState` tab index, which meant no URL was shareable,
 * the back button did nothing, and a refresh always dropped the user on tab zero.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // The API is the source of truth and a refetch is cheap; refetching on every window
      // focus is not, and it makes rate limits harder to reason about.
      refetchOnWindowFocus: false,
      staleTime: 30_000,
      retry: 1,
    },
  },
});

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      {/* Opt in to the v7 behaviours now so the eventual upgrade is not a behaviour change. */}
      <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route
            element={
              <RequireAuth>
                {/* Inside RequireAuth: the scope queries are authenticated, and fetching
                    them for a signed-out visitor is a guaranteed 401 on every page load. */}
                <ScopeProvider>
                  <AppLayout />
                </ScopeProvider>
              </RequireAuth>
            }
          >
            <Route index element={<Dashboard />} />
            {/* W9 */}
            <Route path="trends" element={<TrendFeed />} />
            <Route path="trends/curate" element={<TrendCurate />} />
            {/* W10. Not in the nav: it is a platform-admin surface, gated server-side by
                PLATFORM_ADMIN_EMAILS, and a link everyone can see but nobody can open is
                worse than no link. */}
            <Route path="admin/usage" element={<UsageAdmin />} />
            <Route path="composer" element={<Composer />} />
            <Route path="calendar" element={<Calendar />} />
            <Route path="insights" element={<Insights />} />
            <Route path="brand" element={<BrandKit />} />
            <Route path="settings" element={<Settings />} />
          </Route>
          <Route path="/404" element={<NotFound />} />
          <Route path="*" element={<Navigate to="/404" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

export default App;
