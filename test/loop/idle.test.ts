import { afterEach, describe, expect, it } from 'vitest';
import type { Config } from '../../src/config.js';
import { makeHarness, type Harness } from './harness.js';

const open: Harness[] = [];
afterEach(() => {
  for (const h of open.splice(0)) h.cleanup();
});

/** Nothing ever launches: the only task waits on an open external node. */
const QUIET = `nodes:
  - { id: X, kind: external, done: false }
  - { id: T1, deps: [X] }`;

function harness(config: Partial<Config> = {}, graph?: string): Harness {
  const h = makeHarness({ graph, config: { health: { stuckAfterMs: 0, stuckFailAfterMs: 0, baseMovedNotice: true }, ...config } });
  open.push(h);
  return h;
}

describe('idle exit: quiescence', () => {
  it('is false with a live launch and with a verifier job, true once everything is applied', async () => {
    const h = harness();
    await h.orch.tick();
    expect(h.orch.quiescent()).toBe(false);
    expect(h.orch.status().idle).toMatchObject({ quiescent: false, idleMs: 0, exitAfterMs: 600_000 });
    await h.submit('T1');
    expect(h.orch.quiescent()).toBe(false); // a queued job
    await h.orch.settle();
    await h.submit('T5');
    await h.orch.settle();
    for (const id of ['T2', 'T3']) await h.submit(id);
    await h.orch.settle();
    await h.submit('T4');
    await h.orch.settle();
    expect(h.orch.status().awaitingReview).toEqual(['MVP']);
    expect(h.orch.quiescent()).toBe(true); // a milestone under review is durable
  });

  it('is false with an unapplied terminal job and with a pending cascade', () => {
    const h = harness({}, QUIET);
    h.store.createJob({ jobId: 'J', taskId: 'T1', launchId: 'L', sealedSha: 'x', baseSha: 'b', status: 'published', applied: false, createdAt: 1, updatedAt: 1 });
    expect(h.orch.quiescent()).toBe(false);
    h.store.updateJob('J', { applied: true });
    expect(h.orch.quiescent()).toBe(true);
    h.store.setKv('cascade.pending', JSON.stringify({ target: 'T1', plan: [], recordedAt: 0 }));
    expect(h.orch.quiescent()).toBe(false);
  });

  it('counts a parked launch in mixed mode inside its window, not in pull mode', async () => {
    const mixed = harness({ runner: { mode: 'mixed', claimWindowMs: 60_000 } });
    await mixed.orch.tick();
    expect(mixed.store.listLaunches({ status: 'claimable' }).length).toBeGreaterThan(0);
    expect(mixed.orch.quiescent()).toBe(false);
    const pull = harness({ runner: { mode: 'pull', claimWindowMs: 60_000 } });
    await pull.orch.tick();
    expect(pull.store.listLaunches({ status: 'claimable' }).length).toBeGreaterThan(0);
    expect(pull.orch.quiescent()).toBe(true);
    expect(pull.orch.status().idle.quiescent).toBe(true);
  });
});

describe('idle exit: the clock', () => {
  it('resets on a request that is not a probe, holds at zero while a request is in flight', async () => {
    const h = harness({ daemon: { idleExitMs: 1000, exitWhileAttached: false, maxKeptReleases: 3 } }, QUIET);
    await h.orch.tick();
    expect(h.orch.quiescent()).toBe(true);
    h.advance(500);
    expect(h.orch.idleMs()).toBe(500);
    h.orch.requestBegan();
    expect(h.orch.idleMs()).toBe(0);
    h.orch.requestEnded(false);
    expect(h.orch.idleMs()).toBe(0);
    h.advance(300);
    expect(h.orch.idleMs()).toBe(300);
    h.orch.requestBegan();
    h.orch.requestEnded(true); // a probe
    expect(h.orch.idleMs()).toBe(300);
    expect(h.orch.idleExitDue()).toBe(false);
    h.advance(700);
    expect(h.orch.idleExitDue()).toBe(true);
    expect(h.orch.status().idle).toMatchObject({ quiescent: true, idleMs: 1000, exitAfterMs: 1000 });
  });

  it('never fires when disabled, and a non-quiescent tick is activity', async () => {
    const h = harness({ daemon: { idleExitMs: 0, exitWhileAttached: false, maxKeptReleases: 3 } }, QUIET);
    await h.orch.tick();
    h.advance(10 * 60_000);
    expect(h.orch.idleMs()).toBe(10 * 60_000);
    expect(h.orch.idleExitDue()).toBe(false);
    expect(h.orch.status().idle.exitAfterMs).toBe(0);
    const busy = harness({ daemon: { idleExitMs: 1000, exitWhileAttached: false, maxKeptReleases: 3 } });
    await busy.orch.tick(); // launches T1 and T5
    busy.advance(5000);
    expect(busy.orch.idleMs()).toBe(0);
    await busy.orch.tick();
    expect(busy.orch.idleExitDue()).toBe(false);
  });

  it('holds at zero while a live attachment is attached, unless exitWhileAttached', async () => {
    const h = harness({ daemon: { idleExitMs: 1000, exitWhileAttached: false, maxKeptReleases: 3 } }, QUIET);
    await h.orch.tick();
    h.orch.attach({ id: 'a1', pids: [process.pid, process.ppid] });
    expect(h.orch.attached()).toBe(true);
    h.advance(5000);
    expect(h.orch.idleMs()).toBe(0);
    expect(h.orch.status().attachments).toMatchObject([{ id: 'a1', pids: [process.pid, process.ppid], launches: [] }]);
    h.orch.endAttachment('a1', 'sessionEnded');
    expect(h.orch.attached()).toBe(false);
    await h.orch.tick(); // the sweep forgets it
    expect(h.orch.status().attachments).toEqual([]);
    expect(h.store.listEvents({ kind: 'attachment.ended' })).toHaveLength(1);
    const dead = harness({ daemon: { idleExitMs: 1000, exitWhileAttached: false, maxKeptReleases: 3 } }, QUIET);
    await dead.orch.tick();
    dead.orch.attach({ id: 'gone', pids: [999_999, 999_998] });
    expect(dead.orch.attached()).toBe(false); // its process is not alive
    dead.advance(2000);
    expect(dead.orch.idleExitDue()).toBe(true);
    const lenient = harness({ daemon: { idleExitMs: 1000, exitWhileAttached: true, maxKeptReleases: 3 } }, QUIET);
    await lenient.orch.tick();
    lenient.orch.attach({ id: 'a2', pids: [process.pid] });
    lenient.advance(2000);
    expect(lenient.orch.idleMs()).toBe(2000);
    expect(lenient.orch.idleExitDue()).toBe(true);
  });
});
