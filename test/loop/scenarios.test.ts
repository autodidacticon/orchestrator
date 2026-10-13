import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeHarness, runToQuiet, type Harness } from './harness.js';

let h: Harness;
beforeEach(() => {
  h = makeHarness();
});
afterEach(() => h.cleanup());

describe('inproc scenarios on the standard fixture', () => {
  it('happy path reaches finished after the gated milestone is accepted', async () => {
    await h.orch.tick();
    expect(h.orch.status().byStatus.running.sort()).toEqual(['T1', 'T5']);
    await runToQuiet(h);
    let s = h.orch.status();
    expect(s.awaitingReview).toEqual(['MVP']);
    expect(s.byStatus.done.sort()).toEqual(['T1', 'T2', 'T3', 'T4', 'T5']);
    expect(s.finished).toBe(false);
    const mvp = h.orch.entry('MVP');
    expect(mvp.reviewVersion).toBe(1);
    expect(h.workspace.tags).toEqual([{ id: 'MVP', version: 1, sha: mvp.integrationSha }]);
    expect(h.orch.acceptMilestone('MVP', mvp.integrationSha!, 1)).toEqual({ ok: true });
    await h.orch.settle();
    s = h.orch.status();
    expect(s.finished).toBe(true);
    // one verifier run per task, every launch ended
    expect(h.verifier.runs.map((j) => j.taskId).sort()).toEqual(['T1', 'T2', 'T3', 'T4', 'T5']);
    expect(h.store.listLaunches({ status: 'live' })).toEqual([]);
  });

  it('agent fail retries with context, then second failure blocks', async () => {
    await h.orch.tick();
    const first = h.launchOf('T1');
    await h.failTask('T1', 'cannot find schema');
    expect(h.statusOf('T1')).toBe('unstarted');
    expect(h.orch.entry('T1').attempts).toBe(1);
    expect(h.orch.entry('T1').carry?.priorFailure).toMatchObject({ kind: 'agentFail', message: 'cannot find schema' });
    await h.orch.tick();
    const second = h.launchOf('T1');
    expect(second.launchId).not.toBe(first.launchId);
    expect(second.attempt).toBe(2);
    expect(second.launchNo).toBe(2);
    expect(h.workspace.briefs.get(second.launchId)?.carry).toMatchObject({ priorFailure: { kind: 'agentFail' } });
    expect(h.store.getLaunch(first.launchId)?.status).toBe('ended');
    await h.failTask('T1', 'still cannot');
    expect(h.statusOf('T1')).toBe('blocked');
    await h.orch.settle();
    const s = h.orch.status();
    expect(s.stallRoots).toContain('T1');
  });

  it('cancel without release leaves dependents in stallRoots; with release they run', async () => {
    await h.orch.tick();
    expect(h.orch.cancel('T1', 'not needed', false)).toEqual({ ok: true });
    await h.orch.tick();
    expect(h.runner.isAlive(h.store.listLaunches({ taskId: 'T1' })[0]!.launchId)).toBe(false);
    await h.submit('T5');
    await h.orch.settle();
    let s = h.orch.status();
    expect(s.stalled).toBe(true);
    expect(s.stallRoots.sort()).toEqual(['T2', 'T3']);

    const h2 = makeHarness();
    try {
      await h2.orch.tick();
      h2.orch.cancel('T1', 'not needed', true);
      await h2.orch.tick();
      s = h2.orch.status();
      expect(s.byStatus.running.sort()).toEqual(['T2', 'T3', 'T5']);
      const brief = h2.workspace.briefs.get(h2.launchOf('T2').launchId)!;
      expect(brief.depReports[0]).toMatchObject({ taskId: 'T1', cancelled: { reason: 'not needed' } });
    } finally {
      h2.cleanup();
    }
  });

  it('reopen refused while a dependent runs, allowed after it fails', async () => {
    await h.orch.tick();
    await h.submit('T1');
    await h.orch.settle();
    expect(h.statusOf('T1')).toBe('done');
    expect(h.statusOf('T2')).toBe('running');
    const refused = h.orch.reopen('T1');
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.blockers).toEqual(expect.arrayContaining(['T2']));
    h.orch.cancel('T3', 'x');
    await h.failTask('T2', 'no');
    await h.orch.tick();
    await h.failTask('T2', 'no again', 1);
    expect(h.statusOf('T2')).toBe('blocked');
    expect(h.orch.reopen('T1')).toEqual({ ok: true });
    expect(h.statusOf('T1')).toBe('unstarted');
    expect(h.orch.entry('T1').attempts).toBe(0);
    expect(h.orch.entry('T1').launches).toBe(1);
  });

  it('gated milestone: reject, repair upstream, accept at version 2', async () => {
    await runToQuiet(h);
    const v1 = h.orch.entry('MVP');
    expect(v1.status.kind).toBe('submitted');
    expect(h.orch.acceptMilestone('MVP', v1.integrationSha!, 1)).toEqual({ ok: true }); // sanity that stale check works below
    h.orch.reopen('MVP');
    await h.orch.settle();
    expect(h.orch.entry('MVP').reviewVersion).toBe(2);
    expect(h.orch.rejectMilestone('MVP', 'demo failed: no login')).toEqual({ ok: true });
    expect(h.statusOf('MVP')).toBe('blocked');
    await h.orch.settle();
    await h.orch.settle();
    expect(h.statusOf('MVP')).toBe('blocked'); // rejection does not loop
    // repair: add T7 as a dependency of MVP (compatible: MVP is not started)
    h.source.set(`nodes:
  - { id: T1, deps: [] }
  - { id: T2, deps: [T1] }
  - { id: T3, deps: [T1] }
  - { id: T4, deps: [T2] }
  - { id: T5, deps: [] }
  - { id: T7, deps: [] }
  - { id: MVP, kind: milestone, gated: true, deps: [T3, T4, T7] }`);
    expect(h.orch.unblock('MVP')).toEqual({ ok: true });
    await h.orch.settle();
    expect(h.orch.status().graphRejected).toBeUndefined();
    expect(h.statusOf('MVP')).toBe('unstarted');
    expect(h.statusOf('T7')).toBe('running');
    await h.submit('T7');
    await h.orch.settle();
    const v3 = h.orch.entry('MVP');
    expect(v3.status.kind).toBe('submitted');
    expect(v3.reviewVersion).toBe(3);
    expect(h.orch.acceptMilestone('MVP', v3.integrationSha!, 2).ok).toBe(false);
    expect(h.orch.acceptMilestone('MVP', v3.integrationSha!, 3)).toEqual({ ok: true });
    expect(h.orch.status().finished).toBe(true);
  });

  it('pause stops admission while running work completes and verifies', async () => {
    await h.orch.tick();
    h.orch.pause();
    await h.submit('T1');
    await h.submit('T5');
    await h.orch.settle();
    const s = h.orch.status();
    expect(s.byStatus.done.sort()).toEqual(['T1', 'T5']);
    expect(s.byStatus.running).toEqual([]);
    expect(s.paused).toBe(true);
    h.orch.resume();
    await h.orch.tick();
    expect(h.orch.status().byStatus.running.sort()).toEqual(['T2', 'T3']);
  });

  it('waiting frees a slot and resume requires admission', async () => {
    h.cleanup();
    h = makeHarness({ config: { capacity: 1 } });
    await h.orch.tick();
    expect(h.orch.status().byStatus.running).toEqual(['T1']);
    const l1 = h.launchOf('T1');
    const pending = h.block('T1', 'which db?');
    await new Promise((r) => setImmediate(r));
    expect(h.statusOf('T1')).toBe('waiting');
    await h.orch.tick();
    expect(h.orch.status().byStatus.running).toEqual(['T5']); // slot freed
    expect(h.orch.answer('T1', 'postgres')).toEqual({ ok: true });
    await h.orch.tick();
    expect(h.statusOf('T1')).toBe('waiting'); // no slot: T5 still running
    await h.submit('T5');
    await h.orch.settle();
    expect(h.statusOf('T1')).toBe('running');
    const res = await pending;
    expect(res.body).toEqual({ answer: 'postgres' });
    // replay with the same seq returns the stored answer
    const again = await h.orch.agentCall(l1.launchId, l1.token, 'block', { seq: 2, kind: 'needsDecision', message: 'which db?' });
    expect(again.body).toEqual({ answer: 'postgres' });
    expect(h.store.listEvents({ kind: 'agent.block' })).toHaveLength(1);
  });

  it('maxWait degrades to blocked with the question kept; a later answer makes a new launch', async () => {
    h.cleanup();
    h = makeHarness({ config: { maxWaitMs: 1000 } });
    await h.orch.tick();
    const l1 = h.launchOf('T1');
    const pending = h.block('T1', 'which db?');
    await new Promise((r) => setImmediate(r));
    h.advance(1500);
    await h.orch.tick();
    expect((await pending).body).toMatchObject({ timeout: true });
    expect(h.orch.entry('T1').status).toMatchObject({ kind: 'blocked', reason: { kind: 'needsDecision', message: 'which db?' } });
    h.runner.die(l1.launchId);
    await h.orch.tick();
    expect(h.orch.answer('T1', 'sqlite')).toEqual({ ok: true });
    await h.orch.tick();
    const l2 = h.launchOf('T1');
    expect(l2.launchNo).toBe(2);
    expect(h.workspace.briefs.get(l2.launchId)?.carry).toMatchObject({ question: { message: 'which db?' }, answer: 'sqlite' });
  });

  it('process death without a report fails the attempt; with a fallback file it is applied', async () => {
    await h.orch.tick();
    const l1 = h.launchOf('T1');
    h.runner.die(l1.launchId);
    await h.orch.tick();
    expect(h.orch.entry('T1')).toMatchObject({ attempts: 1, launches: 2, status: { kind: 'running' } });
    expect(h.store.getLaunch(l1.launchId)?.status).toBe('ended');
    const l5 = h.launchOf('T5');
    h.workspace.fallbacks.set(l5.launchId, { launchId: l5.launchId, seq: 1, kind: 'submit', body: { summary: 'offline' } });
    h.runner.die(l5.launchId);
    await h.orch.settle();
    expect(h.statusOf('T5')).toBe('done');
    const l1b = h.launchOf('T1');
    h.workspace.fallbacks.set(l1b.launchId, { launchId: l1b.launchId, seq: 1, kind: 'block', body: { kind: 'needsAccess', message: 'need creds' } });
    h.runner.die(l1b.launchId);
    await h.orch.tick();
    expect(h.orch.entry('T1').status).toMatchObject({ kind: 'blocked', reason: { kind: 'needsAccess' } });
  });

  it('lease expiry fails the task and reaps the process when the runner cannot observe it', async () => {
    await h.orch.tick();
    const l1 = h.launchOf('T1');
    h.runner.unknownForAll = true;
    h.advance(h.orch.config.leaseTtlMs + 1);
    await h.orch.tick();
    expect(h.runner.isAlive(l1.launchId)).toBe(false);
    expect(h.orch.entry('T1')).toMatchObject({ attempts: 1, launches: 2, status: { kind: 'running' } });
    expect(h.store.listEvents({ kind: 'transition', taskId: 'T1' }).map((e) => e.payload?.['to'])).toEqual(['running', 'failed', 'unstarted', 'running']);
    expect(h.workspace.briefs.get(h.launchOf('T1').launchId)?.carry).toMatchObject({ priorFailure: { kind: 'leaseExpired' } });
  });

  it('heartbeat renews the lease', async () => {
    await h.orch.tick();
    const l1 = h.launchOf('T1');
    h.advance(h.orch.config.leaseTtlMs - 1);
    expect((await h.orch.agentCall(l1.launchId, l1.token, 'heartbeat')).status).toBe(200);
    h.advance(h.orch.config.leaseTtlMs - 1);
    await h.orch.tick();
    expect(h.statusOf('T1')).toBe('running');
  });

  it('submission checks: dirty 409, undeclared empty fails, declared passes, missing evidence fails', async () => {
    h.source.set(`nodes:
  - { id: A, deps: [], acceptanceCriteria: [works, documented] }
  - { id: B, deps: [] }
  - { id: C, deps: [] }`);
    await h.orch.tick();
    h.workspace.sealScript.set('A', { ok: false, dirty: ['src/a.ts'] });
    const dirty = await h.submit('A', { acceptance: [{ criterion: 'works', evidence: 't' }, { criterion: 'documented', evidence: 'd' }] });
    expect(dirty).toMatchObject({ status: 409, body: { error: 'dirtyWorktree', files: ['src/a.ts'] } });
    expect(h.statusOf('A')).toBe('running');
    h.workspace.sealScript.delete('A');
    const missing = await h.submit('A', { acceptance: [{ criterion: 'works', evidence: 't' }] });
    expect(missing.body).toMatchObject({ accepted: false, reason: 'missingAcceptanceEvidence', uncovered: ['documented'] });
    expect(h.orch.entry('A')).toMatchObject({ attempts: 1, status: { kind: 'unstarted' } });

    const lb = h.launchOf('B');
    h.workspace.scriptEmpty('B', lb.baseSha);
    const empty = await h.submit('B');
    expect(empty.body).toMatchObject({ accepted: false, reason: 'emptySubmission' });
    const lc = h.launchOf('C');
    h.workspace.scriptEmpty('C', lc.baseSha);
    const declared = await h.submit('C', { noChanges: { justification: 'research only' } });
    expect(declared.body).toMatchObject({ accepted: true });
    await h.orch.settle();
    expect(h.statusOf('C')).toBe('done');
  });

  it('token scoping and replay', async () => {
    await h.orch.tick();
    const l1 = h.launchOf('T1');
    const l5 = h.launchOf('T5');
    expect((await h.orch.agentCall(l1.launchId, l5.token, 'heartbeat')).status).toBe(401);
    expect((await h.orch.agentCall('nope', l1.token, 'heartbeat')).status).toBe(401);
    const first = await h.submit('T1');
    const replay = await h.submit('T1');
    expect(replay).toEqual(first);
    expect(h.store.listEvents({ kind: 'agent.report' })).toHaveLength(1);
    // ended launch cannot act
    await h.orch.settle();
    expect((await h.orch.agentCall(l1.launchId, l1.token, 'report', { seq: 9, kind: 'fail', why: 'late' })).status).toBe(401);
  });

  it('verifier red check fails with output; conflict retries with context and does not spend an attempt', async () => {
    h.verifier.on('T1', { kind: 'failed', reason: { kind: 'checkFailed', output: 'FAIL test_x' } });
    h.verifier.on('T5', { kind: 'conflict', files: ['shared.ts'], since: ['T1'] });
    await h.orch.tick();
    await h.submit('T1');
    await h.submit('T5');
    await h.orch.settle();
    expect(h.orch.entry('T1')).toMatchObject({ attempts: 1, launches: 2, status: { kind: 'running' } });
    expect(h.workspace.briefs.get(h.launchOf('T1').launchId)?.carry).toMatchObject({ priorFailure: { kind: 'checkFailed' }, verifierOutput: 'FAIL test_x' });
    expect(h.orch.entry('T5')).toMatchObject({ attempts: 0, integrationRetries: 1, launches: 2, status: { kind: 'running' } });
    expect(h.launchOf('T5').attempt).toBe(1);
    expect(h.workspace.briefs.get(h.launchOf('T5').launchId)?.carry).toMatchObject({ conflict: { files: ['shared.ts'], since: ['T1'], previousBranch: 'task/T5/l1' } });
  });

  it('integration cap exhaustion fails the task', async () => {
    h.cleanup();
    h = makeHarness({ config: { integrationRetries: 1, maxAttempts: 1 } });
    h.verifier.on('T5', { kind: 'conflict', files: ['a'], since: [] }, { kind: 'conflict', files: ['a'], since: [] });
    await h.orch.tick();
    await h.submit('T5');
    await h.orch.settle();
    expect(h.orch.entry('T5').integrationRetries).toBe(1);
    await h.orch.tick();
    await h.submit('T5');
    await h.orch.settle();
    expect(h.orch.entry('T5').status).toMatchObject({ kind: 'blocked' });
    expect(h.store.listEvents({ kind: 'transition', taskId: 'T5' }).map((e) => e.payload?.['to'])).toContain('failed');
  });

  it('chained automatic milestones complete in the tick that satisfies the first', async () => {
    h.cleanup();
    h = makeHarness({ graph: `nodes:\n  - { id: T1, deps: [] }\n  - { id: M1, kind: milestone, deps: [T1] }\n  - { id: M2, kind: milestone, deps: [M1] }` });
    await h.orch.tick();
    await h.submit('T1');
    await h.orch.settle();
    expect(h.orch.status().finished).toBe(true);
    expect(h.statusOf('M2')).toBe('done');
  });

  it('incompatible reload is rejected whole and reported; compatible add is accepted', async () => {
    await h.orch.tick();
    h.source.set(`nodes:\n  - { id: T1, deps: [T5] }\n  - { id: T2, deps: [T1] }\n  - { id: T3, deps: [T1] }\n  - { id: T4, deps: [T2] }\n  - { id: T5, deps: [] }\n  - { id: MVP, kind: milestone, gated: true, deps: [T3, T4] }`);
    await h.orch.tick();
    const s = h.orch.status();
    expect(s.graphRejected?.reasons[0]).toMatch(/T1/);
    expect(s.graphRev).toBe(h.orch.graph().rev);
    h.source.set(`${require_fixture()}\n  - { id: T6, deps: [T2] }`);
    await h.orch.tick();
    expect(h.orch.status().graphRejected).toBeUndefined();
    expect(h.statusOf('T6')).toBe('unstarted');
  });

  it('every operator action is an event', async () => {
    await h.orch.tick();
    h.orch.pause();
    h.orch.resume();
    h.orch.cancel('T5', 'x');
    const kinds = h.store.listEvents().map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(['operator.pause', 'operator.resume', 'operator.cancel']));
    const idx = kinds.indexOf('operator.cancel');
    expect(kinds[idx + 1]).toBe('transition');
  });
});

function require_fixture(): string {
  return `nodes:
  - { id: T1, title: Schema migration,  deps: [] }
  - { id: T2, title: Feature A API,     deps: [T1] }
  - { id: T3, title: Feature B API,     deps: [T1] }
  - { id: T4, title: Feature A UI,      deps: [T2] }
  - { id: T5, title: Changelog,         deps: [] }
  - { id: MVP, kind: milestone, gated: true, deps: [T3, T4] }`;
}
