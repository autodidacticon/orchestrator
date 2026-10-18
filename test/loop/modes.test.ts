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

  it('claim semantics in-process: oldest first, named task, idempotent re-claim, one launch per worker, remote reserved', async () => {
    const h = harness({ mode: 'pull' });
    await h.orch.tick();
    expect((await h.orch.claim({ workerId: 'w1', access: 'remote' })).status).toBe(501);
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
