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
import { Calendar, Dashboard, Insights, NotFound, Settings } from './routes/Placeholder';
import { TemplateGallery } from './routes/composer/TemplateGallery';
import { Composer } from './routes/composer/Composer';
import { Connections } from './routes/settings/Connections';

/**
 * The routing shell.
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
            <Route path="calendar" element={<Calendar />} />
            <Route path="insights" element={<Insights />} />
            <Route path="brand" element={<BrandKit />} />
            <Route path="settings" element={<Settings />} />
            {/* W5. The gallery is the entry point and the composer is a draft by id, so
                a half-finished post is a URL someone can bookmark or send to a colleague
                — which a single /composer screen holding its state in memory is not. */}
            <Route path="composer" element={<TemplateGallery />} />
            <Route path="composer/:postId" element={<Composer />} />
            {/* W6. Appended at the end of the route block rather than beside `settings`:
                this file conflicts in every parallel workstream, and an append resolves
                trivially where an insert does not. */}
            <Route path="settings/connections" element={<Connections />} />
          </Route>
          <Route path="/404" element={<NotFound />} />
          <Route path="*" element={<Navigate to="/404" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

export default App;
