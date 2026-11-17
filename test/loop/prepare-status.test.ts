import { afterEach, describe, expect, it } from 'vitest';
import type { Config, ConfigInput } from '../../src/config.js';
import { type PrepareRunner, type PrepareRunResult, settlePrepareJobs } from '../../src/launch/prepare.js';
import { Orchestrator } from '../../src/loop/orchestrator.js';
import { digestOf } from '../../src/operator/routes.js';
import { MultiRunner } from '../../src/runner/multi.js';
import type { Launch } from '../../src/state/store.js';
import { makeHarness, type Harness } from './harness.js';

/**
 * Launches being prepared in the status and the digest, and the time budget of a claimed launch (ORC-132).
 * See specs/operator-control "Status report: launches being prepared" and specs/health-monitoring
 * "Time budget of a claimed launch".
 */
const open: Harness[] = [];
afterEach(() => {
  for (const h of open.splice(0)) h.cleanup();
});

interface Call {
  cwd: string;
  resolve(r: PrepareRunResult): void;
}

function fakeRunner(): { calls: Call[]; run: PrepareRunner } {
  const calls: Call[] = [];
  return {
    calls,
    run: (_command, cwd) => new Promise<PrepareRunResult>((resolve) => calls.push({ cwd, resolve })),
  };
}

const OK: PrepareRunResult = { code: 0, timedOut: false, output: 'installed' };
const EXIT1: PrepareRunResult = { code: 1, timedOut: false, output: 'npm ERR! boom' };
const MIN = 60_000;
const ZERO = { 'claude-code': 0, codex: 0, opencode: 0 };

const CODEX = `nodes:
  - { id: A, runner: codex }`;
const TWO = `nodes:
  - { id: A, runner: codex }
  - { id: B, runner: opencode }`;

function harness(graph: string, config: ConfigInput = {}, mode: Config['runner']['mode'] = 'pull'): { h: Harness; r: ReturnType<typeof fakeRunner> } {
  const h = makeHarness({
    graph,
    config: {
      prepareCommand: 'install',
      tickIntervalMs: 100,
      ...config,
      runner: { mode, claimWindowMs: 60_000, ...(config.runner ?? {}) },
      health: { stuckAfterMs: 0, stuckFailAfterMs: 0, reportGraceMs: 0, baseMovedNotice: false, ...(config.health ?? {}) },
      budgets: { maxLaunchMs: 0, maxRunCostUsd: 0, ...(config.budgets ?? {}) },
    },
  });
  open.push(h);
  const r = fakeRunner();
  h.orch.prepareRunner = r.run;
  return { h, r };
}

const latest = (h: Harness, taskId: string): Launch => [...h.store.listLaunches({ taskId })].sort((a, b) => a.launchNo - b.launchNo).at(-1)!;
const callFor = (r: { calls: Call[] }, l: Launch) => r.calls.filter((c) => c.cwd === l.worktree);

/** Fail the pending command of the task's latest launch and settle it. */
async function failOnce(h: Harness, r: { calls: Call[] }, taskId: string): Promise<void> {
  const l = latest(h, taskId);
  callFor(r, l).at(-1)!.resolve(EXIT1);
  // This job only: another may stay pending.
  await h.orch.prepareJobs.get(l.launchId)!.done;
  await settlePrepareJobs(h.orch);
  expect(h.store.getLaunch(l.launchId)).toMatchObject({ status: 'ended', endReason: 'prepareCommandFailed' });
}

describe('status: launches being prepared', () => {
  it('unset key: the fields are empty and zero after every tick of a run to done', async () => {
    const h = makeHarness({ graph: CODEX, config: { runner: { mode: 'spawn' } } });
    open.push(h);
    const check = () => {
      const s = h.orch.status();
      expect(s.preparing).toEqual([]);
      expect(s.prepareRetry).toEqual([]);
      expect(s.preparingByKind).toEqual(ZERO);
    };
    for (let i = 0; i < 10 && h.statusOf('A') !== 'done'; i++) {
      await h.orch.tick();
      check();
      if (h.store.listLaunches({ taskId: 'A', status: 'live' }).length && h.statusOf('A') === 'running') await h.submit('A');
    }
    await h.orch.settle();
    check();
    expect(h.statusOf('A')).toBe('done');
  });

  it('command running: the task is in preparing, nothing is claimable, the digest counts it; after success it is claimable', async () => {
    const { h, r } = harness(CODEX);
    await h.orch.tick();
    await h.orch.prepareStarted();
    let s = h.orch.status();
    expect(s.preparing).toEqual(['A']);
    expect(s.preparingByKind).toEqual({ ...ZERO, codex: 1 });
    expect(s.claimable).toEqual([]);
    expect(s.prepareRetry).toEqual([]);
    expect(digestOf(h.orch)).toMatchObject({ preparing: 1, preparingByKind: { ...ZERO, codex: 1 }, claimable: 0 });

    r.calls[0]!.resolve(OK);
    await h.orch.prepareSettled();
    await h.orch.tick();
    s = h.orch.status();
    expect(s.preparing).toEqual([]);
    expect(s.preparingByKind).toEqual(ZERO);
    expect(s.claimableByKind.codex).toBe(1);
    expect(digestOf(h.orch)).toMatchObject({ preparing: 0, preparingByKind: ZERO });
  });

  it('retry entry: after one failure the task is in prepareRetry, not in preparing, and counted once', async () => {
    const { h, r } = harness(CODEX);
    await h.orch.tick();
    await h.orch.prepareStarted();
    await failOnce(h, r, 'A');
    const s = h.orch.status();
    const retryAt = h.now.value + h.orch.config.prepareRetryBackoffMs;
    expect(s.prepareRetry).toEqual([{ taskId: 'A', failures: 1, retryAt }]);
    expect(s.preparing).toEqual([]);
    expect(s.preparingByKind).toEqual({ ...ZERO, codex: 1 });
    expect(digestOf(h.orch)).toMatchObject({ preparing: 1 });
  });

  it('no gap after retryAt: still listed until the next tick launches the task, then counted once in preparing', async () => {
    const { h, r } = harness(CODEX);
    await h.orch.tick();
    await h.orch.prepareStarted();
    await failOnce(h, r, 'A');
    const { retryAt } = h.orch.status().prepareRetry[0]!;
    h.advance(retryAt - h.now.value + 1_000);
    let s = h.orch.status();
    expect(s.prepareRetry.map((e) => e.taskId)).toEqual(['A']);
    expect(s.preparingByKind).toEqual({ ...ZERO, codex: 1 });

    await h.orch.tick();
    await h.orch.prepareStarted();
    s = h.orch.status();
    expect(h.statusOf('A')).toBe('running');
    expect(s.preparing).toEqual(['A']);
    expect(s.prepareRetry).toEqual([]);
    expect(s.preparingByKind).toEqual({ ...ZERO, codex: 1 });
  });

  it('entry ends: a cancelled task and a task blocked with prepareFailed are in neither list', async () => {
    const one = harness(CODEX);
    await one.h.orch.tick();
    await one.h.orch.prepareStarted();
    await failOnce(one.h, one.r, 'A');
    expect(one.h.orch.status().prepareRetry).toHaveLength(1);
    expect(one.h.orch.cancel('A', 'not needed')).toEqual({ ok: true });
    let s = one.h.orch.status();
    expect(s.preparing).toEqual([]);
    expect(s.prepareRetry).toEqual([]);
    expect(s.preparingByKind).toEqual(ZERO);

    const two = harness(CODEX, { prepareFailureLimit: 2, prepareRetryBackoffMs: 0 });
    await two.h.orch.tick();
    await two.h.orch.prepareStarted();
    await failOnce(two.h, two.r, 'A');
    expect(two.h.orch.status().prepareRetry).toHaveLength(1);
    await two.h.orch.tick();
    await two.h.orch.prepareStarted();
    await failOnce(two.h, two.r, 'A');
    expect(two.h.orch.entry('A').status).toMatchObject({ kind: 'blocked', reason: { kind: 'prepareFailed' } });
    s = two.h.orch.status();
    expect(s.preparing).toEqual([]);
    expect(s.prepareRetry).toEqual([]);
    expect(s.preparingByKind).toEqual(ZERO);
  });

  it('restart: a second Orchestrator reports a launch left preparing and a retry entry before its first tick', async () => {
    const { h, r } = harness(TWO);
    await h.orch.tick();
    await h.orch.prepareStarted();
    await failOnce(h, r, 'A');
    const before = h.orch.status();
    expect(before.preparing).toEqual(['B']);
    const [entry] = before.prepareRetry;
    expect(entry).toMatchObject({ taskId: 'A', failures: 1 });

    const o = new Orchestrator({ store: h.store, config: h.orch.config, graphSource: h.source, runner: new MultiRunner(h.runners), workspace: h.workspace, verifier: h.verifier, clock: () => h.now.value });
    await o.loadGraph();
    const s = o.status();
    expect(s.preparing).toEqual(['B']);
    expect(s.prepareRetry).toEqual([entry]);
    expect(s.preparingByKind).toEqual({ ...ZERO, codex: 1, opencode: 1 });
  });

  it('mixed mode: a parked launch taken back, its second command pending and its row launching, is in preparing', async () => {
    const { h, r } = harness(CODEX, { runner: { mode: 'mixed', claimWindowMs: 2_000 } }, 'mixed');
    await h.orch.tick();
    await h.orch.prepareStarted();
    const l = latest(h, 'A');
    r.calls[0]!.resolve(OK);
    await h.orch.prepareSettled();
    await h.orch.tick();
    expect(h.store.getLaunch(l.launchId)?.status).toBe('claimable');
    expect(h.orch.status().preparing).toEqual([]);
    h.advance(2_500);
    await h.orch.tick();
    await h.orch.prepareStarted();
    expect(callFor(r, l)).toHaveLength(2);
    expect(h.store.getLaunch(l.launchId)?.status).toBe('launching');
    const s = h.orch.status();
    expect(s.preparing).toEqual(['A']);
    expect(s.preparingByKind).toEqual({ ...ZERO, codex: 1 });
  });
});

describe('time budget of a claimed launch', () => {
  it('starts at claimableAt: a 30-minute install and 20 minutes parked do not count', async () => {
    const { h, r } = harness(CODEX, { budgets: { maxLaunchMs: 60 * MIN, maxRunCostUsd: 0 } });
    await h.orch.tick();
    await h.orch.prepareStarted();
    const l = latest(h, 'A');
    for (let i = 0; i < 6; i++) {
      h.advance(5 * MIN);
      await h.orch.tick();
    }
    r.calls[0]!.resolve(OK);
    await h.orch.prepareSettled();
    await h.orch.tick();
    const parked = h.store.getLaunch(l.launchId)!;
    expect(parked.status).toBe('claimable');
    const claimableAt = parked.claimableAt!;
    expect(claimableAt - parked.createdAt).toBeGreaterThanOrEqual(30 * MIN);

    for (let i = 0; i < 4; i++) {
      h.advance(5 * MIN);
      await h.orch.tick();
    }
    const c = await h.orch.claim({ workerId: 'w1', taskId: 'A' });
    expect(c.status).toBe(200);
    expect(String(c.body['launchId'])).toBe(l.launchId);
    const token = h.store.getLaunch(l.launchId)!.token;
    const beat = () => h.orch.agentCall(l.launchId, token, 'heartbeat', { progress: 'working' });

    // 59 minutes after claimableAt, in steps with heartbeats so the lease is renewed.
    while (h.now.value - claimableAt < 59 * MIN) {
      h.advance(Math.min(5 * MIN, 59 * MIN - (h.now.value - claimableAt)));
      expect((await beat()).status).toBe(200);
      await h.orch.tick();
    }
    expect(h.store.getLaunch(l.launchId)?.status).toBe('live');
    const s = h.orch.status();
    expect(s.liveLaunches).toHaveLength(1);
    expect(s.liveLaunches[0]!.elapsedMs).toBe(59 * MIN);

    h.advance(MIN);
    await h.orch.tick();
    expect(h.store.getLaunch(l.launchId)).toMatchObject({ status: 'ended', endReason: 'timeBudget' });
  });

  it('a spawned launch counts from spawnedAt: the install is left out', async () => {
    const { h, r } = harness(CODEX, {}, 'spawn');
    await h.orch.tick();
    await h.orch.prepareStarted();
    const l = latest(h, 'A');
    h.advance(30 * MIN);
    r.calls[0]!.resolve(OK);
    await h.orch.prepareSettled();
    await h.orch.tick();
    expect(h.store.getLaunch(l.launchId)?.status).toBe('live');
    h.advance(5 * MIN);
    const s = h.orch.status();
    expect(s.liveLaunches).toHaveLength(1);
    expect(s.liveLaunches[0]!.elapsedMs).toBe(5 * MIN);
  });
});
