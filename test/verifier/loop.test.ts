/**
 * The verifier loop (`orchestrator-verifier`) against a fake daemon on a fake clock, with a stand-in job: its settings,
 * the sweep at start, the waits and exits, the claim answers, the heartbeat, the result answers, the releases and the
 * termination. See specs/verifier-pool "Verifier loop", "Verifier heartbeat", "Verifier result post" and
 * "Verifier termination".
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VerifyClaim, VerifyResultBody, WorkOptions } from '../../src/verifier/job.js';
import { DEFAULT_VERIFIER_CACHE, RESULT_RETRY_MS, runVerifierLoop, USAGE, VERIFIER_ERROR, type VerifierSettings, verifierSettings } from '../../src/verifier/loop.js';
import { TERMINATION_CALL_MS } from '../../src/worker/http.js';

const API = 'http://daemon.test';
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function settings(over: Partial<VerifierSettings> = {}): VerifierSettings {
  const cache = mkdtempSync(path.join(tmpdir(), 'orch-verifier-loop-'));
  dirs.push(cache);
  return { api: API, verifierId: 'v-1', cache, idleExitMs: 0, maxJobs: 0, backoffMs: 1000, backoffMaxMs: 30_000, retryWindowMs: 1000, ...over };
}

interface Call {
  method: string;
  route: string;
  body: Record<string, unknown> | undefined;
  auth: string | undefined;
}
type Answer = { status: number; body?: Record<string, unknown> } | 'throw';

/**
 * A fake daemon: records each call and answers it with `handler(call, n)`, `n` counting the calls to that route. Like a
 * real fetch, the call honors its `AbortSignal`: one aborted before its answer rejects with the signal's reason, so the
 * client sends it again (the termination signal aborts every fetch in flight).
 */
function fakeDaemon(handler: (c: Call, n: number) => Answer | Promise<Answer>) {
  const calls: Call[] = [];
  const counts = new Map<string, number>();
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const route = String(url).replace(API, '');
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const c: Call = { method: init?.method ?? 'GET', route, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined, auth: headers['authorization'] };
    calls.push(c);
    const n = (counts.get(route) ?? 0) + 1;
    counts.set(route, n);
    const signal = init?.signal;
    if (signal?.aborted) throw signal.reason;
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal!.reason);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    aborted.catch(() => {});
    let a: Answer;
    try {
      a = await Promise.race([Promise.resolve(handler(c, n)), aborted]);
    } finally {
      signal?.removeEventListener('abort', onAbort!);
    }
    if (a === 'throw') throw new TypeError('fetch failed');
    return new Response(JSON.stringify(a.body ?? {}), { status: a.status });
  }) as typeof fetch;
  const to = (suffix: string) => calls.filter((c) => c.route.endsWith(suffix));
  return { fetchFn, calls, claims: () => to('/v1/verify/claims'), results: () => to('/result'), releases: () => to('/release'), heartbeats: () => to('/heartbeat') };
}

/** A fake clock: `sleep` records the delay and advances `now` at once. */
function fakeClock() {
  let t = 1_000_000;
  const delays: number[] = [];
  return { now: () => t, sleep: async (ms: number) => void (delays.push(ms), (t += ms)), delays };
}

/** A fake heartbeat timer: records each delay; the test fires the oldest pending one. */
function fakeSchedule() {
  const pending: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  const all: number[] = [];
  return {
    schedule: (fn: () => void, ms: number) => {
      const e = { fn, ms, cancelled: false };
      pending.push(e);
      all.push(ms);
      return () => {
        e.cancelled = true;
      };
    },
    live: () => pending.filter((e) => !e.cancelled),
    fire: () => {
      const e = pending.find((x) => !x.cancelled);
      if (!e) throw new Error('nothing scheduled');
      e.cancelled = true;
      e.fn();
    },
    all,
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const flush = () => new Promise<void>((r) => setImmediate(r));
async function until(pred: () => boolean, what = 'condition'): Promise<void> {
  for (let i = 0; i < 2000; i++) {
    if (pred()) return;
    await flush();
  }
  throw new Error(`timed out waiting for ${what}`);
}

const claimBody = (jobId = 'job-1', over: Record<string, unknown> = {}) => ({
  ok: true,
  repeated: false,
  jobId,
  token: `tok-${jobId}`,
  taskId: 'T1',
  repoUrl: '/nowhere/origin.git',
  expectedHead: 'a'.repeat(40),
  sealedSha: 'b'.repeat(40),
  baseSha: 'c'.repeat(40),
  noChanges: false,
  checkCommand: 'true',
  checkTimeoutMs: 900_000,
  leaseTtlMs: 60_000,
  lease: { ttlMs: 60_000, expiresAt: 0, renewEveryMs: 20_000 },
  ...over,
});
const VERIFIED: VerifyResultBody = { outcome: 'verified', rebasedSha: 'd'.repeat(40) };

/** A stand-in job that waits on its signal and answers undefined once it is aborted. */
const waitsOnSignal = (seen: AbortSignal[]) => (_c: VerifyClaim, o: WorkOptions) =>
  new Promise<VerifyResultBody | undefined>((resolve) => {
    seen.push(o.signal!);
    o.signal!.addEventListener('abort', () => resolve(undefined), { once: true });
  });

const has = (out: string[], event: string) => out.filter((l) => l.split(' ')[2] === event);

describe('verifier loop settings', () => {
  it('requires ORCH_API, takes the id from POD_NAME, else ORCH_VERIFIER_ID, else the host name, and applies the defaults', () => {
    expect(() => verifierSettings({})).toThrow(/ORCH_API/);
    const base = { ORCH_API: 'http://d:8080/' };
    expect(verifierSettings({ ...base, POD_NAME: 'pod-a', ORCH_VERIFIER_ID: 'id-b' }, () => 'host-c').verifierId).toBe('pod-a');
    expect(verifierSettings({ ...base, POD_NAME: '', ORCH_VERIFIER_ID: 'id-b' }, () => 'host-c').verifierId).toBe('id-b');
    expect(verifierSettings({ ...base, POD_NAME: '' }, () => 'host-c').verifierId).toBe('host-c');
    expect(verifierSettings(base, () => 'h')).toEqual({
      api: 'http://d:8080',
      verifierId: 'h',
      cache: '/var/cache/orchestrator',
      idleExitMs: 0,
      maxJobs: 0,
      backoffMs: 1000,
      backoffMaxMs: 30_000,
      retryWindowMs: 60_000,
    });
    expect(DEFAULT_VERIFIER_CACHE).toBe('/var/cache/orchestrator');
  });

  it('refuses a number variable that is not a non-negative integer, naming it, and USAGE names every variable', () => {
    expect(() => verifierSettings({ ORCH_API: 'http://d', ORCH_VERIFIER_MAX_JOBS: '-1' })).toThrow(/ORCH_VERIFIER_MAX_JOBS/);
    expect(() => verifierSettings({ ORCH_API: 'http://d', ORCH_VERIFIER_BACKOFF_MS: 'soon' })).toThrow(/ORCH_VERIFIER_BACKOFF_MS/);
    expect(verifierSettings({ ORCH_API: 'http://d', ORCH_VERIFIER_CACHE: '/c', ORCH_VERIFIER_IDLE_EXIT_MS: '5', ORCH_VERIFIER_MAX_JOBS: '2', ORCH_VERIFIER_BACKOFF_MAX_MS: '2000', ORCH_RETRY_WINDOW_MS: '7' }, () => 'h')).toMatchObject({
      cache: '/c',
      idleExitMs: 5,
      maxJobs: 2,
      backoffMaxMs: 2000,
      retryWindowMs: 7,
    });
    for (const v of ['ORCH_API', 'POD_NAME', 'ORCH_VERIFIER_ID', 'ORCH_VERIFIER_CACHE', 'ORCH_VERIFIER_IDLE_EXIT_MS', 'ORCH_VERIFIER_MAX_JOBS', 'ORCH_VERIFIER_BACKOFF_MS', 'ORCH_VERIFIER_BACKOFF_MAX_MS', 'ORCH_RETRY_WINDOW_MS']) {
      expect(USAGE, v).toContain(v);
    }
    expect(USAGE).toContain('orchestrator-verifier');
  });
});

describe('verifier loop: sweep at start', () => {
  it('removes every directory under <cache>/verify/ before its first claim', async () => {
    const s = settings();
    mkdirSync(path.join(s.cache, 'verify', 'stale', 'sub'), { recursive: true });
    let staleAtClaim: boolean | undefined;
    const d = fakeDaemon(() => {
      staleAtClaim ??= existsSync(path.join(s.cache, 'verify', 'stale'));
      return { status: 400, body: { error: 'verifierId is required' } };
    });
    const clock = fakeClock();
    expect(await runVerifierLoop(s, { fetch: d.fetchFn, ...clock, out: () => {}, err: () => {} })).toBe(1);
    expect(staleAtClaim).toBe(false);
  });
});

describe('verifier loop: waits and exits', () => {
  it('waits 1, 2, 4, 8, 16 and then 30 s between 404 claims, exits 0 with idle-exit, never reads /v1/status, and claims with { verifierId } and no credential', async () => {
    const d = fakeDaemon(() => ({ status: 404, body: { error: 'nothing to verify' } }));
    const clock = fakeClock();
    const out: string[] = [];
    expect(await runVerifierLoop(settings({ idleExitMs: 120_000 }), { fetch: d.fetchFn, ...clock, out: (l) => void out.push(l), err: () => {} })).toBe(0);
    expect(clock.delays).toEqual([1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000]);
    expect(out.at(-1)).toBe('verifier v-1 idle-exit - -');
    expect(d.calls.filter((c) => c.route === '/v1/status')).toEqual([]);
    expect(d.claims()).toHaveLength(9);
    for (const c of d.claims()) {
      expect(c.body).toEqual({ verifierId: 'v-1' });
      expect(c.auth).toBeUndefined();
    }
  });

  it('with maxJobs 1 exits 0 with max-jobs after one job and makes no further claim', async () => {
    const d = fakeDaemon((c) => (c.route === '/v1/verify/claims' ? { status: 200, body: claimBody() } : { status: 200, body: { ok: true } }));
    const out: string[] = [];
    const code = await runVerifierLoop(settings({ maxJobs: 1 }), { fetch: d.fetchFn, ...fakeClock(), schedule: fakeSchedule().schedule, out: (l) => void out.push(l), err: () => {}, work: async () => VERIFIED });
    expect(code).toBe(0);
    expect(out.at(-1)).toBe('verifier v-1 max-jobs - -');
    expect(d.claims()).toHaveLength(1);
    expect(out).toEqual(['verifier v-1 start - -', 'verifier v-1 claimed job-1 T1', 'verifier v-1 verified job-1 T1', 'verifier v-1 max-jobs - -']);
  });
});

describe('verifier loop: claim answers', () => {
  it('a claim answered 400 returns 1 with a claim-refused line', async () => {
    const d = fakeDaemon(() => ({ status: 400, body: { error: 'verifierId is required' } }));
    const out: string[] = [];
    const err: string[] = [];
    expect(await runVerifierLoop(settings(), { fetch: d.fetchFn, ...fakeClock(), out: (l) => void out.push(l), err: (t) => void err.push(t) })).toBe(1);
    expect(has(out, 'claim-refused')).toEqual(['verifier v-1 claim-refused - -']);
    expect(err.join('')).toContain('verifierId is required');
  });

  it('claims answered 409, 409 and 503 print one claim-refused line, and each is followed by a wait and another claim', async () => {
    const term = new AbortController();
    const answers: Answer[] = [{ status: 409, body: { reason: 'no repository URL' } }, { status: 409 }, { status: 503 }];
    const d = fakeDaemon((_c, n) => {
      if (n <= 3) return answers[n - 1]!;
      term.abort();
      return { status: 404 };
    });
    const clock = fakeClock();
    const out: string[] = [];
    expect(await runVerifierLoop(settings(), { fetch: d.fetchFn, ...clock, out: (l) => void out.push(l), err: () => {}, termination: term.signal })).toBe(0);
    expect(has(out, 'claim-refused')).toHaveLength(1);
    expect(clock.delays).toEqual([1000, 2000, 4000]);
    expect(d.claims()).toHaveLength(4);
  });

  it('a claim that gets no answer within the retry window is followed by a wait and another claim; the loop does not return', async () => {
    const term = new AbortController();
    let attempts = 0;
    const d = fakeDaemon(() => {
      attempts++;
      if (attempts <= 4) return 'throw';
      term.abort();
      return { status: 404 };
    });
    const clock = fakeClock();
    const err: string[] = [];
    const out: string[] = [];
    // The retry window is 1000 ms: the client retries after 100, 200 and 400 ms and then gives up on the claim.
    expect(await runVerifierLoop(settings({ retryWindowMs: 1000 }), { fetch: d.fetchFn, ...clock, out: (l) => void out.push(l), err: (t) => void err.push(t), termination: term.signal })).toBe(0);
    expect(clock.delays).toEqual([100, 200, 400, 1000]);
    expect(attempts).toBe(5);
    expect(err.join('')).toContain('claim: no answer');
    // It returned only because the test raised the termination at the next claim.
    expect(has(out, 'terminating')).toHaveLength(1);
  });
});

describe('verifier loop: heartbeat', () => {
  it('heartbeats every lease.renewEveryMs with the job token, each after the answer to the one before, and none after the result is answered', async () => {
    const sched = fakeSchedule();
    const job = deferred<VerifyResultBody | undefined>();
    let started = false;
    let held: ReturnType<typeof deferred<Answer>> | undefined;
    const d = fakeDaemon((c) => {
      if (c.route === '/v1/verify/claims') return { status: 200, body: claimBody() };
      if (c.route.endsWith('/heartbeat')) {
        held = deferred<Answer>();
        return held.promise;
      }
      return { status: 200, body: { ok: true } };
    });
    const out: string[] = [];
    const loop = runVerifierLoop(settings({ maxJobs: 1 }), {
      fetch: d.fetchFn,
      ...fakeClock(),
      schedule: sched.schedule,
      out: (l) => void out.push(l),
      err: () => {},
      work: () => {
        started = true;
        return job.promise;
      },
    });
    await until(() => started, 'the job');
    for (let i = 1; i <= 3; i++) {
      expect(sched.live()).toHaveLength(1);
      sched.fire();
      await until(() => d.heartbeats().length === i, `heartbeat ${i}`);
      // Not scheduled again until the heartbeat is answered.
      await flush();
      expect(sched.live()).toHaveLength(0);
      held!.resolve({ status: 200, body: { ok: true } });
      await until(() => sched.live().length === 1, `the next heartbeat after ${i}`);
    }
    job.resolve(VERIFIED);
    expect(await loop).toBe(0);
    expect(sched.all).toEqual([20_000, 20_000, 20_000, 20_000]);
    expect(sched.live()).toHaveLength(0);
    expect(d.heartbeats()).toHaveLength(3);
    for (const h of d.heartbeats()) {
      expect(h.route).toBe('/v1/verify/job-1/heartbeat');
      expect(h.auth).toBe('Bearer tok-job-1');
    }
    // The result is the last call: no heartbeat follows its answer.
    expect(d.calls.at(-1)!.route).toBe('/v1/verify/job-1/result');
    expect(has(out, 'verified')).toHaveLength(1);
  });

  it('a heartbeat answered 401 aborts the job; no result and no release are posted, lease-lost is printed, and one delay passes before the next claim', async () => {
    const sched = fakeSchedule();
    const term = new AbortController();
    const signals: AbortSignal[] = [];
    const d = fakeDaemon((c, n) => {
      if (c.route === '/v1/verify/claims') {
        if (n === 1) return { status: 200, body: claimBody() };
        term.abort();
        return { status: 404 };
      }
      if (c.route.endsWith('/heartbeat')) return { status: 401, body: { error: 'unauthorized' } };
      return { status: 200, body: { ok: true } };
    });
    const clock = fakeClock();
    const out: string[] = [];
    const loop = runVerifierLoop(settings(), { fetch: d.fetchFn, ...clock, schedule: sched.schedule, out: (l) => void out.push(l), err: () => {}, work: waitsOnSignal(signals), termination: term.signal });
    await until(() => signals.length === 1, 'the job');
    sched.fire();
    expect(await loop).toBe(0);
    expect(signals[0]!.aborted).toBe(true);
    expect(d.results()).toEqual([]);
    expect(d.releases()).toEqual([]);
    expect(has(out, 'lease-lost')).toEqual(['verifier v-1 lease-lost job-1 T1']);
    expect(clock.delays).toEqual([1000]);
    expect(d.claims()).toHaveLength(2);
  });
});

describe('verifier loop: results and releases', () => {
  /** One job whose stand-in answers `result`, its result post answered by `answers` in turn; the second claim ends the loop. */
  async function oneJob(answers: Answer[], work: (c: VerifyClaim, o: WorkOptions) => Promise<VerifyResultBody | undefined> = async () => VERIFIED, jobs = 1) {
    const term = new AbortController();
    const d = fakeDaemon((c, n) => {
      if (c.route === '/v1/verify/claims') {
        if (n <= jobs) return { status: 200, body: claimBody(`job-${n}`) };
        term.abort();
        return { status: 404 };
      }
      if (c.route.endsWith('/result')) return answers.shift() ?? { status: 500 };
      return { status: 200, body: { ok: true } };
    });
    const clock = fakeClock();
    const out: string[] = [];
    const code = await runVerifierLoop(settings({ retryWindowMs: 60_000 }), { fetch: d.fetchFn, ...clock, schedule: fakeSchedule().schedule, out: (l) => void out.push(l), err: () => {}, work, termination: term.signal });
    return { code, d, out, delays: clock.delays };
  }

  it('a result answered 200 prints the outcome line, and the next claim follows at once', async () => {
    const r = await oneJob([{ status: 200, body: { ok: true } }]);
    expect(r.code).toBe(0);
    expect(has(r.out, 'verified')).toEqual(['verifier v-1 verified job-1 T1']);
    expect(r.d.results()[0]).toMatchObject({ route: '/v1/verify/job-1/result', auth: 'Bearer tok-job-1', body: VERIFIED });
    expect(r.delays).toEqual([]);
    expect(r.d.claims()).toHaveLength(2);
    expect(r.d.releases()).toEqual([]);
  });

  it('a result answered 401 prints lease-lost, posts no release, and waits one delay', async () => {
    const r = await oneJob([{ status: 401 }]);
    expect(has(r.out, 'lease-lost')).toHaveLength(1);
    expect(has(r.out, 'verified')).toEqual([]);
    expect(r.d.releases()).toEqual([]);
    expect(r.delays).toEqual([1000]);
  });

  it('a result answered 400 prints result-refused and posts one release with the job token and reason verifierError', async () => {
    const r = await oneJob([{ status: 400, body: { error: 'rebasedSha is required', field: 'rebasedSha' } }]);
    expect(has(r.out, 'result-refused')).toHaveLength(1);
    expect(r.d.releases()).toEqual([{ method: 'POST', route: '/v1/verify/job-1/release', body: { reason: VERIFIER_ERROR }, auth: 'Bearer tok-job-1' }]);
    expect(has(r.out, 'released')).toHaveLength(1);
    expect(r.delays).toEqual([1000]);
  });

  it('a result answered 503 twice and then 200 is posted three times, one second apart, and prints the outcome line once', async () => {
    const r = await oneJob([{ status: 503 }, { status: 503 }, { status: 200, body: { ok: true } }]);
    expect(r.d.results()).toHaveLength(3);
    expect(r.delays).toEqual([1000, 1000]);
    expect(has(r.out, 'verified')).toHaveLength(1);
    expect(r.d.releases()).toEqual([]);
  });

  it('two jobs in a row that throw post no result, each posts one release with verifierError, and are followed by waits of 1 and 2 s', async () => {
    const r = await oneJob(
      [],
      async () => {
        throw new Error('ENOSPC: no space left on device');
      },
      2,
    );
    expect(r.d.results()).toEqual([]);
    expect(r.d.releases().map((c) => [c.route, c.body, c.auth])).toEqual([
      ['/v1/verify/job-1/release', { reason: VERIFIER_ERROR }, 'Bearer tok-job-1'],
      ['/v1/verify/job-2/release', { reason: VERIFIER_ERROR }, 'Bearer tok-job-2'],
    ]);
    expect(r.delays).toEqual([1000, 2000]);
  });

  it('a claim answer without a field is an error of the loop: no job runs, and the job is released with verifierError', async () => {
    let ran = false;
    const term = new AbortController();
    const d = fakeDaemon((c, n) => {
      if (c.route === '/v1/verify/claims') {
        if (n === 1) return { status: 200, body: claimBody('job-1', { checkCommand: undefined }) };
        if (n === 2) return { status: 200, body: claimBody('../etc', {}) };
        term.abort();
        return { status: 404 };
      }
      return { status: 200, body: { ok: true } };
    });
    const clock = fakeClock();
    const code = await runVerifierLoop(settings(), {
      fetch: d.fetchFn,
      ...clock,
      out: () => {},
      err: () => {},
      termination: term.signal,
      work: async () => {
        ran = true;
        return VERIFIED;
      },
    });
    expect(code).toBe(0);
    expect(ran).toBe(false);
    // A jobId with characters other than letters, digits and - never goes into a route.
    expect(d.releases().map((c) => c.route)).toEqual(['/v1/verify/job-1/release']);
    expect(clock.delays).toEqual([1000, 2000]);
  });
});

describe('verifier loop: termination', () => {
  it('raised while the loop waits, returns 0 at once with a terminating line and makes no further call', async () => {
    const term = new AbortController();
    const d = fakeDaemon(() => ({ status: 404 }));
    const sleeps: number[] = [];
    const out: string[] = [];
    const loop = runVerifierLoop(settings(), { fetch: d.fetchFn, now: () => 0, sleep: (ms) => (sleeps.push(ms), new Promise<void>(() => {})), out: (l) => void out.push(l), err: () => {}, termination: term.signal });
    await until(() => sleeps.length === 1, 'the wait');
    const before = d.calls.length;
    term.abort();
    expect(await loop).toBe(0);
    expect(d.calls.length).toBe(before);
    expect(out.at(-1)).toBe('verifier v-1 terminating - -');
  });

  it('raised while a claim is held and the claim then answered 200: the claim in flight is sent again once, one release with podTerminating, no job, no further claim', async () => {
    const term = new AbortController();
    const held = deferred<Answer>();
    const d = fakeDaemon((c) => (c.route === '/v1/verify/claims' ? held.promise : { status: 200, body: { ok: true } }));
    let ran = false;
    const out: string[] = [];
    const loop = runVerifierLoop(settings(), {
      fetch: d.fetchFn,
      ...fakeClock(),
      out: (l) => void out.push(l),
      err: () => {},
      termination: term.signal,
      work: async () => {
        ran = true;
        return VERIFIED;
      },
    });
    await until(() => d.claims().length === 1, 'the claim');
    term.abort();
    held.resolve({ status: 200, body: claimBody() });
    expect(await loop).toBe(0);
    expect(ran).toBe(false);
    // The signal aborts the claim in flight and the client sends the same claim again; the loop claims no more.
    expect(d.claims()).toHaveLength(2);
    expect(d.claims()[1]).toEqual(d.claims()[0]);
    expect(d.releases()).toEqual([{ method: 'POST', route: '/v1/verify/job-1/release', body: { reason: 'podTerminating' }, auth: 'Bearer tok-job-1' }]);
    expect(has(out, 'terminating')).toHaveLength(1);
  });

  it('raised while the job runs: the job signal is aborted, no result, one release with podTerminating, released, exit 0', async () => {
    const term = new AbortController();
    const signals: AbortSignal[] = [];
    const d = fakeDaemon((c) => (c.route === '/v1/verify/claims' ? { status: 200, body: claimBody() } : { status: 200, body: { ok: true } }));
    const out: string[] = [];
    const loop = runVerifierLoop(settings(), { fetch: d.fetchFn, ...fakeClock(), schedule: fakeSchedule().schedule, out: (l) => void out.push(l), err: () => {}, termination: term.signal, work: waitsOnSignal(signals) });
    await until(() => signals.length === 1, 'the job');
    term.abort();
    expect(await loop).toBe(0);
    expect(signals[0]!.aborted).toBe(true);
    expect(d.results()).toEqual([]);
    expect(d.releases()).toEqual([{ method: 'POST', route: '/v1/verify/job-1/release', body: { reason: 'podTerminating' }, auth: 'Bearer tok-job-1' }]);
    expect(has(out, 'released')).toEqual(['verifier v-1 released job-1 T1']);
    expect(has(out, 'terminating')).toEqual(['verifier v-1 terminating job-1 T1']);
    expect(d.claims()).toHaveLength(1);
  });

  it('raised while the result post is held and the post then answered 200: the outcome line, no release, exit 0', async () => {
    const term = new AbortController();
    const held = deferred<Answer>();
    const d = fakeDaemon((c) => {
      if (c.route === '/v1/verify/claims') return { status: 200, body: claimBody() };
      if (c.route.endsWith('/result')) return held.promise;
      return { status: 200, body: { ok: true } };
    });
    const out: string[] = [];
    const loop = runVerifierLoop(settings(), { fetch: d.fetchFn, ...fakeClock(), schedule: fakeSchedule().schedule, out: (l) => void out.push(l), err: () => {}, termination: term.signal, work: async () => VERIFIED });
    await until(() => d.results().length === 1, 'the result post');
    term.abort();
    held.resolve({ status: 200, body: { ok: true } });
    expect(await loop).toBe(0);
    expect(has(out, 'verified')).toEqual(['verifier v-1 verified job-1 T1']);
    // The post in flight at the signal is aborted and sent again; the one sent again is answered 200.
    expect(d.results()).toHaveLength(2);
    expect(d.results()[1]).toEqual(d.results()[0]);
    expect(d.releases()).toEqual([]);
    expect(d.claims()).toHaveLength(1);
  });
});

/** A fetch that never answers, and rejects once its signal is aborted, as a real fetch to a daemon that holds the connection does. */
const neverAnswers = (init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) return;
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

describe('verifier loop: bounded shutdown', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const refusals: Array<[string, Answer]> = [
    ['400', { status: 400, body: { error: 'rebasedSha is required' } }],
    ['503', { status: 503, body: { error: 'unavailable' } }],
    ['no answer', 'throw'],
  ];
  for (const [name, answer] of refusals) {
    it(`a result post answered ${name} after SIGTERM is followed by one release with podTerminating, and the loop exits 0 within 6000 ms of the signal`, async () => {
      const term = new AbortController();
      const held = deferred<void>();
      const clock = fakeClock();
      const d = fakeDaemon(async (c) => {
        if (c.route === '/v1/verify/claims') return { status: 200, body: claimBody() };
        if (c.route.endsWith('/result')) {
          await held.promise;
          return answer;
        }
        return { status: 200, body: { ok: true } };
      });
      const out: string[] = [];
      const loop = runVerifierLoop(settings({ retryWindowMs: 60_000 }), { fetch: d.fetchFn, ...clock, schedule: fakeSchedule().schedule, out: (l) => void out.push(l), err: () => {}, termination: term.signal, work: async () => VERIFIED });
      await until(() => d.results().length === 1, 'the result post');
      const signalAt = clock.now();
      term.abort();
      held.resolve();
      expect(await loop).toBe(0);
      expect(clock.now() - signalAt).toBeLessThanOrEqual(6000);
      expect(d.releases()).toEqual([{ method: 'POST', route: '/v1/verify/job-1/release', body: { reason: 'podTerminating' }, auth: 'Bearer tok-job-1' }]);
      expect(has(out, 'result-refused')).toHaveLength(1);
      expect(has(out, 'released')).toEqual(['verifier v-1 released job-1 T1']);
      expect(d.claims()).toHaveLength(1);
      // The signal aborts the post in flight, and the client sends it again: same route, body and job token.
      const posts = d.results();
      expect(posts[0]).toEqual({ method: 'POST', route: '/v1/verify/job-1/result', body: VERIFIED, auth: 'Bearer tok-job-1' });
      for (const p of posts) expect(p).toEqual(posts[0]);
      // The post sent again is answered and not sent a third time; only a connection failure is retried, within
      // TERMINATION_CALL_MS.
      if (answer !== 'throw') expect(posts).toHaveLength(2);
      else expect(posts.length).toBeGreaterThan(2);
    });
  }

  it('a claim whose answer body is cut off by the signal is sent again, and the job it grants is released with podTerminating', async () => {
    const term = new AbortController();
    const clock = fakeClock();
    const calls: Call[] = [];
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const route = String(url).replace(API, '');
      calls.push({ method: init?.method ?? 'GET', route, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined, auth: headers['authorization'] });
      const signal = init!.signal!;
      const claimsSoFar = calls.filter((c) => c.route === '/v1/verify/claims').length;
      if (route === '/v1/verify/claims' && claimsSoFar === 1) {
        // The headers arrive; the body is still being read when the signal comes.
        return { status: 200, json: () => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) } as unknown as Response;
      }
      if (route === '/v1/verify/claims') return new Response(JSON.stringify({ ...claimBody(), repeated: true }), { status: 200 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    const loop = runVerifierLoop(settings({ retryWindowMs: 60_000 }), { fetch: fetchFn, ...clock, out: () => {}, err: () => {}, termination: term.signal, work: async () => VERIFIED });
    await until(() => calls.length === 1, 'the claim');
    await flush();
    term.abort();
    expect(await loop).toBe(0);
    expect(calls.filter((c) => c.route === '/v1/verify/claims')).toHaveLength(2);
    expect(calls.filter((c) => c.route.endsWith('/release'))).toEqual([{ method: 'POST', route: '/v1/verify/job-1/release', body: { reason: 'podTerminating' }, auth: 'Bearer tok-job-1' }]);
  });

  it('a signal during the pause between result posts leads to exactly one result post in total, then the release', async () => {
    const term = new AbortController();
    const clock = fakeClock();
    const d = fakeDaemon((c) => {
      if (c.route === '/v1/verify/claims') return { status: 200, body: claimBody() };
      if (c.route.endsWith('/result')) return { status: 503 };
      return { status: 200, body: { ok: true } };
    });
    const sleep = async (ms: number) => {
      if (ms === RESULT_RETRY_MS && d.results().length === 1) term.abort();
      await clock.sleep(ms);
    };
    const code = await runVerifierLoop(settings({ retryWindowMs: 60_000 }), { fetch: d.fetchFn, now: clock.now, sleep, schedule: fakeSchedule().schedule, out: () => {}, err: () => {}, termination: term.signal, work: async () => VERIFIED });
    expect(code).toBe(0);
    expect(clock.delays).toEqual([RESULT_RETRY_MS]);
    expect(d.results()).toHaveLength(1);
    expect(d.releases()).toEqual([{ method: 'POST', route: '/v1/verify/job-1/release', body: { reason: 'podTerminating' }, auth: 'Bearer tok-job-1' }]);
  });

  /** Runs the loop on fake timers with a 60 s retry window; `handler` answers each call. Answers when and how it ended. */
  async function onFakeTimers(handler: (c: Call, init?: RequestInit) => Promise<Response>, until1: (calls: Call[]) => boolean) {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const calls: Call[] = [];
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const c: Call = { method: init?.method ?? 'GET', route: String(url).replace(API, ''), body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined, auth: headers['authorization'] };
      calls.push(c);
      return handler(c, init);
    }) as typeof fetch;
    const term = new AbortController();
    const out: string[] = [];
    let ended: { code: number; at: number } | undefined;
    void runVerifierLoop(settings({ retryWindowMs: 60_000 }), { fetch: fetchFn, schedule: fakeSchedule().schedule, out: (l) => void out.push(l), err: () => {}, termination: term.signal, work: async () => VERIFIED }).then((code) => (ended = { code, at: Date.now() }));
    await until(() => until1(calls), 'the call in flight');
    const signalAt = Date.now();
    term.abort();
    for (let i = 0; i < TERMINATION_CALL_MS + 1000 && !ended; i += 100) await vi.advanceTimersByTimeAsync(100);
    for (let i = 0; i < 20 && !ended; i++) await flush();
    return { ended, signalAt, calls, out };
  }

  it('with retryWindowMs 60000, a claim in flight at SIGTERM that is never answered ends the loop with 0 within TERMINATION_CALL_MS plus 1000 ms', async () => {
    const r = await onFakeTimers(
      (_c, init) => neverAnswers(init),
      (calls) => calls.length === 1,
    );
    expect(r.ended).toBeDefined();
    expect(r.ended!.code).toBe(0);
    expect(r.ended!.at - r.signalAt).toBeLessThanOrEqual(TERMINATION_CALL_MS + 1000);
    expect(r.calls.every((c) => c.route === '/v1/verify/claims')).toBe(true);
  });

  it('with retryWindowMs 60000, a result post in flight at SIGTERM that is never answered is followed by a release, and the loop exits 0 within TERMINATION_CALL_MS plus 1000 ms', async () => {
    const r = await onFakeTimers(
      async (c, init) => {
        if (c.route === '/v1/verify/claims') return new Response(JSON.stringify(claimBody()), { status: 200 });
        if (c.route.endsWith('/result')) return neverAnswers(init);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
      (calls) => calls.some((c) => c.route.endsWith('/result')),
    );
    expect(r.ended).toBeDefined();
    expect(r.ended!.code).toBe(0);
    expect(r.ended!.at - r.signalAt).toBeLessThanOrEqual(TERMINATION_CALL_MS + 1000);
    expect(r.calls.filter((c) => c.route.endsWith('/release'))).toEqual([{ method: 'POST', route: '/v1/verify/job-1/release', body: { reason: 'podTerminating' }, auth: 'Bearer tok-job-1' }]);
    expect(has(r.out, 'released')).toEqual(['verifier v-1 released job-1 T1']);
  });
});
