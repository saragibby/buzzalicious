import type { FetchLike } from './graph.client';

/**
 * A scripted Graph API.
 *
 * Every Meta test runs against this and never against the network. Two reasons, and the
 * second is the serious one:
 *
 * 1. The Meta adapters had to be written and verified before any client handed us an app,
 *    so there was no real credential to test against even in principle.
 * 2. A test suite that *can* reach a social platform will eventually post something. The
 *    repo already had a hole of exactly this shape — the suite was making live billable
 *    OpenAI calls — so the rule here is that the transport is injected and the default
 *    `fetch` is unreachable from a test. `tests/env.ts` forcing fake credentials is the
 *    second layer, not the only one.
 *
 * Requests are recorded so a test can assert on *how* a call was made, not merely that it
 * was. That matters for at least one security property: access tokens must go in the body
 * rather than the query string, and nothing but an inspected request proves it.
 */

export interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
  /** Parsed form body, for convenience. */
  readonly form: Record<string, string>;
}

export interface ScriptedResponse {
  /** Matched against the URL path; the first unconsumed match wins. */
  readonly match: string | RegExp;
  readonly status?: number;
  readonly body: unknown;
  /** Reply with this body repeatedly rather than being consumed. */
  readonly repeat?: boolean;
}

export class FakeGraph {
  readonly requests: RecordedRequest[] = [];
  private readonly script: ScriptedResponse[];

  constructor(script: ScriptedResponse[]) {
    this.script = [...script];
  }

  /** Requests whose URL path contains `fragment`. */
  requestsMatching(fragment: string): RecordedRequest[] {
    return this.requests.filter((request) => request.url.includes(fragment));
  }

  get lastRequest(): RecordedRequest | undefined {
    return this.requests.at(-1);
  }

  readonly fetch: FetchLike = async (url, init) => {
    const form: Record<string, string> = {};
    if (typeof init.body === 'string') {
      for (const [key, value] of new URLSearchParams(init.body)) form[key] = value;
    }

    this.requests.push({
      url,
      method: init.method,
      headers: init.headers,
      body: init.body,
      form,
    });

    const index = this.script.findIndex((entry) =>
      typeof entry.match === 'string' ? url.includes(entry.match) : entry.match.test(url),
    );

    if (index === -1) {
      // Loud on purpose. A silent default response is how a test ends up asserting on
      // behaviour that never actually ran the code path it claims to cover.
      // Not an AppError: this is a *test harness* assertion, not a runtime condition, and
      // wrapping it in a typed API error would let a `catch` in the code under test
      // swallow it and turn a missing script entry into a passing test.
      // eslint-disable-next-line no-restricted-syntax
      throw new Error(`FakeGraph has no scripted response for ${init.method} ${url}`);
    }

    const entry = this.script[index]!;
    if (!entry.repeat) this.script.splice(index, 1);

    const status = entry.status ?? 200;
    return {
      status,
      ok: status >= 200 && status < 300,
      text: async () =>
        typeof entry.body === 'string' ? entry.body : JSON.stringify(entry.body ?? {}),
    };
  };
}

/** A fetch that fails the way a dropped connection does. */
export const networkFailureFetch: FetchLike = async () => {
  throw new TypeError('fetch failed');
};

/** A `sleep` that does not. Container polling would otherwise make tests slow. */
export const instantSleep = async (): Promise<void> => {};
