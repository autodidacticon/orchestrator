import { afterEach, describe, expect, it } from 'vitest';
import type { Launch } from '../../src/state/store.js';
import { RUNNER_METHODS } from '../../src/state/gate.js';
import { makeHarness, type Harness } from './harness.js';

// See specs/operator-control "Shutdown: launches reaped together" and "Shutdown: reap before the verifier wait".
const open: Harness[] = [];
afterEach(() => {
  for (const h of open.splice(0)) h.cleanup();
});

function harness(): Harness {
  const h = makeHarness({
    graph: `nodes:
  - { id: T1 }
  - { id: T2 }
  - { id: T3 }
  - { id: T4 }`,
    config: { capacity: 4, health: { stuckAfterMs: 0, stuckFailAfterMs: 0, reportGraceMs: 0 }, budgets: { maxLaunchMs: 0, maxRunCostUsd: 0 } },
  });
  open.push(h);
  return h;
}

/** Replace the claude-code runner's reapAll with one that records its launches and waits for the test. */
function holdReapAll(h: Harness): { calls: Launch[][]; entered: Promise<void>; release: () => void } {
  const calls: Launch[][] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let entered!: () => void;
  const enteredP = new Promise<void>((r) => (entered = r));
  const orig = h.runners['claude-code'].reapAll.bind(h.runners['claude-code']);
  h.runners['claude-code'].reapAll = async (launches) => {
    calls.push([...launches]);
    entered();
    await gate;
    await orig(launches);
  };
  return { calls, entered: enteredP, release };
}

const KINDS = ['launch.usage', 'transition', 'launch.ended'];
const eventsOf = (h: Harness, launches: Launch[]) => {
  const ids = new Set(launches.map((l) => l.launchId));
  const tasks = new Set(launches.map((l) => l.taskId));
  return h.store.listEvents({ kinds: KINDS }).filter((e) => (e.launchId !== undefined ? ids.has(e.launchId) : e.taskId !== undefined && tasks.has(e.taskId)));
};

describe('reaping shutdown', () => {
  it('reaps the live launches in one runner call, then records usage, fails the task and ends each launch in that order', async () => {
    const h = harness();
    await h.orch.tick();
    const live = ['T1', 'T2', 'T3', 'T4'].map((t) => h.launchOf(t));
    // T4 leaves first so three launches remain.
    await h.submit('T4');
    await h.orch.settle();
    expect(h.store.listLaunches({ status: 'live' }).map((l) => l.taskId).sort()).toEqual(['T1', 'T2', 'T3']);
    const three = live.slice(0, 3);
    const before = eventsOf(h, three).length;

    const held = holdReapAll(h);
    const stopped = h.orch.stop({ reap: true });
    await held.entered;
    expect(held.calls).toHaveLength(1);
    expect(held.calls[0]!.map((l) => l.taskId).sort()).toEqual(['T1', 'T2', 'T3']);
    // While the call is held, nothing of the three is written; the usage the runner reports is set now.
    await new Promise((r) => setTimeout(r, 20));
    expect(eventsOf(h, three).length).toBe(before);
    three.forEach((l, i) => h.runner.usageScript.set(l.launchId, { costUsd: i + 1, source: 'scripted' }));
    held.release();
    await stopped;

    expect(held.calls).toHaveLength(1);
    const all = h.store.listEvents({ kinds: KINDS });
    three.forEach((l, i) => {
      const row = h.store.getLaunch(l.launchId)!;
      expect(row).toMatchObject({ status: 'ended', endReason: 'reaped', costUsd: i + 1 });
      const usage = all.findIndex((e) => e.kind === 'launch.usage' && e.launchId === l.launchId);
      const failed = all.findIndex((e) => e.kind === 'transition' && e.taskId === l.taskId && (e.payload as { to?: string }).to === 'failed');
      const ended = all.findIndex((e) => e.kind === 'launch.ended' && e.launchId === l.launchId);
      expect(usage).toBeGreaterThanOrEqual(0);
      expect(failed).toBeGreaterThan(usage);
      expect(ended).toBeGreaterThan(failed);
      expect(h.orch.entry(l.taskId).carry?.priorFailure?.kind).toBe('reaped');
    });
  });

  it('reaps and ends the launches while a verifier job is still in flight, and returns after it', async () => {
    const h = harness();
    let releaseJob!: () => void;
    const jobGate = new Promise<void>((r) => (releaseJob = r));
    let jobEntered!: () => void;
    const jobStarted = new Promise<void>((r) => (jobEntered = r));
    const run = h.verifier.run.bind(h.verifier);
    h.verifier.run = async (job, ctx) => {
      jobEntered();
      await jobGate;
      return run(job, ctx);
    };
    await h.orch.tick();
    await h.submit('T4');
    void h.orch.tick();
    await jobStarted;
    expect(h.statusOf('T4')).toBe('submitted');
    expect(h.store.listLaunches({ status: 'live' }).map((l) => l.taskId).sort()).toEqual(['T1', 'T2', 'T3']);
    const three = ['T1', 'T2', 'T3'].map((t) => h.launchOf(t));
    // The tick in flight is awaited first; let it end.
    await new Promise((r) => setTimeout(r, 20));

    let reapCalls = 0;
    const orig = h.runners['claude-code'].reapAll.bind(h.runners['claude-code']);
    h.runners['claude-code'].reapAll = async (launches) => {
      reapCalls += 1;
      await orig(launches);
    };
    let stopped = false;
    const stopping = h.orch.stop({ reap: true }).then(() => (stopped = true));
    for (let i = 0; i < 50 && three.some((l) => h.store.getLaunch(l.launchId)!.status !== 'ended'); i++) await new Promise((r) => setTimeout(r, 10));
    expect(reapCalls).toBe(1);
    for (const l of three) expect(h.store.getLaunch(l.launchId)).toMatchObject({ status: 'ended', endReason: 'reaped' });
    await new Promise((r) => setTimeout(r, 50));
    expect(stopped).toBe(false);
    releaseJob();
    await stopping;
    expect(stopped).toBe(true);
  });

  it('gates reapAll on durability like every other runner method', () => {
    expect(RUNNER_METHODS).toContain('reapAll');
  });
});
