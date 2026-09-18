import { Navigate, useLocation } from 'react-router-dom';
import { startGoogleSignIn } from '../lib/api';
import { useCurrentUser } from '../lib/useCurrentUser';
import logo from '../logo.png';

/**
 * Sign-in.
 *
 * Google is the only method, as in the prototype. The `from` path carried in location
 * state is preserved so an already-signed-in user landing here is sent on rather than
 * being shown a login form they do not need.
 */
export function Login() {
  const { data: user, isPending } = useCurrentUser();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? '/';

  if (isPending) {
    return (
      <div className="app-loading" role="status" aria-live="polite">
        Loading…
      </div>
    );
  }

  if (user) {
    return <Navigate to={from} replace />;
  }

  const denied = new URLSearchParams(location.search).get('error') === 'denied';

  return (
    <main className="login">
      <img src={logo} alt="Buzzalicious" className="login-logo" />
      <h1>Buzzalicious</h1>
      <p>Social media management for brands.</p>
      {denied && (
        <p className="login-error" role="alert">
          That account is not allowed to sign in.
        </p>
      )}
      <button type="button" onClick={startGoogleSignIn}>
        Continue with Google
      </button>
    </main>
  );
}
