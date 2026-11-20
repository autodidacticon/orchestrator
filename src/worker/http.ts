/**
 * The HTTP client of the remote worker loop and the verifier loop for the daemon's API. A connection failure (no
 * answer at all) is retried for the retry window, as the scripted pull worker and the MCP shim do, so a loop rides
 * through a daemon restart; every answer, whatever its status, is returned to the caller.
 *
 * The client is termination-aware: given the loop's termination signal, the signal aborts the fetch in flight of
 * every call, and those calls are retried with no more than `TERMINATION_CALL_MS` left; a call started after the
 * signal gets the smaller of the retry window and `TERMINATION_CALL_MS`. Every fetch is aborted once its call's
 * remaining window has passed, so a daemon that accepts a connection and never answers cannot hold the loop; the timer
 * of that abort is capped at `MAX_TIMER_MS`, so a retry window of 2^31 ms or more cannot overflow it.
 * See specs/worker-pool "Worker loop" and "Pod termination", and specs/verifier-pool "Verifier termination".
 */

export interface ApiResult {
  status: number;
  body: Record<string, unknown>;
}

export type ApiCall = (method: 'GET' | 'POST', route: string, body?: Record<string, unknown>, token?: string) => Promise<ApiResult>;

/** The longest connection-failure retry of an API call after the termination signal, and the longest wait for a heartbeat in flight. */
export const TERMINATION_CALL_MS = 5_000;
/** The shortest timeout of one fetch before the termination signal: a slow answer near the window's end is still awaited. */
export const MIN_FETCH_MS = TERMINATION_CALL_MS;
/** The shortest timeout of one fetch after the termination signal. */
export const MIN_TERMINATING_FETCH_MS = 1_000;
/**
 * The longest delay `setTimeout` takes (2^31 - 1 ms). A longer one fires after 1 ms with a `TimeoutOverflowWarning`, so
 * the fetch timer is capped here; the retry window itself keeps its configured value.
 */
export const MAX_TIMER_MS = 2 ** 31 - 1;

export interface ApiClientOptions {
  /** The daemon's base URL (`ORCH_API`), without a trailing slash. */
  api: string;
  /** How long connection failures are retried before the call throws. */
  retryWindowMs: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** The loop's termination request (SIGTERM or SIGINT). */
  termination?: AbortSignal;
}

export const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function apiClient(o: ApiClientOptions): ApiCall {
  const doFetch = o.fetch ?? fetch;
  const sleep = o.sleep ?? realSleep;
  const now = o.now ?? Date.now;
  const term = o.termination;
  const base = o.api.replace(/\/+$/, '');
  return async (method, route, body, token) => {
    const terminating = () => term?.aborted === true;
    let deadline = now() + (terminating() ? Math.min(o.retryWindowMs, TERMINATION_CALL_MS) : o.retryWindowMs);
    let attempt: AbortController | undefined;
    // One listener per call: a signal during a retry pause also shortens the call.
    const onTerm = () => {
      deadline = Math.min(deadline, now() + TERMINATION_CALL_MS);
      attempt?.abort(new Error('aborted by the termination request'));
    };
    const listening = term !== undefined && !term.aborted;
    if (listening) term.addEventListener('abort', onTerm, { once: true });
    try {
      let delay = 100;
      for (;;) {
        const ctl = new AbortController();
        attempt = ctl;
        const limit = Math.max(deadline - now(), terminating() ? MIN_TERMINATING_FETCH_MS : MIN_FETCH_MS);
        const timer = setTimeout(() => ctl.abort(new Error(`no answer within ${limit} ms`)), Math.min(limit, MAX_TIMER_MS));
        let res: Response;
        let parsed: unknown;
        try {
          try {
            res = await doFetch(`${base}${route}`, {
              method,
              headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
              body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
              signal: ctl.signal,
            });
            try {
              parsed = await res.json();
            } catch (e) {
              // A body cut off by the signal or the timeout is no answer, not an empty one: the call is retried.
              if (ctl.signal.aborted) throw e;
              parsed = {};
            }
          } catch (err) {
            if (now() + delay > deadline) throw err;
            attempt = undefined;
            await sleep(delay);
            delay = Math.min(delay * 2, 1000);
            continue;
          }
          return { status: res.status, body: parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {} };
        } finally {
          clearTimeout(timer);
        }
      }
    } finally {
      if (listening) term.removeEventListener('abort', onTerm);
    }
  };
}
