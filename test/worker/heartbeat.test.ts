/**
 * The worker loop's heartbeat on a fake clock shared with a real daemon: every `leaseTtlMs / 3` from the claim until
 * the agent exits, with the clone's fingerprint, whether or not the agent calls the API; a 401 ends it.
 * See specs/worker-pool "Loop heartbeat".
 */
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitWorkspace } from '../../src/workspace/git-workspace.js';
import { treeFingerprint } from '../../src/workspace/fingerprint.js';
import { cloneDirFor } from '../../src/worker/clone.js';
import { cloneFingerprint, heartbeatEveryMs, runWorkerLoop, type Schedule, type WorkerSettings } from '../../src/worker/loop.js';
import type { Launch } from '../../src/state/store.js';
import { gitIn, makeRepo, makeSlice, type SliceHarness } from '../slice/harness.js';

const TTL = 60_000;
const STEP = 5000;

let h: SliceHarness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const realDelay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One fake clock for the daemon and the loop. `schedule` queues the loop's heartbeat timers; the loop's `sleep` walks
 * the clock forward in steps of 5 s, fires each timer that falls due, waits until that heartbeat has been answered,
 * and ticks the daemon at every step while `ticking`, so a lease that lapses would expire then.
 */
function fakeTime(start = 2_000_000) {
  let t = start;
  let nextId = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let fired = 0;
  let answered = 0;
  const schedule: Schedule = (fn, ms) => {
    const id = nextId++;
    timers.set(id, { at: t + ms, fn });
    return () => void timers.delete(id);
  };
  const fireDue = async () => {
    for (;;) {
      const due = [...timers.entries()].filter(([, v]) => v.at <= t).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) return;
      timers.delete(due[0]);
      fired++;
      due[1].fn();
      // The heartbeat reads the clone's fingerprint and posts it over real HTTP: wait for its answer.
      for (const deadline = Date.now() + 10_000; answered < fired; await realDelay(5)) if (Date.now() > deadline) throw new Error('heartbeat not answered');
    }
  };
  const o = {
    now: () => t,
    schedule,
    ticking: false,
    onStep: async () => undefined as void,
    answeredOne: () => void answered++,
    sleep: async (ms: number) => {
      const end = t + ms;
      while (t < end) {
        t = Math.min(end, t + STEP);
        await fireDue();
        if (o.ticking) await o.onStep();
      }
    },
  };
  return o;
}

function fixture(): { dir: string; repo: string; bare: string } {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'orch-worker-heartbeat-')));
  const repo = makeRepo(dir);
  const bare = path.join(dir, 'origin.git');
  gitIn(dir, 'clone', '-q', '--bare', repo, bare);
  return { dir, repo, bare };
}

const settings = (api: string, cache: string): WorkerSettings => ({ api, workerId: 'w-1', cache, agent: 'scripted', idleExitMs: 1, retryWindowMs: 5000, backoffMs: 1000, backoffMaxMs: 1000 });

/** A remote run with a bare origin on the fake clock, with one task parked for a worker. */
async function remoteSlice(time: ReturnType<typeof fakeTime>) {
  const f = fixture();
  h = await makeSlice({
    graph: 'nodes:\n  - { id: T1, deps: [], description: d, acceptanceCriteria: [a] }',
    dir: f.dir,
    repo: f.repo,
    clock: time.now,
    config: {
      leaseTtlMs: TTL,
      apiBaseUrl: 'http://orchestrator.example:8080',
      runner: { mode: 'pull', access: 'remote', claimWindowMs: 3_600_000 },
      git: { pushIntegration: true, originUrl: f.bare, fetchIntervalMs: 0 },
      health: { stuckAfterMs: 0, stuckFailAfterMs: 0, reportGraceMs: 0, gapAfterMs: 0 },
    },
  });
  await h.orch.tick();
  return f;
}

describe('the loop heartbeat', () => {
  it('heartbeats every leaseTtlMs / 3 while a scripted agent is silent for three lease TTLs; the lease never expires and the task ends submitted', async () => {
    const time = fakeTime();
    const f = await remoteSlice(time);
    const beats: Array<{ at: number; body: Record<string, unknown> }> = [];
    const realFetch = globalThis.fetch;
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      const res = await realFetch(url, init);
      if (String(url).endsWith('/heartbeat')) {
        beats.push({ at: time.now(), body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
        time.answeredOne();
      }
      return res;
    }) as typeof fetch;
    let minHeadroom = Infinity;
    time.onStep = async () => {
      const lease = h!.orch.entry('T1').lease;
      expect(lease, 'the lease is held throughout').toBeDefined();
      minHeadroom = Math.min(minHeadroom, lease!.expiresAt - time.now());
      await h!.orch.tick();
    };
    const cache = path.join(f.dir, 'cache');
    const sleep = async (ms: number) => {
      // The agent's silent step: tick the daemon meanwhile. The loop's own waits afterwards do not tick, so the
      // verifier never starts and the task stays submitted.
      time.ticking = ms === 3 * TTL;
      try {
        await time.sleep(ms);
      } finally {
        time.ticking = false;
      }
    };
    const out: string[] = [];
    const errs: string[] = [];
    const code = await runWorkerLoop(settings(h!.orch.apiBaseUrl, cache), { fetch: fetchFn, sleep, now: time.now, schedule: time.schedule, scriptedIdleMs: 3 * TTL, out: (l) => out.push(l), err: (e) => errs.push(e) });
    expect(code, errs.join('')).toBe(0);

    const [launch] = h!.store.listLaunches({ taskId: 'T1' });
    expect(h!.store.listLaunches({ taskId: 'T1' })).toHaveLength(1);
    const claimedAt = launch!.worker!.claimedAt;
    // Nine heartbeats in the three TTLs, one every leaseTtlMs / 3 from the claim.
    expect(heartbeatEveryMs({ lease: { ttlMs: TTL } })).toBe(TTL / 3);
    expect(beats.map((b) => b.at - claimedAt)).toEqual(Array.from({ length: 9 }, (_, i) => (i + 1) * (TTL / 3)));
    // Each carries the clone's fingerprint and no text.
    for (const b of beats) {
      expect(b.body['fingerprint']).toMatch(/^[0-9a-f]{40}:[0-9a-f]{16}$/);
      expect(b.body['progress']).toBeUndefined();
    }
    expect(minHeadroom).toBeGreaterThan(0);
    expect(h!.store.listEvents({ kind: 'launch.released', launchId: launch!.launchId })).toHaveLength(0);
    expect(h!.orch.entry('T1').status.kind).toBe('submitted');
    expect(out).toContain(`worker w-1 report accepted ${launch!.launchId} T1`);
    // The fingerprint is stored on the row; an unchanged one was no progress.
    expect(h!.store.getLaunch(launch!.launchId)!.fingerprint).toBe(beats.at(-1)!.body['fingerprint']);
  }, 60_000);

  it('without the heartbeat the same silent step loses the lease (the control)', async () => {
    const time = fakeTime();
    const f = await remoteSlice(time);
    time.onStep = async () => void (await h!.orch.tick());
    const sleep = async (ms: number) => {
      time.ticking = ms === 3 * TTL;
      try {
        await time.sleep(ms);
      } finally {
        time.ticking = false;
      }
    };
    // A schedule that never fires: no heartbeat is sent.
    const never: Schedule = () => () => undefined;
    await runWorkerLoop(settings(h!.orch.apiBaseUrl, path.join(f.dir, 'cache')), { sleep, now: time.now, schedule: never, scriptedIdleMs: 3 * TTL, out: () => undefined, err: () => undefined });
    const [launch] = h!.store.listLaunches({ taskId: 'T1' });
    expect(launch!.endReason).toBe('leaseExpired');
    expect(h!.orch.entry('T1').status.kind).not.toBe('submitted');
  }, 60_000);

  it('sends no further heartbeat for a launch after one was answered 401', async () => {
    const time = fakeTime();
    const f = await remoteSlice(time);
    let heartbeats = 0;
    const realFetch = globalThis.fetch;
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      if (!String(url).endsWith('/heartbeat')) return realFetch(url, init);
      heartbeats++;
      // The second heartbeat finds the launch revoked.
      const res = heartbeats >= 2 ? new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }) : await realFetch(url, init);
      // Counted once answered, so the clock moves on only after the loop has armed its next heartbeat.
      time.answeredOne();
      return res;
    }) as typeof fetch;
    await runWorkerLoop(settings(h!.orch.apiBaseUrl, path.join(f.dir, 'cache')), { fetch: fetchFn, sleep: time.sleep, now: time.now, schedule: time.schedule, scriptedIdleMs: 3 * TTL, out: () => undefined, err: () => undefined });
    // Three TTLs of silence would hold nine heartbeats; after the 401 none follows.
    expect(heartbeats).toBe(2);
  }, 60_000);
});

describe('one fingerprint function', () => {
  it("the loop's clone fingerprint and GitWorkspace.fingerprint are the same function and give the same string for the same clone", async () => {
    expect(cloneFingerprint).toBe(treeFingerprint);
    const f = fixture();
    const clone = cloneDirFor(path.join(f.dir, 'cache'), f.bare);
    gitIn(f.dir, 'clone', '-q', f.bare, clone);
    const ws = new GitWorkspace(f.repo, 'main', path.join(f.dir, 'wt'));
    const at = { worktree: clone } as Launch;
    const same = async () => {
      const a = await cloneFingerprint(clone);
      expect(await ws.fingerprint(at)).toBe(a);
      return a;
    };
    const clean = await same();
    writeFileSync(path.join(clone, 'README.md'), 'edited\n');
    expect(await same()).not.toBe(clean);
    writeFileSync(path.join(clone, 'new.txt'), 'untracked\n');
    await same();
    gitIn(clone, 'add', '-A');
    gitIn(clone, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'w');
    await same();
  });
});
