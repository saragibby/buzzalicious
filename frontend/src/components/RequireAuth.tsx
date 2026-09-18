import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useCurrentUser } from '../lib/useCurrentUser';

/**
 * Route guard.
 *
 * Three states, and conflating any two of them is the usual bug: still loading, signed
 * out, signed in. Rendering `null` while loading avoids the flash of the login page that
 * the prototype's tab-state navigation showed on every refresh.
 *
 * The attempted path is passed to `/login` in location state so sign-in can return the
 * user where they were going.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { data: user, isPending } = useCurrentUser();
  const location = useLocation();

  if (isPending) {
    return <div className="app-loading" role="status" aria-live="polite">Loading…</div>;
  }

  if (!user) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  return <>{children}</>;
}
