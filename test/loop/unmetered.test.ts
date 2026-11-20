// See specs/health-monitoring "Usage accounting: unmetered launches", specs/operator-control "Status report: unmetered launches"
// and specs/operator-mcp "Wait digest: unmeteredLaunches".
import { afterEach, describe, expect, it } from 'vitest';
import type { Config, ConfigInput } from '../../src/config.js';
import { Orchestrator } from '../../src/loop/orchestrator.js';
import { digestOf } from '../../src/operator/routes.js';
import { makeHarness, type Harness } from './harness.js';

const open: Harness[] = [];
afterEach(() => {
  for (const h of open.splice(0)) h.cleanup();
});

const health = (over: Partial<Config['health']> = {}): Config['health'] => ({ stuckAfterMs: 0, stuckFailAfterMs: 0, reportGraceMs: 0, baseMovedNotice: true, ...over });
const budgets = (over: Partial<Config['budgets']> = {}): Config['budgets'] => ({ maxLaunchMs: 0, maxRunCostUsd: 0, prices: {}, ...over });

function harness(config: ConfigInput = {}): Harness {
  const h = makeHarness({ config: { tickIntervalMs: 100, health: health(), budgets: budgets(), ...config } });
  open.push(h);
  return h;
}

const unmetered = (h: Harness) => h.orch.status().cost.unmeteredLaunches;

async function endSpawned(h: Harness, taskId: string): Promise<void> {
  await h.submit(taskId);
  await h.orch.settle();
  await h.orch.tick();
}

describe('unmetered launches', () => {
  it('criterion 1: a spawned launch that ends with no usage counts 1; the same launch with a scripted usage counts 0', async () => {
    const bare = harness({ capacity: 1 });
    await bare.orch.tick();
    const l1 = bare.launchOf('T1');
    expect(l1.spawnedAt).toBeDefined();
    expect(unmetered(bare)).toBe(0);
    await endSpawned(bare, 'T1');
    expect(bare.store.getLaunch(l1.launchId)).toMatchObject({ status: 'ended' });
    expect(bare.store.listEvents({ kind: 'launch.usage' })).toHaveLength(0);
    expect(unmetered(bare)).toBe(1);
    expect(bare.orch.status().cost).toMatchObject({ runUsd: 0, unpricedLaunches: 0, unmeteredLaunches: 1 });

    const scripted = harness({ capacity: 1 });
    scripted.runner.usageScript.set('T1', { costUsd: 0.5, turns: 2 });
    await scripted.orch.tick();
    const s1 = scripted.launchOf('T1');
    await endSpawned(scripted, 'T1');
    expect(scripted.store.getLaunch(s1.launchId)).toMatchObject({ status: 'ended', costUsd: 0.5 });
    expect(unmetered(scripted)).toBe(0);
  });

  it("criterion 2: a claimed, submitted and ended launch counts 1; after its worker's usage post it counts 0 with one launch.usage event", async () => {
    const h = harness({ runner: { mode: 'pull', claimWindowMs: 60_000 }, capacity: 1 });
    await h.orch.tick();
    const c = await h.orch.claim({ workerId: 'w1' });
    expect(c.body).toMatchObject({ taskId: 'T1' });
    const l1 = h.store.getLaunch(String(c.body['launchId']))!;
    expect(l1.worker).toBeDefined();
    expect(unmetered(h)).toBe(0);
    await h.orch.agentCall(l1.launchId, l1.token, 'report', { seq: 1, kind: 'submit', summary: 'done' });
    await h.orch.tick();
    await h.orch.settle();
    expect(h.store.getLaunch(l1.launchId)).toMatchObject({ status: 'ended' });
    expect(unmetered(h)).toBe(1);

    const tokens = { input: 1000, output: 100 };
    expect(h.orch.recordWorkerUsage(l1.launchId, { workerId: 'w1', usage: { tokens, costUsd: 0.25 } })).toMatchObject({ status: 200, body: { ok: true, recorded: true } });
    expect(unmetered(h)).toBe(0);
    expect(h.orch.status().cost).toMatchObject({ runUsd: 0.25, unmeteredLaunches: 0 });
    expect(h.store.listEvents({ kind: 'launch.usage', launchId: l1.launchId })).toHaveLength(1);
  });

  it('criterion 3: a live launch, a parked launch ended unclaimed by a cancel, and a launch with tokens and no price are not counted', async () => {
    // A live spawned launch.
    const live = harness({ capacity: 1 });
    await live.orch.tick();
    expect(live.launchOf('T1').status).toBe('live');
    expect(unmetered(live)).toBe(0);

    // A parked launch whose task is cancelled ends unclaimed: no agent ever had it.
    const parked = harness({ runner: { mode: 'pull', claimWindowMs: 60_000 }, capacity: 1 });
    await parked.orch.tick();
    const [p] = parked.store.listLaunches({ taskId: 'T1', status: 'claimable' });
    expect(p).toBeDefined();
    expect(parked.orch.cancel('T1', 'not needed')).toEqual({ ok: true });
    await parked.orch.tick();
    await parked.orch.settle();
    const after = parked.store.getLaunch(p!.launchId)!;
    expect(['ended', 'revoked']).toContain(after.status);
    expect(after.worker).toBeUndefined();
    expect(after.spawnedAt).toBeUndefined();
    expect(unmetered(parked)).toBe(0);

    // Tokens with no price: unpriced, not unmetered.
    const unpriced = harness({ runner: { kind: 'codex' }, capacity: 1 });
    const tokens = { input: 40361, output: 260 };
    unpriced.runners.codex.usageScript.set('T1', { tokens, source: 'codex' });
    await unpriced.orch.tick();
    await endSpawned(unpriced, 'T1');
    expect(unpriced.store.listLaunches({ taskId: 'T1' })[0]).toMatchObject({ status: 'ended', tokens });
    expect(unpriced.orch.status().cost).toMatchObject({ unpricedLaunches: 1, unmeteredLaunches: 0 });
  });

  it('criterion 4: three unmetered launches under budgets.maxRunCostUsd 5 neither pause the run nor append budget.exceeded or config.warning', async () => {
    const h = harness({ budgets: budgets({ maxRunCostUsd: 5 }), capacity: 4 });
    await h.orch.tick();
    const warningsBefore = h.store.listEvents({ kind: 'config.warning' }).length;
    await endSpawned(h, 'T1');
    await endSpawned(h, 'T5');
    await h.orch.tick();
    // T1 done, so T2 and T3 start; end one of them for a third unmetered launch.
    await endSpawned(h, 'T2');
    await h.orch.tick();
    const s = h.orch.status();
    expect(s.cost.unmeteredLaunches).toBe(3);
    expect(s.cost.runUsd).toBe(0);
    expect(s.paused).toBe(false);
    expect(s.pausedReason).toBeUndefined();
    expect(h.store.listEvents({ kind: 'budget.exceeded' })).toEqual([]);
    expect(h.store.listEvents({ kind: 'config.warning' })).toHaveLength(warningsBefore);
    expect(warningsBefore).toBe(0);
  });

  it('criterion 5: the digest count equals the status count, is 0 without a graph, and a new orchestrator on the same store reports the same count', async () => {
    const h = harness({ capacity: 4 });
    await h.orch.tick();
    await endSpawned(h, 'T1');
    await endSpawned(h, 'T5');
    const s = h.orch.status();
    expect(s.cost.unmeteredLaunches).toBe(2);
    expect(digestOf(h.orch)['unmeteredLaunches']).toBe(2);

    const again = new Orchestrator({ store: h.store, config: h.orch.config, graphSource: h.source, runner: h.runner, workspace: h.workspace, verifier: h.verifier, clock: () => h.now.value });
    await again.loadGraph();
    expect(again.status().cost.unmeteredLaunches).toBe(2);
    expect(digestOf(again)['unmeteredLaunches']).toBe(2);

    // Without a graph the digest says 0, even on a store that holds the two unmetered rows.
    const bare = new Orchestrator({ store: h.store, config: h.orch.config, graphSource: h.source, runner: h.runner, workspace: h.workspace, verifier: h.verifier, clock: () => h.now.value });
    expect(bare.hasGraph()).toBe(false);
    const digest = digestOf(bare);
    expect(digest['graphLoaded']).toBe(false);
    expect(digest['unmeteredLaunches']).toBe(0);
  });
});
