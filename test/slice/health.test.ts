import { afterEach, describe, expect, it } from 'vitest';
import type { Config } from '../../src/config.js';
import { pidAlive } from '../../src/runner/subprocess.js';
import { gitIn, makeSlice, single, type SliceHarness } from './harness.js';

let h: SliceHarness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const health = (over: Partial<Config['health']> = {}): Config['health'] => ({ stuckAfterMs: 0, stuckFailAfterMs: 0, reportGraceMs: 0, baseMovedNotice: true, ...over });
const budgets: Config['budgets'] = { maxLaunchMs: 0, maxRunCostUsd: 0 };
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('health through real scripted agents', () => {
  it('a hung agent keeps its lease while alive, is flagged and nudged, then fails as stuck', async () => {
    h = await makeSlice({ graph: single('hang'), config: { leaseTtlMs: 500, maxAttempts: 1, tickIntervalMs: 100, health: health({ stuckAfterMs: 1200, stuckFailAfterMs: 2500 }), budgets } });
    await h.orch.tick();
    const l = h.launchOf('T1');
    const t0 = Date.now();
    await h.waitFor(() => Date.now() - t0 > 800);
    expect(h.orch.entry('T1')).toMatchObject({ status: { kind: 'running' }, attempts: 0 });
    expect(h.orch.entry('T1').lease!.expiresAt).toBeGreaterThan(Date.now());
    expect(pidAlive(l.pid!)).toBe(true);

    await h.waitFor(() => h!.store.getLaunch(l.launchId)?.stuckSince !== undefined, 10_000);
    expect(h.store.getLaunch(l.launchId)?.notices).toMatchObject([{ kind: 'stuck' }]);
    expect(h.store.listEvents({ kind: 'launch.stuck', taskId: 'T1' })).toHaveLength(1);
    expect(h.orch.status().stuck).toEqual(['T1']);
    expect(h.orch.status().liveLaunches[0]).toMatchObject({ taskId: 'T1', stuck: true, lastSignal: 'spawned' });

    await h.waitFor(() => h!.orch.entry('T1').status.kind === 'blocked', 15_000);
    expect(h.store.getLaunch(l.launchId)).toMatchObject({ status: 'ended', endReason: 'stuck' });
    expect(h.orch.entry('T1').status).toMatchObject({ kind: 'blocked', reason: { message: expect.stringContaining('stuck') } });
    for (let i = 0; i < 40 && pidAlive(l.pid!); i++) await pause(50);
    expect(pidAlive(l.pid!)).toBe(false);
  }, 40_000);

  it('heartbeats keep a slow agent unflagged, and a publish reaches the running sibling as a baseMoved notice with the real verifier', async () => {
    h = await makeSlice({ graph: `nodes:\n  - { id: A, deps: [], behavior: commitAndSubmit }\n  - { id: B, deps: [], behavior: "heartbeatThenSubmit:3000" }`, realVerifier: true, config: { tickIntervalMs: 100, health: health({ stuckAfterMs: 1000, stuckFailAfterMs: 5000 }), budgets } });
    await h.waitFor(() => h!.orch.entry('A').status.kind === 'done', 20_000);
    const lb = h.launchOf('B');
    const head = gitIn(h.repo, 'rev-parse', 'main');
    await h.waitFor(() => (h!.store.getLaunch(lb.launchId)?.notices ?? []).length > 0, 5_000);
    expect(h.store.getLaunch(lb.launchId)?.notices).toEqual([{ kind: 'baseMoved', head, files: ['A.txt'], task: 'A' }]);
    expect(h.store.getLaunch(lb.launchId)?.lastSignal).toMatch(/heartbeat/);
    await h.waitFor(() => h!.orch.entry('B').status.kind === 'done', 20_000);
    expect(h.store.listEvents({ kind: 'launch.stuck' })).toEqual([]);
    expect(h.orch.entry('B').attempts).toBe(0);
  }, 60_000);

  it('a restart after an outage longer than the lease adopts the agent and keeps its health facts', async () => {
    h = await makeSlice({ graph: single('hang'), config: { leaseTtlMs: 500, tickIntervalMs: 100, health: health(), budgets } });
    await h.orch.tick();
    const l = h.launchOf('T1');
    await h.orch.tick();
    const facts = h.store.getLaunch(l.launchId)!;
    expect(facts.progressAt).toBe(facts.spawnedAt);
    expect(facts.fingerprint).toMatch(/^[0-9a-f]{40}:/);
    await h.orch.stop();
    await pause(1200);
    await h.restart();
    expect(h.orch.entry('T1').lease!.expiresAt).toBeGreaterThan(Date.now());
    await h.orch.tick();
    expect(h.orch.entry('T1')).toMatchObject({ status: { kind: 'running' }, attempts: 0, launches: 1 });
    expect(h.store.getLaunch(l.launchId)).toMatchObject({ status: 'live', progressAt: facts.progressAt, fingerprint: facts.fingerprint });
    expect(pidAlive(l.pid!)).toBe(true);
  }, 30_000);
});
