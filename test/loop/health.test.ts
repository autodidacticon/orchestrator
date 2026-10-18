import { afterEach, describe, expect, it } from 'vitest';
import { composeBrief } from '../../src/brief/compose.js';
import type { Config, ConfigInput } from '../../src/config.js';
import type { StuckDiagnoser } from '../../src/health/stuck.js';
import { Orchestrator } from '../../src/loop/orchestrator.js';
import { makeHarness, type Harness } from './harness.js';

const open: Harness[] = [];
afterEach(() => {
  for (const h of open.splice(0)) h.cleanup();
});

const health = (over: Partial<Config['health']> = {}): Config['health'] => ({ stuckAfterMs: 0, stuckFailAfterMs: 0, reportGraceMs: 0, baseMovedNotice: true, ...over });
const budgets = (over: Partial<Config['budgets']> = {}): Config['budgets'] => ({ maxLaunchMs: 0, maxRunCostUsd: 0, prices: {}, ...over });

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

  // See specs/health-monitoring "Process liveness" and specs/task-lifecycle "Health failure reasons".
  it("a dead launch fails exitedWithoutReport with the runner's reason and detail, and the next brief carries it", async () => {
    const h = harness();
    await h.orch.tick();
    const l1 = h.launchOf('T1');
    const detail = 'The model `no-such-model` does not exist or you do not have access to it.';
    h.runner.failureScript.set(l1.launchId, { reason: 'unknownModel', detail });
    h.runner.die(l1.launchId);
    await h.orch.tick();
    expect(kinds(h, 'T1', 'launch.ended').find((e) => e.launchId === l1.launchId)?.payload).toEqual({ endReason: 'exited', runnerFailure: { reason: 'unknownModel', detail } });
    expect(h.orch.entry('T1')).toMatchObject({ attempts: 1, launches: 2, status: { kind: 'running' } });
    const l2 = h.launchOf('T1');
    expect(l2.launchId).not.toBe(l1.launchId);
    const prior = h.workspace.briefs.get(l2.launchId)?.carry?.['priorFailure'] as { kind: string; message: string; detail: unknown };
    expect(prior.kind).toBe('exitedWithoutReport');
    expect(prior.message).toContain('unknownModel');
    expect(prior.message).toContain(detail);
    expect(prior.detail).toEqual({ runnerFailure: { reason: 'unknownModel', detail } });
    const { markdown } = composeBrief(h.workspace.briefs.get(l2.launchId)!, { fallbackPath: '/x' });
    expect(markdown).toContain("The runner's diagnosis of the previous launch: `unknownModel`: " + detail);
  });

  it('a runner without readFailure fails a dead launch as before', async () => {
    const h = harness();
    (h.runner as { readFailure?: unknown }).readFailure = undefined;
    await h.orch.tick();
    const l1 = h.launchOf('T1');
    h.runner.die(l1.launchId);
    await h.orch.tick();
    const prior = h.workspace.briefs.get(h.launchOf('T1').launchId)?.carry?.['priorFailure'];
    expect(prior).toEqual({ kind: 'exitedWithoutReport', message: 'process exited without a report' });
    const { markdown } = composeBrief(h.workspace.briefs.get(h.launchOf('T1').launchId)!, { fallbackPath: '/x' });
    expect(markdown).not.toContain("runner's diagnosis");
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
    // Runner-neutral: an agent whose sandbox cannot commit is not told to commit.
    expect((notices as Array<{ message?: string }>)[0]?.message).toContain('Commit or report what you have');
    expect((notices as Array<{ message?: string }>)[0]?.message).not.toContain('Commit what you have');
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
    expect(s.cost).toEqual({ runUsd: 2, byTask: { T1: 1.25, T5: 0.75 }, ceilingUsd: undefined, overrides: 0, unpricedLaunches: 0 });
    const again = new Orchestrator({ store: h.store, config: h.orch.config, graphSource: h.source, runner: h.runner, workspace: h.workspace, verifier: h.verifier, clock: () => h.now.value });
    await again.loadGraph();
    expect(again.status().cost).toEqual(s.cost);
    expect(h.store.listLaunches({ taskId: 'T1' })[0]).toMatchObject({ costUsd: 1.25, turns: 3, durationMs: 1000 });
  });

  // See specs/pull-runner "Worker usage": a claimed launch has no log, so its worker posts the usage.
  it('a claimed launch ends with no usage, its worker posts it once, and a spawned launch still reads its runner', async () => {
    const h = harness({ runner: { mode: 'mixed', claimWindowMs: 2000 } });
    // A misrouted runner read for the claimed T1 would show as this cost.
    h.runner.usageScript.set('T1', { costUsd: 99 });
    h.runner.usageScript.set('T5', { costUsd: 0.75, turns: 2 });
    await h.orch.tick();
    const c = await h.orch.claim({ workerId: 'w1' });
    expect(c.body).toMatchObject({ taskId: 'T1' });
    const l1 = h.store.getLaunch(String(c.body['launchId']))!;
    expect(l1.pid).toBeUndefined();
    h.advance(2500);
    await h.orch.tick();
    const l5 = h.launchOf('T5');
    expect(l5.pid).toBeGreaterThan(0);

    await h.orch.agentCall(l1.launchId, l1.token, 'report', { seq: 1, kind: 'submit', summary: 'done' });
    // The pid-less launch is ended on the next tick, with no usage of its own.
    await h.orch.tick();
    const ended = h.store.getLaunch(l1.launchId)!;
    expect(ended).toMatchObject({ status: 'ended', endReason: 'reported' });
    expect(ended.costUsd).toBeUndefined();
    expect(ended.tokens).toBeUndefined();
    expect(h.store.listEvents({ kind: 'launch.usage', taskId: 'T1' })).toHaveLength(0);
    await h.orch.settle();

    const tokens = { input: 40361, cachedInput: 32128, output: 260 };
    expect(h.orch.recordWorkerUsage(l1.launchId, { workerId: 'w2', usage: { tokens } }).status).toBe(409);
    expect(h.orch.recordWorkerUsage(l5.launchId, { workerId: 'w1', usage: { tokens } }).status).toBe(409);
    expect(h.orch.recordWorkerUsage(l1.launchId, { workerId: 'w1', usage: { tokens: { input: -1, output: 0 } } }).status).toBe(400);
    expect(h.store.listEvents({ kind: 'launch.usage' })).toHaveLength(0);
    expect(h.store.getLaunch(l5.launchId)?.tokens).toBeUndefined();

    expect(h.orch.recordWorkerUsage(l1.launchId, { workerId: 'w1', usage: { tokens } })).toMatchObject({ status: 200, body: { ok: true, recorded: true } });
    expect(h.store.getLaunch(l1.launchId)).toMatchObject({ tokens, usageSource: 'worker' });
    expect(h.store.getLaunch(l1.launchId)?.costUsd).toBeUndefined();
    expect(h.store.listEvents({ kind: 'launch.usage', taskId: 'T1' })).toMatchObject([{ payload: { tokens, source: 'worker' } }]);
    // A second post is a no-op.
    expect(h.orch.recordWorkerUsage(l1.launchId, { workerId: 'w1', usage: { tokens: { input: 1, output: 1 }, costUsd: 5 } })).toMatchObject({ status: 200, body: { ok: true, recorded: false } });
    expect(h.store.getLaunch(l1.launchId)).toMatchObject({ tokens });
    expect(h.store.listEvents({ kind: 'launch.usage', taskId: 'T1' })).toHaveLength(1);
    expect(h.orch.status().tokens.byTask['T1']).toMatchObject({ input: 40361, output: 260 });

    // The spawned T5 still gets its usage from the runner when it ends.
    await h.orch.agentCall(l5.launchId, l5.token, 'report', { seq: 1, kind: 'submit', summary: 'done' });
    await h.orch.tick();
    expect(h.store.getLaunch(l5.launchId)).toMatchObject({ status: 'ended', costUsd: 0.75, turns: 2, costSource: 'reported' });
  });

  // See specs/worker-runners "Runner dispatch by launch kind": the row's kind picks the usage parser, also for a launch observed dead.
  it('launches of different kinds record usage through their own runner', async () => {
    const h = harness({ capacity: 1 });
    // Each fake also holds a wrong answer for the other kind's task, so a misrouted read shows.
    h.runners['claude-code'].usageScript.set('T1', { costUsd: 1, turns: 1 });
    h.runners['claude-code'].usageScript.set('T5', { costUsd: 99 });
    h.runners.codex.usageScript.set('T5', { costUsd: 2, turns: 4 });
    h.runners.codex.usageScript.set('T1', { costUsd: 99 });
    await h.orch.tick();
    expect(h.launchOf('T1').runner).toBe('claude-code');
    h.orch.setConfig({ runnerKind: 'codex', capacity: 2 });
    await h.orch.tick();
    expect(h.launchOf('T5').runner).toBe('codex');
    await h.submit('T1');
    h.runners.codex.die(h.launchOf('T5').launchId);
    await h.orch.settle();
    await h.orch.tick();
    expect(h.store.listLaunches({ taskId: 'T1' })[0]).toMatchObject({ runner: 'claude-code', costUsd: 1, turns: 1 });
    expect(h.store.listLaunches({ taskId: 'T5' })[0]).toMatchObject({ runner: 'codex', costUsd: 2, turns: 4 });
    expect(h.orch.status().cost.runUsd).toBe(3);
  });

  // See specs/health-monitoring "Usage accounting": the report grace.
  it('a submitted launch is left alive for the report grace, ends reported with usage when its process exits, and is reaped when the grace elapses', async () => {
    const h = harness({ health: { reportGraceMs: 30_000 } });
    h.runner.usageScript.set('T1', { costUsd: 1.5, turns: 2, durationMs: 900 });
    await h.orch.tick();
    const l1 = h.launchOf('T1');
    const l5 = h.launchOf('T5');
    await h.submit('T1');
    await h.submit('T5');
    await h.orch.tick();
    // Within the grace, both launches are still live and their processes untouched.
    expect(h.store.getLaunch(l1.launchId)).toMatchObject({ status: 'live', reportedAt: h.now.value });
    expect(h.runner.isAlive(l1.launchId)).toBe(true);
    expect(h.store.listEvents({ kind: 'launch.usage' })).toHaveLength(0);
    // T1's process exits on its own: the next tick records its usage and ends the launch as reported.
    h.runner.die(l1.launchId);
    await h.orch.tick();
    expect(h.store.getLaunch(l1.launchId)).toMatchObject({ status: 'ended', endReason: 'reported', costUsd: 1.5, turns: 2 });
    // T5's process lingers past the grace: reaped and ended.
    h.advance(31_000);
    await h.orch.tick();
    expect(h.store.getLaunch(l5.launchId)).toMatchObject({ status: 'ended', endReason: 'reported' });
    expect(h.runner.isAlive(l5.launchId)).toBe(false);
    // A cancelled task's launch is reaped at once, grace or not.
    await h.orch.settle();
    await h.orch.tick();
    const l2 = h.launchOf('T2');
    h.orch.cancel('T2', 'x');
    await h.orch.tick();
    expect(h.store.getLaunch(l2.launchId)).toMatchObject({ status: 'ended', endReason: 'cancelled' });
    expect(h.runner.isAlive(l2.launchId)).toBe(false);
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

  // See specs/health-monitoring "Usage accounting" and "Run cost budget": tokens without a price.
  it('a usage with only tokens is recorded; without a price its cost is unknown, counted as unpriced, and does not pause admission', async () => {
    const h = harness({ budgets: budgets({ maxRunCostUsd: 5 }), capacity: 1 });
    const tokens = { input: 40361, output: 260 };
    h.runner.usageScript.set('T1', { tokens, source: 'codex' });
    await h.orch.tick();
    await h.submit('T1');
    await h.orch.settle();
    await h.orch.tick();
    const row = h.store.listLaunches({ taskId: 'T1' })[0]!;
    expect(row).toMatchObject({ status: 'ended', tokens, usageSource: 'codex' });
    expect(row.costUsd).toBeUndefined();
    expect(row.costSource).toBeUndefined();
    expect(row.durationMs).toBeUndefined();
    const usage = h.store.listEvents({ kind: 'launch.usage' });
    expect(usage).toHaveLength(1);
    expect(usage[0]!.payload).toEqual({ tokens, source: 'codex' });
    const s = h.orch.status();
    expect(s.tokens).toEqual({ run: tokens, byTask: { T1: tokens } });
    expect(s.cost).toMatchObject({ runUsd: 0, byTask: {}, unpricedLaunches: 1 });
    expect(s.paused).toBe(false);
    expect(s.pausedReason).toBeUndefined();
    expect(s.byStatus.running).toEqual(['T5']);
    expect(s.liveLaunches[0]?.tokens).toBeUndefined();
  });

  it('tokens priced from budgets.prices count toward the run cost budget; two priced launches past it pause admission', async () => {
    const h = harness({ runner: { kind: 'codex' }, budgets: budgets({ maxRunCostUsd: 5, prices: { 'gpt-6-astra': { inputPerMTok: 100, outputPerMTok: 1000 } } }), capacity: 1 });
    const tokens = { input: 40361, output: 260 };
    h.runners.codex.usageScript.set('T1', { tokens, source: 'codex' });
    h.runners.codex.usageScript.set('T5', { tokens, source: 'codex' });
    await h.orch.tick();
    expect(h.launchOf('T1')).toMatchObject({ runner: 'codex', model: 'gpt-6-astra' });
    await h.submit('T1');
    await h.orch.settle();
    await h.orch.tick();
    // 40361 * 100 / 1e6 + 260 * 1000 / 1e6
    expect(h.store.listLaunches({ taskId: 'T1' })[0]).toMatchObject({ tokens, costUsd: 4.2961, costSource: 'priced', usageSource: 'codex' });
    expect(h.store.listEvents({ kind: 'launch.usage' })[0]?.payload).toMatchObject({ tokens, costUsd: 4.2961, costSource: 'priced' });
    expect(h.orch.status().cost).toMatchObject({ runUsd: 4.2961, unpricedLaunches: 0 });
    expect(h.orch.status().byStatus.running).toEqual(['T5']);
    await h.submit('T5');
    await h.orch.settle();
    await h.orch.tick();
    await h.orch.tick();
    const s = h.orch.status();
    expect(s.paused).toBe(true);
    expect(s.pausedReason).toBe('costBudget');
    expect(s.cost).toMatchObject({ runUsd: 8.5922, byTask: { T1: 4.2961, T5: 4.2961 }, ceilingUsd: 5, unpricedLaunches: 0 });
    expect(s.tokens.run).toEqual({ input: 80722, output: 520 });
    expect(s.byStatus.running).toEqual([]);
    expect(h.store.listEvents({ kind: 'budget.exceeded' })).toMatchObject([{ payload: { runUsd: 8.5922, ceilingUsd: 5 } }]);
  });

  it('a runner-reported cost is kept as reported and never re-priced', async () => {
    const h = harness({ runner: { kind: 'codex' }, budgets: budgets({ prices: { 'gpt-6-astra': { inputPerMTok: 100, outputPerMTok: 1000 } } }) });
    h.runners.codex.usageScript.set('T1', { costUsd: 0.5, tokens: { input: 40361, output: 260 }, source: 'scripted' });
    await h.orch.tick();
    await h.submit('T1');
    await h.orch.settle();
    await h.orch.tick();
    expect(h.store.listLaunches({ taskId: 'T1' })[0]).toMatchObject({ costUsd: 0.5, costSource: 'reported', usageSource: 'scripted' });
    expect(h.orch.status().cost).toMatchObject({ runUsd: 0.5, byTask: { T1: 0.5 }, unpricedLaunches: 0 });
  });
});
