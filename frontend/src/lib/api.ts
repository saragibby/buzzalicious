/**
 * API base URL resolution.
 *
 * Preserved from the prototype because the reasoning is correct and non-obvious:
 *
 * **Vite inlines `import.meta.env` at build time.** On Heroku the frontend is built
 * during the slug compile, before any dyno exists, so a runtime config var genuinely
 * cannot reach it. Falling back to `window.location.origin` is not a workaround — it is
 * the right answer for a single deployable where the API and the SPA share a domain.
 *
 * Locally the two run on different ports, so the origin is wrong and an explicit host is
 * needed. That host is `127.0.0.1`, never `localhost`: they are different cookie origins
 * and different strings for OAuth redirect matching, and mixing them produces a session
 * that appears to work and then silently does not exist.
 * See `docs/reference/platform-quirks.md`.
 */
export function getBackendUrl(): string {
  if (import.meta.env.VITE_API_URL) {
    return import.meta.env.VITE_API_URL;
  }

  const { hostname, origin } = window.location;
  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    return 'http://127.0.0.1:3001';
  }

  return origin;
}

/** The error body shape the API's error handler always returns. */
export interface ApiErrorBody {
  error: { code: string; message: string; requestId?: string; details?: unknown };
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
}

/**
 * The single fetch wrapper.
 *
 * `credentials: 'include'` is set here once. The prototype set it per call site, and a
 * call that forgot it looked fine in development and failed as an unauthenticated
 * request in production.
 */
export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, headers, ...rest } = options;

  const response = await fetch(`${getBackendUrl()}${path}`, {
    ...rest,
    credentials: 'include',
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  if (response.status === 204) {
    return undefined as T;
  }

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const error = (payload as ApiErrorBody | null)?.error;
    throw new ApiError(
      response.status,
      error?.code ?? 'UNKNOWN',
      error?.message ?? response.statusText,
      error?.requestId,
    );
  }

  return payload as T;
}

export interface CurrentUser {
  id: string;
  email: string;
  name: string | null;
  picture: string | null;
}

/** Resolves to `null` when signed out, rather than throwing — that is not an error. */
export async function fetchCurrentUser(): Promise<CurrentUser | null> {
  try {
    return await apiFetch<CurrentUser>('/auth/me');
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      return null;
    }
    throw error;
  }
}

export async function logout(): Promise<void> {
  await apiFetch('/auth/logout', { method: 'POST' });
}

/** Full-page navigation, not a fetch — OAuth needs a browser redirect. */
export function startGoogleSignIn(): void {
  window.location.href = `${getBackendUrl()}/auth/google`;
}
