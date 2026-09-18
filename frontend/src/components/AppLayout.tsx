import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { logout } from '../lib/api';
import { currentUserQueryKey, useCurrentUser } from '../lib/useCurrentUser';
import { ScopeSwitcher } from './ScopeSwitcher';
import logo from '../logo.png';

const NAV = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/trends', label: 'Trends' },
  { to: '/composer', label: 'Composer' },
  { to: '/calendar', label: 'Calendar' },
  { to: '/insights', label: 'Insights' },
  { to: '/brand', label: 'Brand kit' },
  { to: '/settings', label: 'Settings' },
  // W6. Appended rather than nested under Settings: connections are the thing a user
  // checks when a post did not go out, and burying that behind a settings index adds a
  // click to the one journey that is always urgent.
  { to: '/settings/connections', label: 'Connections' },
] as const;

/**
 * The authenticated shell: navigation plus an outlet.
 *
 * Structure only — W5 owns the real UI. What matters here is that navigation is real
 * routing rather than the prototype's `useState` tab index, so URLs are shareable, the
 * back button works, and a page can be deep-linked after sign-in.
 */
export function AppLayout() {
  const { data: user } = useCurrentUser();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const handleLogout = async () => {
    await logout();
    // Drop cached user data rather than leaving the previous user's data in memory.
    queryClient.clear();
    await queryClient.invalidateQueries({ queryKey: currentUserQueryKey });
    navigate('/login', { replace: true });
  };

  return (
    <div className="app-shell">
      <header className="app-header">
        <img src={logo} alt="Buzzalicious" className="app-logo" />
        <nav className="app-nav">
          {NAV.map((item) => (
            <NavLink key={item.to} to={item.to} end={'end' in item ? item.end : undefined}>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <ScopeSwitcher />
        <div className="app-user">
          {user?.email}
          <button type="button" onClick={() => void handleLogout()}>
            Sign out
          </button>
        </div>
      </header>
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}
