/**
 * The remote worker's HTTP client for the daemon's API. A connection failure (no answer at all) is retried for the
 * retry window, as the scripted pull worker and the MCP shim do, so a worker rides through a daemon restart; every
 * answer, whatever its status, is returned to the caller. See specs/worker-pool "Worker loop".
 */

export interface ApiResult {
  status: number;
  body: Record<string, unknown>;
}

export type ApiCall = (method: 'GET' | 'POST', route: string, body?: Record<string, unknown>, token?: string) => Promise<ApiResult>;

export interface ApiClientOptions {
  /** The daemon's base URL (`ORCH_API`), without a trailing slash. */
  api: string;
  /** How long connection failures are retried before the call throws. */
  retryWindowMs: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function apiClient(o: ApiClientOptions): ApiCall {
  const doFetch = o.fetch ?? fetch;
  const sleep = o.sleep ?? realSleep;
  const now = o.now ?? Date.now;
  const base = o.api.replace(/\/+$/, '');
  return async (method, route, body, token) => {
    const deadline = now() + o.retryWindowMs;
    let delay = 100;
    for (;;) {
      let res: Response;
      try {
        res = await doFetch(`${base}${route}`, {
          method,
          headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
          body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
        });
      } catch (err) {
        if (now() + delay > deadline) throw err;
        await sleep(delay);
        delay = Math.min(delay * 2, 1000);
        continue;
      }
      let parsed: unknown;
      try {
        parsed = await res.json();
      } catch {
        parsed = {};
      }
      return { status: res.status, body: parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {} };
    }
  };
}
