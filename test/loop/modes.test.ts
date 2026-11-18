import { afterEach, describe, expect, it } from 'vitest';
import type { Config, ConfigInput } from '../../src/config.js';
import { makeHarness, type Harness } from './harness.js';

const open: Harness[] = [];
afterEach(() => {
  for (const h of open.splice(0)) h.cleanup();
});

function harness(runner: Partial<Config['runner']> = {}, config: ConfigInput = {}): Harness {
  const h = makeHarness({ config: { runner: { mode: 'spawn', claimWindowMs: 60_000, ...runner }, tickIntervalMs: 100, health: { stuckAfterMs: 0, stuckFailAfterMs: 0, reportGraceMs: 0, baseMovedNotice: true }, budgets: { maxLaunchMs: 0, maxRunCostUsd: 0 }, ...config } });
  open.push(h);
  return h;
}

const parked = (h: Harness) => h.store.listLaunches({ status: 'claimable' }).map((l) => l.taskId).sort();

describe('runner modes', () => {
  it('pull parks launches and never spawns; a parked launch outlives the lease TTL and holds a capacity slot', async () => {
    const h = harness({ mode: 'pull' }, { capacity: 2 });
    await h.orch.tick();
    expect(parked(h)).toEqual(['T1', 'T5']);
    expect(h.runner.spawned).toEqual([]);
    expect(h.orch.status()).toMatchObject({ claimable: ['T1', 'T5'], workers: [], runner: { mode: 'pull', claimWindowMs: 60_000 } });
    expect(h.orch.status().byStatus.running.sort()).toEqual(['T1', 'T5']);
    expect(h.store.listEvents({ kind: 'launch.claimable' })).toHaveLength(2);
    h.advance(h.orch.config.leaseTtlMs * 3);
    await h.orch.tick();
    expect(parked(h)).toEqual(['T1', 'T5']);
    expect(h.orch.entry('T1')).toMatchObject({ attempts: 0, status: { kind: 'running' } });

    // A claimed T1 completes; T2 and T3 become ready but only one slot is free beside parked T5.
    const c = await h.orch.claim({ workerId: 'w1' });
    expect(c.status).toBe(200);
    expect(c.body).toMatchObject({ taskId: 'T1', workerId: 'w1' });
    const l1 = h.store.getLaunch(String(c.body['launchId']))!;
    expect(l1).toMatchObject({ status: 'live', worker: { id: 'w1' } });
    await h.orch.agentCall(l1.launchId, l1.token, 'report', { seq: 1, kind: 'submit', summary: 'done' });
    await h.orch.settle();
    expect(h.statusOf('T1')).toBe('done');
    expect(parked(h)).toHaveLength(2);
    expect(parked(h)).toContain('T5');
    expect(h.orch.status().byStatus.running).toHaveLength(2);
  });

  it('mixed spawns a parked launch after its window; spawn mode never parks', async () => {
    const h = harness({ mode: 'mixed', claimWindowMs: 2000 });
    await h.orch.tick();
    expect(parked(h)).toEqual(['T1', 'T5']);
    h.advance(1000);
    await h.orch.tick();
    expect(parked(h)).toEqual(['T1', 'T5']);
    h.advance(1500);
    await h.orch.tick();
    expect(parked(h)).toEqual([]);
    for (const id of ['T1', 'T5']) {
      const l = h.launchOf(id);
      expect(l.status).toBe('live');
      expect(l.worker).toBeUndefined();
      expect(l.pid).toBeGreaterThan(0);
      expect(h.store.listEvents({ launchId: l.launchId }).map((e) => e.kind)).toEqual(['launch.created', 'launch.claimable', 'launch.live']);
    }
    expect(h.runner.spawned.map((l) => l.taskId).sort()).toEqual(['T1', 'T5']);

    const spawn = harness();
    await spawn.orch.tick();
    expect(spawn.store.listLaunches({ status: 'claimable' })).toEqual([]);
    expect(spawn.store.listEvents({ kind: 'launch.claimable' })).toEqual([]);
    expect(spawn.launchOf('T1').pid).toBeGreaterThan(0);
  });

  it('a mode switch drains parked launches on the next tick, pause holds them, and reap leaves a claimed launch live', async () => {
    const h = harness({ mode: 'pull' });
    await h.orch.tick();
    expect(parked(h)).toEqual(['T1', 'T5']);
    h.orch.pause();
    h.orch.setMode('spawn');
    expect(h.orch.effectiveMode()).toBe('spawn');
    expect(h.store.listEvents({ kind: 'operator.mode' })).toMatchObject([{ payload: { mode: 'spawn' } }]);
    await h.orch.tick();
    expect(parked(h)).toEqual(['T1', 'T5']); // paused: still parked
    expect((await h.orch.claim({ workerId: 'w1' })).status).toBe(404);
    expect((await h.orch.claim({ workerId: 'w1' })).body).toMatchObject({ paused: true });
    h.orch.resume();
    await h.orch.tick();
    expect(parked(h)).toEqual([]);
    expect(h.runner.spawned.map((l) => l.taskId).sort()).toEqual(['T1', 'T5']);

    const pull = harness({ mode: 'pull' });
    await pull.orch.tick();
    const c = await pull.orch.claim({ workerId: 'w1', taskId: 'T1' });
    expect(c.status).toBe(200);
    await pull.orch.stop({ reap: true });
    expect(pull.store.getLaunch(String(c.body['launchId']))).toMatchObject({ status: 'live', worker: { id: 'w1' } });
    expect(pull.orch.entry('T1').status.kind).toBe('running');
    expect(parked(pull)).toEqual(['T5']);
  });

  it('mixed: a claim that lands while the spawn pass awaits another launch keeps its launch, worktree and single agent', async () => {
    const h = harness({ mode: 'mixed', claimWindowMs: 2000 });
    await h.orch.tick();
    expect(parked(h)).toEqual(['T1', 'T5']);
    h.advance(2500);

    // Hold the first prepare of the pass open; record every remove and prepare the pass makes.
    const prepare = h.workspace.prepare.bind(h.workspace);
    const remove = h.workspace.remove.bind(h.workspace);
    const prepared: string[] = [];
    const removed: string[] = [];
    let entered!: (launchId: string) => void;
    const enteredP = new Promise<string>((r) => (entered = r));
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    h.workspace.prepare = async (launch, brief) => {
      prepared.push(launch.launchId);
      if (prepared.length === 1) {
        entered(launch.launchId);
        await released;
      }
      return prepare(launch, brief);
    };
    h.workspace.remove = async (launch) => {
      removed.push(launch.launchId);
      return remove(launch);
    };

    const tick = h.orch.tick();
    const heldId = await enteredP;
    const other = h.store.listLaunches({ status: 'claimable' }).find((l) => l.launchId !== heldId)!;
    expect(other).toBeDefined();
    const briefBefore = h.workspace.briefs.get(other.launchId);
    const c = await h.orch.claim({ workerId: 'w1', taskId: other.taskId });
    expect(c.status).toBe(200);
    release();
    await tick;

    const claimed = h.store.getLaunch(other.launchId)!;
    expect(claimed).toMatchObject({ status: 'live', worker: { id: 'w1' } });
    expect(claimed.pid).toBeUndefined();
    expect(removed).not.toContain(other.launchId);
    expect(prepared).not.toContain(other.launchId);
    expect(h.workspace.worktrees.has(other.launchId)).toBe(true);
    expect(h.workspace.briefs.get(other.launchId)).toBe(briefBefore);
    expect(h.store.listEvents({ launchId: other.launchId }).map((e) => e.kind)).toEqual(['launch.created', 'launch.claimable', 'launch.claimed']);
    expect(h.runner.spawned.map((l) => l.launchId)).toEqual([heldId]);
    expect(h.store.getLaunch(heldId)).toMatchObject({ status: 'live' });
    expect(h.orch.entry(other.taskId)).toMatchObject({ status: { kind: 'running' }, lease: { launchId: other.launchId } });
  });

  it('mixed: a parked launch whose re-prepare fails does not stay launching; its attempt ends with a reason and the task is launched again', async () => {
    const h = harness({ mode: 'mixed', claimWindowMs: 2000 }, { capacity: 1 });
    await h.orch.tick();
    expect(parked(h)).toEqual(['T1']);
    const first = h.store.listLaunches({ status: 'claimable' })[0]!;
    h.advance(2500);
    const prepare = h.workspace.prepare.bind(h.workspace);
    let failures = 1;
    h.workspace.prepare = async (launch, brief) => {
      if (failures-- > 0) throw new Error('disk full');
      return prepare(launch, brief);
    };
    await h.orch.tick();

    expect(h.store.listLaunches({ status: 'launching' })).toEqual([]);
    expect(h.store.getLaunch(first.launchId)).toMatchObject({ status: 'ended', endReason: 'spawnFailed' });
    const ended = h.store.listEvents({ kind: 'launch.ended', launchId: first.launchId });
    expect(ended).toMatchObject([{ payload: { endReason: 'spawnFailed', stage: 'prepare', error: 'disk full' } }]);
    expect(h.runner.spawned.map((l) => l.launchId)).not.toContain(first.launchId);
    expect(h.workspace.worktrees.has(first.launchId)).toBe(false);
    // The failed attempt is recorded and charged; the task is launched again on a new launch, parked for its window.
    const e = h.orch.entry('T1');
    expect(e.attempts).toBe(1);
    expect(e.status.kind).toBe('running');
    expect(e.lease?.launchId).not.toBe(first.launchId);
    expect(h.store.getLaunch(e.lease!.launchId)).toMatchObject({ status: 'claimable', attempt: 2 });
    expect(e.carry?.priorFailure).toMatchObject({ kind: 'exitedWithoutReport', detail: { spawnFailed: true, stage: 'prepare' } });

    // After the new window the pass spawns it: one agent, live.
    h.advance(2500);
    await h.orch.tick();
    expect(h.store.getLaunch(e.lease!.launchId)).toMatchObject({ status: 'live' });
    expect(h.runner.spawned.map((l) => l.launchId)).toEqual([e.lease!.launchId]);
  });

  it('mixed: a parked worktree that cannot be removed fails the spawn instead of preparing over it', async () => {
    const h = harness({ mode: 'mixed', claimWindowMs: 2000 }, { capacity: 1 });
    await h.orch.tick();
    const first = h.store.listLaunches({ status: 'claimable' })[0]!;
    h.advance(2500);
    h.workspace.failRemovals.push(first.launchId);
    let prepares = 0;
    const prepare = h.workspace.prepare.bind(h.workspace);
    h.workspace.prepare = async (launch, brief) => {
      if (launch.launchId === first.launchId) prepares++;
      return prepare(launch, brief);
    };
    await h.orch.tick();
    expect(prepares).toBe(0);
    expect(h.store.listLaunches({ status: 'launching' })).toEqual([]);
    expect(h.store.listEvents({ kind: 'launch.ended', launchId: first.launchId })).toMatchObject([{ payload: { endReason: 'spawnFailed', stage: 'remove' } }]);
    expect(h.runner.spawned).toEqual([]);
    expect(h.orch.entry('T1').lease?.launchId).not.toBe(first.launchId);
    expect(h.workspace.worktrees.has(first.launchId)).toBe(false);
  });

  it('mixed: a prepare that always fails ends in blocked, never running on a preparing or launching row', async () => {
    const h = harness({ mode: 'mixed', claimWindowMs: 2000 }, { capacity: 1, maxAttempts: 3 });
    await h.orch.tick();
    h.workspace.prepare = async () => {
      throw new Error('disk full');
    };
    for (let i = 0; i < 4; i++) {
      h.advance(2500);
      await h.orch.tick(); // never throws out of the tick
      expect(h.store.listLaunches({ status: ['preparing', 'launching'] })).toEqual([]);
      const e = h.orch.entry('T1');
      if (e.status.kind === 'running') expect(h.store.getLaunch(e.lease!.launchId)!.status).toBe('claimable');
    }
    const e = h.orch.entry('T1');
    expect(e.attempts).toBe(3);
    expect(e.status).toMatchObject({ kind: 'blocked', reason: { kind: 'impossible' } });
    expect(String((e.status as { reason: { message: string } }).reason.message)).toContain('prepare failed: disk full');
    // The parked launch failed in the spawn pass; the admission relaunches failed in their own prepare.
    const ended = h.store.listEvents({ kind: 'launch.ended' }).filter((ev) => ev.taskId === 'T1');
    expect(ended.map((ev) => [ev.payload?.['endReason'], ev.payload?.['stage']])).toEqual([
      ['spawnFailed', 'prepare'],
      ['spawnFailed', 'prepare'],
      ['spawnFailed', 'prepare'],
    ]);
    expect(h.runner.spawned).toEqual([]);
  });

  it('a spawn that throws ends the launch at stage spawn, removes its prepared worktree and launches the task again', async () => {
    const h = harness({ mode: 'mixed', claimWindowMs: 2000 }, { capacity: 1 });
    await h.orch.tick();
    const first = h.store.listLaunches({ status: 'claimable' })[0]!;
    h.advance(2500);
    const spawn = h.runner.spawn.bind(h.runner);
    let failures = 1;
    h.runner.spawn = async (launch) => {
      if (failures-- > 0) throw new Error('exec failed');
      return spawn(launch);
    };
    await h.orch.tick();
    expect(h.store.listLaunches({ status: 'launching' })).toEqual([]);
    expect(h.store.listEvents({ kind: 'launch.ended', launchId: first.launchId })).toMatchObject([{ payload: { endReason: 'spawnFailed', stage: 'spawn', error: 'exec failed' } }]);
    expect(h.workspace.worktrees.has(first.launchId)).toBe(false);
    const e = h.orch.entry('T1');
    expect(e).toMatchObject({ attempts: 1, status: { kind: 'running' } });
    expect(e.lease?.launchId).not.toBe(first.launchId);

    // Spawn mode: a spawn that throws at admission ends the launch the same way instead of escaping the tick.
    const s = harness({}, { capacity: 1 });
    const sspawn = s.runner.spawn.bind(s.runner);
    let sfail = 1;
    s.runner.spawn = async (launch) => {
      if (sfail-- > 0) throw new Error('exec failed');
      return sspawn(launch);
    };
    await s.orch.tick();
    expect(s.store.listLaunches({ status: ['preparing', 'launching'] })).toEqual([]);
    expect(s.store.listEvents({ kind: 'launch.ended' })).toMatchObject([{ payload: { endReason: 'spawnFailed', stage: 'spawn' } }]);
    expect(s.orch.entry('T1')).toMatchObject({ attempts: 1, status: { kind: 'unstarted' } });
    await s.orch.tick();
    expect(s.launchOf('T1').pid).toBeGreaterThan(0);
  });

  it('claim semantics in-process: oldest first, named task, idempotent re-claim, one launch per worker, remote refused on a local run', async () => {
    const h = harness({ mode: 'pull' });
    await h.orch.tick();
    expect((await h.orch.claim({ workerId: 'w1', access: 'remote' })).status).toBe(409);
    expect((await h.orch.claim({ workerId: 'w2', taskId: 'T9' })).status).toBe(404);
    const first = await h.orch.claim({ workerId: 'w1' });
    expect(first.body).toMatchObject({ taskId: 'T1', repeated: false });
    const again = await h.orch.claim({ workerId: 'w1' });
    expect(again.body).toMatchObject({ taskId: 'T1', launchId: first.body['launchId'], token: first.body['token'], repeated: true });
    expect((await h.orch.claim({ workerId: 'w1', taskId: 'T5' })).status).toBe(409);
    expect((await h.orch.claim({ workerId: 'w2', taskId: 'T1' })).status).toBe(409);
    expect((await h.orch.claim({ workerId: 'w2', taskId: 'T1' })).body).toMatchObject({ state: 'live' });
    const second = await h.orch.claim({ workerId: 'w2' });
    expect(second.body).toMatchObject({ taskId: 'T5' });
    expect((await h.orch.claim({ workerId: 'w3' })).status).toBe(404);
    expect(h.orch.status().workers.map((w) => [w.id, w.taskId])).toEqual([['w1', 'T1'], ['w2', 'T5']]);
    expect(h.store.listEvents({ kind: 'launch.claimed' }).map((e) => e.payload?.['workerId'])).toEqual(['w1', 'w2']);
  });
});
