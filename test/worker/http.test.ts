/**
 * The termination-aware API client shared by the worker and verifier loops (`apiClient`): the call's window before the
 * termination signal, a daemon that holds the connection, the abort and resend of a call in flight at the signal, the
 * short window of a call started after it, and the cap of the fetch timer. See specs/verifier-pool "Verifier
 * termination: bounded calls".
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiClient, MAX_TIMER_MS, MIN_FETCH_MS, MIN_TERMINATING_FETCH_MS, TERMINATION_CALL_MS } from '../../src/worker/http.js';

const API = 'http://daemon.test';

afterEach(() => {
  vi.useRealTimers();
});

/** A fetch that never answers, and rejects once its signal is aborted, as a real fetch to a daemon that holds the connection does. */
const neverAnswers = (init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) return;
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

/** Records each fetch with the fake time it was sent at and answers it with `handler(n, init)`, `n` counting from 1. */
function recorder(handler: (n: number, init?: RequestInit) => Promise<Response>) {
  const sent: number[] = [];
  const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
    sent.push(Date.now());
    return handler(sent.length, init);
  }) as typeof fetch;
  return { fetchFn, sent };
}

/** Starts a call and records when it settles, on fake time. */
function track(p: Promise<unknown>) {
  const r: { settled?: number; value?: unknown; error?: unknown } = {};
  p.then(
    (v) => ((r.value = v), (r.settled = Date.now())),
    (e) => ((r.error = e), (r.settled = Date.now())),
  );
  return r;
}

const flush = () => new Promise<void>((r) => setImmediate(r));

/** Advances fake time in 100 ms steps until `done()` or `maxMs` has passed. */
async function advanceUntil(done: () => boolean, maxMs: number) {
  for (let i = 0; i < maxMs && !done(); i += 100) await vi.advanceTimersByTimeAsync(100);
  for (let i = 0; i < 20 && !done(); i++) await flush();
}

const fakeTimers = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: 1_000_000 });

describe('apiClient', () => {
  it('before the signal, a call keeps its whole retry window: connection failures are retried for 60000 ms, not 5000', async () => {
    fakeTimers();
    const start = Date.now();
    const d = recorder(async () => {
      throw new TypeError('fetch failed');
    });
    const term = new AbortController();
    const r = track(apiClient({ api: API, retryWindowMs: 60_000, fetch: d.fetchFn, termination: term.signal })('POST', '/v1/x', {}));
    await advanceUntil(() => r.settled !== undefined, 70_000);
    expect(r.error).toBeInstanceOf(TypeError);
    // Still retrying well past TERMINATION_CALL_MS, and never past the window.
    expect(d.sent.at(-1)! - start).toBeGreaterThan(55_000);
    expect(r.settled! - start).toBeLessThanOrEqual(60_000);
    expect(r.settled! - start).toBeGreaterThan(59_000);
  });

  it('a daemon that holds the connection ends the call when the window runs out, with a 5000 ms floor', async () => {
    fakeTimers();
    // A 60000 ms window: the one fetch is aborted at 60000 ms and the call throws.
    let start = Date.now();
    let d = recorder((_n, init) => neverAnswers(init));
    let r = track(apiClient({ api: API, retryWindowMs: 60_000, fetch: d.fetchFn })('GET', '/v1/status'));
    await advanceUntil(() => r.settled !== undefined, 70_000);
    expect(r.error).toBeInstanceOf(Error);
    expect(String((r.error as Error).message)).toBe('no answer within 60000 ms');
    expect(d.sent).toHaveLength(1);
    expect(r.settled! - start).toBe(60_000);

    // A 2000 ms window: the fetch still gets MIN_FETCH_MS (5000 ms), so a slow answer near the window's end is awaited.
    start = Date.now();
    d = recorder((_n, init) => neverAnswers(init));
    r = track(apiClient({ api: API, retryWindowMs: 2000, fetch: d.fetchFn })('GET', '/v1/status'));
    await advanceUntil(() => r.settled !== undefined, 10_000);
    expect(String((r.error as Error).message)).toBe(`no answer within ${MIN_FETCH_MS} ms`);
    expect(d.sent).toHaveLength(1);
    expect(r.settled! - start).toBe(MIN_FETCH_MS);
  });

  it('after the signal, a call in flight is aborted and sent again within the short window', async () => {
    fakeTimers();
    const term = new AbortController();
    // The first post is held and aborted by the signal; the one sent again is answered.
    let d = recorder(async (n, init) => (n === 1 ? neverAnswers(init) : new Response(JSON.stringify({ ok: true }), { status: 200 })));
    let r = track(apiClient({ api: API, retryWindowMs: 60_000, fetch: d.fetchFn, termination: term.signal })('POST', '/v1/verify/j/result', { outcome: 'verified' }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(d.sent).toHaveLength(1);
    let signalAt = Date.now();
    term.abort();
    await advanceUntil(() => r.settled !== undefined, 10_000);
    expect(r.value).toEqual({ status: 200, body: { ok: true } });
    expect(d.sent).toHaveLength(2);
    expect(d.sent[1]! - signalAt).toBeLessThanOrEqual(1000);

    // Nothing answers: the call ends within TERMINATION_CALL_MS plus the 1000 ms floor of a fetch after the signal,
    // although its retry window is 60000 ms.
    const term2 = new AbortController();
    d = recorder((_n, init) => neverAnswers(init));
    r = track(apiClient({ api: API, retryWindowMs: 60_000, fetch: d.fetchFn, termination: term2.signal })('POST', '/v1/verify/j/result', {}));
    await vi.advanceTimersByTimeAsync(1000);
    signalAt = Date.now();
    term2.abort();
    await advanceUntil(() => r.settled !== undefined, 20_000);
    expect(r.error).toBeInstanceOf(Error);
    expect(d.sent.length).toBeGreaterThan(1);
    expect(r.settled! - signalAt).toBeGreaterThanOrEqual(TERMINATION_CALL_MS);
    expect(r.settled! - signalAt).toBeLessThanOrEqual(TERMINATION_CALL_MS + MIN_TERMINATING_FETCH_MS);
  });

  it('a call started after the signal gets the short window: the smaller of the retry window and TERMINATION_CALL_MS', async () => {
    fakeTimers();
    const term = new AbortController();
    term.abort();
    // A held connection is given up after TERMINATION_CALL_MS, not the 60000 ms window.
    let start = Date.now();
    let d = recorder((_n, init) => neverAnswers(init));
    let r = track(apiClient({ api: API, retryWindowMs: 60_000, fetch: d.fetchFn, termination: term.signal })('POST', '/v1/verify/j/release', {}));
    await advanceUntil(() => r.settled !== undefined, 70_000);
    expect(String((r.error as Error).message)).toBe(`no answer within ${TERMINATION_CALL_MS} ms`);
    expect(r.settled! - start).toBe(TERMINATION_CALL_MS);

    // Connection failures are retried for at most TERMINATION_CALL_MS.
    start = Date.now();
    d = recorder(async () => {
      throw new TypeError('fetch failed');
    });
    r = track(apiClient({ api: API, retryWindowMs: 60_000, fetch: d.fetchFn, termination: term.signal })('POST', '/v1/verify/j/release', {}));
    await advanceUntil(() => r.settled !== undefined, 70_000);
    expect(r.error).toBeInstanceOf(TypeError);
    expect(d.sent.length).toBeGreaterThan(1);
    expect(r.settled! - start).toBeLessThanOrEqual(TERMINATION_CALL_MS);

    // A retry window below TERMINATION_CALL_MS is kept.
    start = Date.now();
    d = recorder(async () => {
      throw new TypeError('fetch failed');
    });
    r = track(apiClient({ api: API, retryWindowMs: 2000, fetch: d.fetchFn, termination: term.signal })('POST', '/v1/verify/j/release', {}));
    await advanceUntil(() => r.settled !== undefined, 70_000);
    expect(r.settled! - start).toBeLessThanOrEqual(2000);
  });

  it('with a retry window of 3e9 ms and a daemon that answers in 50 ms, the first answer is returned after one fetch and no TimeoutOverflowWarning', async () => {
    const warnings: Error[] = [];
    const onWarning = (w: Error) => void warnings.push(w);
    process.on('warning', onWarning);
    try {
      let fetches = 0;
      const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
        fetches++;
        return new Promise<Response>((resolve, reject) => {
          const t = setTimeout(() => resolve(new Response(JSON.stringify({ ok: true, n: fetches }), { status: 200 })), 50);
          init?.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(t);
              reject(init.signal!.reason);
            },
            { once: true },
          );
        });
      }) as typeof fetch;
      // An overflowed timer aborts every fetch after 1 ms and the call never ends: give up after 2000 ms.
      let giveUp: ReturnType<typeof setTimeout> | undefined;
      const res = await Promise.race([
        apiClient({ api: API, retryWindowMs: 3e9, fetch: fetchFn })('GET', '/v1/status'),
        new Promise((r) => (giveUp = setTimeout(() => r('no answer within 2000 ms'), 2000))),
      ]);
      clearTimeout(giveUp);
      // Let a warning emitted on process.nextTick arrive.
      await new Promise((r) => setTimeout(r, 20));
      expect(res).toEqual({ status: 200, body: { ok: true, n: 1 } });
      expect(fetches).toBe(1);
      expect(warnings.filter((w) => w.name === 'TimeoutOverflowWarning')).toEqual([]);
      expect(MAX_TIMER_MS).toBe(2 ** 31 - 1);
    } finally {
      process.off('warning', onWarning);
    }
  });
});
