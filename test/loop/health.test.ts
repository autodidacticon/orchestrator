import { afterEach, describe, expect, it } from 'vitest';
import type { Config, ConfigInput } from '../../src/config.js';
import type { StuckDiagnoser } from '../../src/health/stuck.js';
import { Orchestrator } from '../../src/loop/orchestrator.js';
import { makeHarness, type Harness } from './harness.js';

const open: Harness[] = [];
afterEach(() => {
  for (const h of open.splice(0)) h.cleanup();
});

const health = (over: Partial<Config['health']> = {}): Config['health'] => ({ stuckAfterMs: 0, stuckFailAfterMs: 0, baseMovedNotice: true, ...over });
const budgets = (over: Partial<Config['budgets']> = {}): Config['budgets'] => ({ maxLaunchMs: 0, maxRunCostUsd: 0, ...over });

function harness(config: ConfigInput = {}, extra: { diagnoser?: StuckDiagnoser } = {}): Harness {
  const h = makeHarness({ config: { tickIntervalMs: 100, health: health(), budgets: budgets(), ...config }, stuckDiagnoser: extra.diagnoser });
  open.push(h);
  return h;
}

const kinds = (h: Harness, taskId: string, kind: string) => h.store.listEvents({ kind, taskId });

describe('health: liveness and leases', () => {
  it('a silent but alive agent keeps its lease past the TTL; unknown liveness still expires it', async () => {
    const h = harness();
    await h.orch.tick();
    const l1 = h.launchOf('T1');
    const before = h.orch.entry('T1').lease!.expiresAt;
    h.advance(h.orch.config.leaseTtlMs + 1);
    await h.orch.tick();
    expect(h.statusOf('T1')).toBe('running');
    expect(h.orch.entry('T1')).toMatchObject({ attempts: 0, launches: 1 });
    expect(h.orch.entry('T1').lease!.expiresAt).toBeGreaterThan(before);
    expect(h.runner.isAlive(l1.launchId)).toBe(true);

    h.runner.unknownForAll = true;
    h.advance(h.orch.config.leaseTtlMs + 1);
    await h.orch.tick();
    expect(h.runner.isAlive(l1.launchId)).toBe(false);
    expect(h.orch.entry('T1')).toMatchObject({ attempts: 1, launches: 2, status: { kind: 'running' } });
    expect(h.workspace.briefs.get(h.launchOf('T1').launchId)?.carry).toMatchObject({ priorFailure: { kind: 'leaseExpired' } });
  });
});

describe('health: progress signals', () => {
  it('first fingerprint is a baseline; worktree change, commit, API calls, and new heartbeat text are progress', async () => {
    const h = harness();
    await h.orch.tick();
    const l1 = h.launchOf('T1');
    expect(h.store.getLaunch(l1.launchId)).toMatchObject({ lastSignal: 'spawned', progressAt: l1.spawnedAt });
    h.advance(200);
    await h.orch.tick(); // baseline
    expect(h.store.getLaunch(l1.launchId)).toMatchObject({ lastSignal: 'spawned', fingerprint: 'head0:clean' });

    h.workspace.fingerprints.set(l1.launchId, 'head0:dirty');
    h.advance(200);
    await h.orch.tick();
    expect(h.store.getLaunch(l1.launchId)).toMatchObject({ lastSignal: 'worktree', progressAt: h.now.value });

    h.workspace.fingerprints.set(l1.launchId, 'head7:dirty');
    h.advance(200);
    await h.orch.tick();
    expect(h.store.getLaunch(l1.launchId)).toMatchObject({ lastSignal: 'commit', fingerprint: 'head7:dirty' });

    h.advance(200);
    await h.orch.agentCall(l1.launchId, l1.token, 'heartbeat', { progress: 'reading code' });
    expect(h.store.getLaunch(l1.launchId)).toMatchObject({ lastSignal: 'heartbeatText', progressText: 'reading code', progressAt: h.now.value });
    h.advance(200);
    await h.orch.agentCall(l1.launchId, l1.token, 'heartbeat', { progress: 'reading code' });
    expect(h.store.getLaunch(l1.launchId)).toMatchObject({ lastSignal: 'heartbeat', progressText: 'reading code' });
    await h.orch.agentCall(l1.launchId, l1.token, 'heartbeat', { progress: 'writing tests' });
    expect(h.store.getLaunch(l1.launchId)).toMatchObject({ lastSignal: 'heartbeatText', progressText: 'writing tests' });
    h.advance(200);
    await h.orch.agentCall(l1.launchId, l1.token, 'log', { text: 'hello' });
    expect(h.store.getLaunch(l1.launchId)).toMatchObject({ lastSignal: 'log', progressAt: h.now.value });
  });

  it('resume records progress and excludes the wait from the launch clock', async () => {
    const h = harness({ budgets: budgets({ maxLaunchMs: 10_000 }) });
    await h.orch.tick();
    const l5 = h.launchOf('T5');
    void h.block('T5', 'which way?');
    await new Promise((r) => setTimeout(r, 10));
    expect(h.statusOf('T5')).toBe('waiting');
    expect(h.store.getLaunch(l5.launchId)?.waitingSince).toBe(h.now.value);
    h.advance(20 * 60_000);
    await h.orch.tick();
    expect(h.statusOf('T5')).toBe('waiting'); // never stuck, never over budget while waiting
    h.orch.answer('T5', 'left');
    await h.orch.tick();
    expect(h.statusOf('T5')).toBe('running');
    expect(h.store.getLaunch(l5.launchId)).toMatchObject({ lastSignal: 'resumed', progressAt: h.now.value, waitedMs: 20 * 60_000 });
    h.advance(5_000);
    await h.orch.tick();
    expect(h.statusOf('T5')).toBe('running');
    expect(h.orch.status().liveLaunches.find((l) => l.taskId === 'T5')?.elapsedMs).toBe(5_000);
  });
});

describe('health: stuck detection', () => {
  it('flags, nudges through the inbox, then fails with attempts incremented; progress clears the flag', async () => {
    const h = harness({ health: health({ stuckAfterMs: 1000, stuckFailAfterMs: 3000 }) });
    await h.orch.tick();
    const l1 = h.launchOf('T1');
    const l5 = h.launchOf('T5');
    h.advance(1500);
    await h.orch.tick();
    expect(h.orch.status().stuck.sort()).toEqual(['T1', 'T5']);
    expect(kinds(h, 'T1', 'launch.stuck')).toMatchObject([{ payload: { idleMs: 1500, lastSignal: 'spawned' } }]);
    expect(h.store.getLaunch(l1.launchId)?.stuckSince).toBe(h.now.value);
    expect(h.orch.status().liveLaunches.find((l) => l.taskId === 'T1')).toMatchObject({ stuck: true, idleMs: 1500, lastSignal: 'spawned' });
    // Reading the inbox is an API call, so it is progress: the notice arrives and the flag clears.
    const notices = await h.inbox('T1');
    expect(notices).toMatchObject([{ kind: 'stuck', idleMs: 1500 }]);
    expect(await h.inbox('T1')).toEqual([]);
    expect(kinds(h, 'T1', 'launch.unstuck')).toHaveLength(1);
    expect(h.store.getLaunch(l1.launchId)).toMatchObject({ lastSignal: 'inbox' });
    expect(h.store.getLaunch(l1.launchId)?.stuckSince).toBeUndefined();

    // T5 makes progress in its tree: unflagged.
    h.workspace.fingerprints.set(l5.launchId, 'head0:dirty');
    h.advance(200);
    await h.orch.tick();
    expect(kinds(h, 'T5', 'launch.unstuck')).toHaveLength(1);
    expect(h.store.getLaunch(l5.launchId)?.stuckSince).toBeUndefined();
    expect(h.orch.status().stuck).toEqual([]);

    // T1 goes silent again past the fail threshold.
    h.advance(3500);
    await h.orch.tick();
    expect(h.runner.isAlive(l1.launchId)).toBe(false);
    expect(h.store.getLaunch(l1.launchId)).toMatchObject({ status: 'ended', endReason: 'stuck' });
    expect(h.orch.entry('T1')).toMatchObject({ attempts: 1, launches: 2, status: { kind: 'running' } });
    expect(h.workspace.briefs.get(h.launchOf('T1').launchId)?.carry).toMatchObject({ priorFailure: { kind: 'stuck' } });
    expect(h.store.listEvents({ kind: 'transition', taskId: 'T1' }).map((e) => e.payload?.['trigger'])).toContain('stuck');
  });

  it('a waiting task is never stuck, and thresholds at 0 disable detection', async () => {
    const h = harness({ health: health({ stuckAfterMs: 1000, stuckFailAfterMs: 3000 }) });
    await h.orch.tick();
    void h.block('T5', 'q?');
    await new Promise((r) => setTimeout(r, 10));
    h.advance(10_000);
    await h.orch.tick();
    expect(h.statusOf('T5')).toBe('waiting');
    expect(kinds(h, 'T5', 'launch.stuck')).toEqual([]);

    const off = harness();
    await off.orch.tick();
    off.advance(3600_000);
    await off.orch.tick();
    expect(off.store.listEvents({ kind: 'launch.stuck' })).toEqual([]);
    expect(off.statusOf('T1')).toBe('running');
    expect(off.orch.entry('T1').attempts).toBe(0);
  });

  it('a diagnoser may nudge with a message or fail at once', async () => {
    const diagnoser: StuckDiagnoser = {
      diagnose: async (ctx) => (ctx.task === 'T1' ? { action: 'nudge', message: 'commit what you have' } : { action: 'fail', message: 'nothing in the tree' }),
    };
    const h = harness({ health: health({ stuckAfterMs: 1000, stuckFailAfterMs: 60_000 }) }, { diagnoser });
    await h.orch.tick();
    const l5 = h.launchOf('T5');
    h.advance(1500);
    await h.orch.tick();
    expect(await h.inbox('T1')).toMatchObject([{ kind: 'stuck' }, { kind: 'nudge', message: 'commit what you have', source: 'diagnoser' }]);
    expect(h.store.getLaunch(l5.launchId)).toMatchObject({ status: 'ended', endReason: 'stuck' });
    expect(h.orch.entry('T5')).toMatchObject({ attempts: 1, status: { kind: 'running' } });
    expect(h.store.listEvents({ kind: 'transition', taskId: 'T5' }).find((e) => e.payload?.['to'] === 'failed')).toBeDefined();
    expect(h.workspace.briefs.get(h.launchOf('T5').launchId)?.carry).toMatchObject({ priorFailure: { kind: 'stuck', message: 'nothing in the tree' } });
  });
});

describe('health: nudge and base-moved notices', () => {
  it('nudge queues a notice for the live launch and is refused without one', async () => {
    const h = harness();
    await h.orch.tick();
    expect(h.orch.nudge('T1', 'commit what you have')).toEqual({ ok: true });
    expect(await h.inbox('T1')).toEqual([{ kind: 'nudge', message: 'commit what you have' }]);
    expect(await h.inbox('T1')).toEqual([]);
    expect(h.store.listEvents({ kind: 'operator.nudge', taskId: 'T1' })).toMatchObject([{ payload: { message: 'commit what you have' } }]);
    const refused = h.orch.nudge('T2', 'hello');
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toContain('unstarted');
  });

  it('a publish tells running siblings what moved; disabled by config', async () => {
    const h = harness();
    await h.orch.tick();
    await h.submit('T1');
    await h.orch.settle();
    expect(h.statusOf('T1')).toBe('done');
    expect(await h.inbox('T5')).toEqual([{ kind: 'baseMoved', head: 'pub-T1-1', files: ['T1.txt'], task: 'T1' }]);
    expect(h.store.listEvents({ kind: 'launch.notice' })).toMatchObject([{ taskId: 'T5', payload: { kind: 'baseMoved' } }]);

    const off = harness({ health: health({ baseMovedNotice: false }) });
    await off.orch.tick();
    await off.submit('T1');
    await off.orch.settle();
    expect(await off.inbox('T5')).toEqual([]);
  });
});

describe('health: budgets and usage', () => {
  it('a launch past maxLaunchMs is reaped and fails with timeBudget; exhaustion blocks', async () => {
    const h = harness({ budgets: budgets({ maxLaunchMs: 10_000 }), maxAttempts: 1 });
    await h.orch.tick();
    const l1 = h.launchOf('T1');
    h.advance(9_000);
    await h.orch.tick();
    expect(h.statusOf('T1')).toBe('running');
    h.advance(2_000);
    await h.orch.tick();
    expect(h.runner.isAlive(l1.launchId)).toBe(false);
    expect(h.store.getLaunch(l1.launchId)).toMatchObject({ status: 'ended', endReason: 'timeBudget' });
    expect(h.orch.entry('T1')).toMatchObject({ attempts: 1, status: { kind: 'blocked' } });
    expect(h.orch.entry('T1').status).toMatchObject({ reason: { message: expect.stringContaining('timeBudget') } });
    await h.orch.settle();
    expect(h.orch.status().stallRoots).toContain('T1');
  });

  it('usage is read when a launch ends, summed per task and per run, and derived from rows after a restart', async () => {
    const h = harness();
    h.runner.usageScript.set('T1', { costUsd: 1.25, turns: 3, durationMs: 1000 });
    h.runner.usageScript.set('T5', { costUsd: 0.75 });
    await h.orch.tick();
    await h.submit('T1');
    await h.submit('T5');
    await h.orch.settle();
    await h.orch.tick();
    expect(h.store.listEvents({ kind: 'launch.usage' })).toHaveLength(2);
    const s = h.orch.status();
    expect(s.cost).toEqual({ runUsd: 2, byTask: { T1: 1.25, T5: 0.75 }, ceilingUsd: undefined, overrides: 0 });
    const again = new Orchestrator({ store: h.store, config: h.orch.config, graphSource: h.source, runner: h.runner, workspace: h.workspace, verifier: h.verifier, clock: () => h.now.value });
    await again.loadGraph();
    expect(again.status().cost).toEqual(s.cost);
    expect(h.store.listLaunches({ taskId: 'T1' })[0]).toMatchObject({ costUsd: 1.25, turns: 3, durationMs: 1000 });
  });

  it('crossing the run cost budget pauses admission; resume is refused until overridden', async () => {
    const h = harness({ budgets: budgets({ maxRunCostUsd: 5 }), capacity: 1 });
    h.runner.usageScript.set('T1', { costUsd: 3 });
    h.runner.usageScript.set('T5', { costUsd: 3 });
    await h.orch.tick();
    expect(h.orch.status().byStatus.running).toEqual(['T1']);
    await h.submit('T1');
    await h.orch.settle();
    await h.orch.tick();
    expect(h.statusOf('T1')).toBe('done');
    expect(h.orch.status().byStatus.running).toEqual(['T5']);
    await h.submit('T5');
    await h.orch.settle();
    await h.orch.tick();
    await h.orch.tick();
    const s = h.orch.status();
    expect(s.paused).toBe(true);
    expect(s.pausedReason).toBe('costBudget');
    expect(s.cost).toMatchObject({ runUsd: 6, ceilingUsd: 5 });
    expect(s.byStatus.running).toEqual([]);
    expect(h.store.listEvents({ kind: 'budget.exceeded' })).toMatchObject([{ payload: { runUsd: 6, ceilingUsd: 5 } }]);

    const refused = h.orch.resume();
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused).toMatchObject({ runUsd: 6, ceilingUsd: 5, reason: expect.stringContaining('costBudget') });
    expect(h.orch.isPaused()).toBe(true);
    expect(h.orch.resume({ overrideBudget: true })).toEqual({ ok: true });
    expect(h.orch.status()).toMatchObject({ paused: false, pausedReason: undefined, cost: { ceilingUsd: 10, overrides: 1 } });
    expect(h.store.listEvents({ kind: 'budget.overridden' })).toHaveLength(1);
    expect(h.store.listEvents({ kind: 'operator.resume' }).at(-1)?.payload).toEqual({ overrideBudget: true });
    await h.orch.tick();
    expect(h.orch.status().byStatus.running).toHaveLength(1);
  });
});
