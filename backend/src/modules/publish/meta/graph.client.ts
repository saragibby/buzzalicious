import { classifyMetaError } from './meta.errors';

/**
 * The Meta Graph transport.
 *
 * One place that knows the envelope — the version prefix, the `access_token` parameter,
 * the JSON error shape — so the three Meta adapters are about *what to call*, not about
 * HTTP. Facebook, Instagram and Threads are three products on one API, and the alternative
 * is writing the same fetch-and-unwrap three times and fixing every future bug three
 * times.
 *
 * ## Injectable, for the same reason the X adapter's client is
 *
 * The factory is a constructor argument with a real default. Tests pass a fake and the
 * real `fetch` is never reached, which is what lets the Meta work be written and verified
 * before any client has handed us an app — and, more importantly, guarantees the suite
 * cannot make a live call to a social platform even if a credential leaked into the
 * environment. `tests/env.ts` forces fakes as well; neither layer is relied on alone.
 *
 * ## Tokens go in the body, never the query string
 *
 * Access tokens as URL parameters end up in access logs, proxy logs and error trackers.
 * Graph accepts `access_token` as a POST field, so every write sends it there. Reads have
 * no body, so they send it as a header instead, which Graph also accepts.
 */

export const DEFAULT_GRAPH_VERSION = 'v23.0';

export interface GraphRequest {
  readonly path: string;
  readonly method?: 'GET' | 'POST' | 'DELETE';
  readonly accessToken: string;
  /** Query parameters. Never a token. */
  readonly query?: Readonly<Record<string, string | number | undefined>>;
  /** Form body for a write. */
  readonly body?: Readonly<Record<string, string | number | undefined>>;
  /**
   * Skip the `/vNN.N` path segment.
   *
   * The OAuth token endpoints are not versioned, and a versioned URL for them 404s rather
   * than saying anything useful about the credential. Explicit rather than inferred from
   * the path, because "the path happens to start with oauth" is the kind of rule that
   * stops being true.
   */
  readonly unversioned?: boolean;
}

export interface GraphResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly body: unknown;
}

/** The narrow slice of `fetch` this needs. Narrow so a fake is three lines, not thirty. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ status: number; ok: boolean; text: () => Promise<string> }>;

export interface GraphClientOptions {
  readonly version?: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: FetchLike;
}

export class GraphClient {
  private readonly version: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(
    private readonly platform: 'FACEBOOK' | 'INSTAGRAM' | 'THREADS',
    options: GraphClientOptions = {},
  ) {
    this.version = options.version ?? DEFAULT_GRAPH_VERSION;
    // Threads is a separate host from the rest of Graph, which is easy to miss and
    // produces a confusing 404 rather than an auth error when it is wrong.
    this.baseUrl =
      options.baseUrl ??
      (platform === 'THREADS' ? 'https://graph.threads.net' : 'https://graph.facebook.com');
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  }

  /** Issue a request and throw a classified `PlatformError` on anything but success. */
  async call(request: GraphRequest): Promise<unknown> {
    const response = await this.raw(request);

    if (!response.ok) {
      throw classifyMetaError({
        platform: this.platform,
        status: response.status,
        body: response.body,
      });
    }

    return response.body;
  }

  /**
   * Issue a request and return the outcome without throwing.
   *
   * `validate()` needs this: a 400 from a health check is the *answer*, not an exception,
   * and a sweep that threw on every unhealthy account would abort partway through and
   * leave the rest unchecked.
   */
  async raw(request: GraphRequest): Promise<GraphResponse> {
    const method = request.method ?? 'GET';
    const prefix = request.unversioned ? '' : `/${this.version}`;
    const url = new URL(`${this.baseUrl}${prefix}/${request.path.replace(/^\//, '')}`);

    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${request.accessToken}`,
      Accept: 'application/json',
    };

    let body: string | undefined;
    if (method !== 'GET') {
      const form = new URLSearchParams();
      for (const [key, value] of Object.entries(request.body ?? {})) {
        if (value !== undefined) form.set(key, String(value));
      }
      // In the body, not the query string: a token in a URL is a token in every access log
      // between here and Meta.
      form.set('access_token', request.accessToken);
      body = form.toString();
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }

    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await this.fetchImpl(url.toString(), { method, headers, body });
    } catch (cause) {
      // A DNS failure or a dropped socket is transient by nature, and it has no Graph
      // envelope to classify — so it is given one rather than escaping as a raw TypeError
      // that the pipeline would not know how to retry.
      throw classifyMetaError({
        platform: this.platform,
        status: undefined,
        body: { error: { message: describeNetworkFailure(cause), code: 2 } },
        cause,
      });
    }

    const text = await response.text();
    return { status: response.status, ok: response.ok, body: parseJson(text) };
  }
}

function parseJson(text: string): unknown {
  if (text === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    // Graph occasionally answers with an HTML error page — a load balancer 502, typically.
    // Returning the raw text keeps it classifiable by status instead of throwing a
    // `SyntaxError` from inside the transport.
    return { error: { message: text.slice(0, 500) } };
  }
}

function describeNetworkFailure(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return `Could not reach the Graph API: ${message}`;
}
