import { afterEach, describe, expect, it } from 'vitest';
import { CRASH_POINTS, setCrashHook } from '../../src/crash.js';
import { recover } from '../../src/launch/recovery.js';
import { Orchestrator } from '../../src/loop/orchestrator.js';
import { makeHarness, type Harness } from './harness.js';

const open: Harness[] = [];
afterEach(() => {
  setCrashHook(undefined);
  delete process.env['ORCH_CRASH_AT'];
  for (const h of open.splice(0)) h.cleanup();
});

function harness(): Harness {
  const h = makeHarness();
  open.push(h);
  return h;
}

/** T1 done; T2 running on its second attempt; T3 submitted with a queued job; T5 running. */
async function midRun(h: Harness): Promise<void> {
  await h.orch.tick();
  await h.submit('T1');
  await h.orch.settle();
  expect(h.statusOf('T1')).toBe('done');
  await h.failTask('T2', 'first try');
  await h.orch.tick();
  expect(h.orch.entry('T2')).toMatchObject({ status: { kind: 'running' }, attempts: 1, launches: 2 });
  await h.submit('T3');
  expect(h.statusOf('T3')).toBe('submitted');
  expect(h.store.listJobs({ taskId: 'T3', status: 'queued' })).toHaveLength(1);
}

describe('cascade reopen', () => {
  it('plain reopen is refused with blockers; cascade returns the plan and applies it in one tick with budgets reset and revision context', async () => {
    const h = harness();
    await midRun(h);
    const plain = h.orch.reopen('T1');
    expect(plain).toMatchObject({ ok: false, blockers: ['T2', 'T3'] });
    expect(h.statusOf('T1')).toBe('done');

    const l2 = h.launchOf('T2');
    const job = h.store.listJobs({ taskId: 'T3' })[0]!;
    const r = h.orch.reopen('T1', { cascade: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.reset.map((s) => s.id).sort()).toEqual(['T1', 'T2', 'T3']);
    expect(r.reset).toContainEqual({ id: 'T2', from: 'running' });
    expect(r.reset).toContainEqual({ id: 'T3', from: 'submitted' });
    expect(r.reset.at(-1)).toEqual({ id: 'T1', from: 'done' });
    expect(h.store.listEvents({ kind: 'operator.reopen' }).at(-1)?.payload).toMatchObject({ cascade: true, plan: r.reset });
    expect(h.orch.pendingCascade()).toMatchObject({ target: 'T1' });
    // Nothing is applied until the tick.
    expect(h.statusOf('T2')).toBe('running');
    expect(h.orch.reopen('T1', { cascade: true })).toMatchObject({ ok: false, reason: expect.stringContaining('already pending') });

    await h.orch.tick();
    expect(h.orch.pendingCascade()).toBeUndefined();
    expect(h.runner.isAlive(l2.launchId)).toBe(false);
    expect(h.store.getLaunch(l2.launchId)).toMatchObject({ status: 'ended', endReason: 'cascade' });
    expect(h.store.getJob(job.jobId)).toMatchObject({ status: 'dropped', applied: true });
    expect(h.orch.entry('T2')).toMatchObject({ attempts: 0, integrationRetries: 0, launches: 2 });
    expect(h.orch.entry('T3').status.kind).not.toBe('submitted');
    // T1 relaunched in the same tick (its deps are satisfied); T2 and T3 wait for it.
    expect(h.statusOf('T1')).toBe('running');
    expect(h.orch.entry('T1').launches).toBe(2);
    expect(['unstarted', 'running']).toContain(h.statusOf('T2'));
    expect(h.statusOf('T5')).toBe('running');
    const t1Brief = h.workspace.briefs.get(h.launchOf('T1').launchId)!;
    expect(t1Brief.carry?.['revision']).toMatchObject({ cause: 'reopened', priorLaunchId: expect.any(String), priorBranch: 'task/T1/l1', priorPublishedSha: expect.stringMatching(/^pub-T1-/), priorReportSummary: 'did T1' });
    expect(h.store.listEvents({ kind: 'transition', taskId: 'T2' }).at(-1)?.payload).toMatchObject({ from: 'running', to: 'unstarted', trigger: 'cascade', cascade: 'T1' });
    expect(h.store.listEvents({ kind: 'transition', taskId: 'T3' }).at(-1)?.payload).toMatchObject({ from: 'submitted', to: 'unstarted', trigger: 'cascade' });

    await h.submit('T1');
    await h.orch.settle();
    expect(h.statusOf('T2')).toBe('running');
    const t2Brief = h.workspace.briefs.get(h.launchOf('T2').launchId)!;
    expect(t2Brief.carry?.['revision']).toMatchObject({ cause: 'upstreamReopened', upstream: 'T1', priorBranch: 'task/T2/l2' });
    expect(t2Brief.carry?.['revision']).not.toHaveProperty('priorPublishedSha');
    expect(h.orch.entry('T2').launches).toBe(3);
  });

  it('is refused while a planned node is publishing, and a dropped job never publishes', async () => {
    const h = harness();
    await midRun(h);
    const job = h.store.listJobs({ taskId: 'T3' })[0]!;
    h.store.updateJob(job.jobId, { status: 'publishing' });
    expect(h.orch.reopen('T1', { cascade: true })).toEqual({ ok: false, reason: expect.stringContaining('T3'), publishing: 'T3' });
    expect(h.orch.pendingCascade()).toBeUndefined();
    expect(h.store.listEvents({ kind: 'operator.reopen' })).toEqual([]);
    h.store.updateJob(job.jobId, { status: 'queued' });
    expect(h.orch.reopen('T1', { cascade: true })).toMatchObject({ ok: true });
    await h.orch.tick();
    await h.orch.settle();
    expect(h.store.getJob(job.jobId)?.status).toBe('dropped');
    expect(h.verifier.runs.map((j) => j.jobId)).not.toContain(job.jobId);
    expect(h.store.listJobs({ status: 'published' }).map((j) => j.taskId)).toEqual(['T1']);
  });

  it('a milestone-only closure needs no cascade: plain reopen resets the milestone', async () => {
    const h = harness();
    await h.orch.tick();
    await h.submit('T5');
    await h.orch.settle();
    expect(h.orch.reopen('T5')).toEqual({ ok: true, reset: [{ id: 'T5', from: 'done' }] });
  });

  it('a crash at cascade.afterPlan is recovered: the plan is applied once by recovery and the marker cleared', async () => {
    const h = harness();
    await midRun(h);
    let crashed: string | undefined;
    process.env['ORCH_CRASH_AT'] = 'cascade.afterPlan';
    setCrashHook((name) => {
      crashed = name;
    });
    expect(CRASH_POINTS).toContain('cascade.afterPlan');
    expect(h.orch.reopen('T1', { cascade: true })).toMatchObject({ ok: true });
    expect(crashed).toBe('cascade.afterPlan');
    setCrashHook(undefined);
    delete process.env['ORCH_CRASH_AT'];
    const l2 = h.launchOf('T2');
    // "Restart": a fresh orchestrator over the same store runs recovery before its first tick.
    const o2 = new Orchestrator({ store: h.store, config: h.orch.config, graphSource: h.source, runner: h.runner, workspace: h.workspace, verifier: h.verifier, clock: () => h.now.value });
    await o2.loadGraph();
    await recover(o2);
    expect(o2.pendingCascade()).toBeUndefined();
    expect(o2.entry('T1').status.kind).toBe('unstarted');
    expect(o2.entry('T2')).toMatchObject({ status: { kind: 'unstarted' }, attempts: 0 });
    expect(o2.entry('T3').status.kind).toBe('unstarted');
    expect(h.store.getLaunch(l2.launchId)).toMatchObject({ status: 'ended', endReason: 'cascade' });
    expect(h.runner.isAlive(l2.launchId)).toBe(false);
    await o2.tick();
    expect(o2.entry('T1').status.kind).toBe('running');
  });

  it('a crash mid-cascade resets only what is still started', async () => {
    const h = harness();
    await midRun(h);
    expect(h.orch.reopen('T1', { cascade: true })).toMatchObject({ ok: true });
    // As if the first reset (T3) had been applied before the crash.
    h.store.transaction(() => {
      for (const j of h.store.listJobs({ taskId: 'T3', status: 'queued' })) h.store.dropJob(j.jobId);
      h.orch.transition('T3', { kind: 'unstarted' }, 'human', 'cascade');
    });
    const t3Transitions = h.store.listEvents({ kind: 'transition', taskId: 'T3' }).length;
    const o2 = new Orchestrator({ store: h.store, config: h.orch.config, graphSource: h.source, runner: h.runner, workspace: h.workspace, verifier: h.verifier, clock: () => h.now.value });
    await o2.loadGraph();
    await recover(o2);
    expect(o2.pendingCascade()).toBeUndefined();
    expect(h.store.listEvents({ kind: 'transition', taskId: 'T3' })).toHaveLength(t3Transitions);
    expect(o2.entry('T2').status.kind).toBe('unstarted');
    expect(o2.entry('T1').status.kind).toBe('unstarted');
  });
});
