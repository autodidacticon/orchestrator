/**
 * Durability before effects, end to end: with a sink that stalls, a task reaches the point of an
 * external effect and nothing outside happens until the sink accepts the batch. See specs/state-backend.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Config } from '../../src/config.js';
import { RUNNER_METHODS, VERIFIER_METHODS, WORKSPACE_METHODS } from '../../src/state/gate.js';
import { type JournalSink, type RowOp, SqliteSink } from '../../src/state/journal.js';
import type { StoredEvent } from '../../src/state/store.js';
import { makeSlice, type SliceHarness } from './harness.js';

let h: SliceHarness | undefined;
let sink: StallSink | undefined;
afterEach(async () => {
  sink?.release();
  await h?.cleanup();
  sink?.inner.close();
  h = undefined;
  sink = undefined;
});

class StallSink implements JournalSink {
  stalled = false;
  private readonly waiting: Array<() => void> = [];
  constructor(readonly inner: SqliteSink) {}
  async applyBatch(ops: readonly RowOp[]): Promise<void> {
    while (this.stalled) await new Promise<void>((r) => this.waiting.push(r));
    await this.inner.applyBatch(ops);
  }
  stall(): void {
    this.stalled = true;
  }
  release(): void {
    this.stalled = false;
    for (const w of this.waiting.splice(0)) w();
  }
  hasLaunch(launchId: string): boolean {
    return this.inner.db.prepare('SELECT 1 FROM launches WHERE launch_id = ?').get(launchId) !== undefined;
  }
}

const G = `nodes:
  - { id: T1, deps: [], behavior: hang, url: "https://tracker.example/T1", trackerState: open }
`;

const tracker: Config['tracker'] = { enabled: 'always', maxAttempts: 3, parentInProgress: true, commentOnDone: false, commentOnFail: false, doneAt: 'integration', answersFromComments: true };

async function http(method: 'GET' | 'POST', route: string, body?: Record<string, unknown>) {
  const res = await fetch(`${h!.orch.apiBaseUrl}${route}`, { method, headers: { 'content-type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Call {
  name: string;
  stalled: boolean;
  pending: number;
  launchDurable?: boolean;
}

/** Record every call that reaches the real Workspace, AgentRunner, and VerifierBackend (behind the orchestrator's gate). */
function record(target: object, names: readonly string[], calls: Call[]): void {
  const t = target as Record<string, unknown>;
  for (const name of names) {
    const fn = t[name];
    if (typeof fn !== 'function') continue;
    t[name] = (...args: unknown[]) => {
      const launch = args[0] as { launchId?: unknown } | undefined;
      const launchDurable = launch && typeof launch === 'object' && typeof launch.launchId === 'string' ? sink!.hasLaunch(launch.launchId) : undefined;
      calls.push({ name, stalled: sink!.stalled, pending: h!.store.durability().pendingBatches, launchDurable });
      return (fn as (...a: unknown[]) => unknown).apply(target, args);
    };
  }
}

describe('durability before effects', () => {
  it('with a stalled sink no effect runs and no POST answers until the batch is accepted; GETs answer from the image, outbox and events only durable rows', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'orch-durable-'));
    sink = new StallSink(new SqliteSink(path.join(dir, 'sink.sqlite')));
    h = await makeSlice({ graph: G, dir, config: { tracker, leaseTtlMs: 60_000 }, fileGraph: true, journal: { sink } });
    await h.store.durable();
    const calls: Call[] = [];
    record(h.workspace, WORKSPACE_METHODS, calls);
    record(h.runner, RUNNER_METHODS, calls);
    record(h.orch.verifier, VERIFIER_METHODS, calls);

    const durableSeq = h.store.durability().eventSeq;
    sink.stall();
    const tick = h.orch.tick();
    // The tick admits T1 (a committed batch with its launch, events and outbox row) and then needs the workspace.
    const deadline = Date.now() + 10_000;
    while (!h.store.listLaunches({ taskId: 'T1' }).length) {
      if (Date.now() > deadline) throw new Error('T1 never admitted');
      await sleep(10);
    }
    await sleep(300);
    const [launch] = h.store.listLaunches({ taskId: 'T1' });
    expect(sink.hasLaunch(launch!.launchId)).toBe(false);
    expect(calls.filter((c) => c.name === 'prepare' || c.name === 'spawn')).toEqual([]);
    // Anything that did run while stalled ran with nothing pending.
    expect(calls.filter((c) => c.stalled && c.pending > 0)).toEqual([]);

    // GET answers from the image, with the lag in the status report.
    const status = await http('GET', '/v1/status');
    expect(status.status).toBe(200);
    expect(status.body['storeLagMs'] as number).toBeGreaterThan(0);
    expect(status.body['storePendingBatches'] as number).toBeGreaterThan(0);
    expect(status.body['latestSeq'] as number).toBeGreaterThan(durableSeq);
    // The outbox and the event feed omit the unflushed rows.
    expect(h.store.listOutbox({ status: 'pending' }).map((e) => e.taskId)).toEqual(['T1']);
    expect((await http('GET', '/v1/outbox')).body['effects']).toEqual([]);
    const events = await http('GET', '/v1/events?after=0&limit=500');
    expect((events.body['events'] as StoredEvent[]).every((e) => e.seq <= durableSeq)).toBe(true);
    expect(events.body['seq']).toBe(durableSeq);
    expect(h.store.latestEventSeq()).toBeGreaterThan(durableSeq);

    // A POST's response waits for its record.
    let answered = false;
    const post = http('POST', '/v1/attachments', { id: 'session-1', pids: [process.pid] }).then((r) => ((answered = true), r));
    await sleep(300);
    expect(answered).toBe(false);
    expect(calls.filter((c) => c.name === 'prepare' || c.name === 'spawn')).toEqual([]);

    sink.release();
    expect((await post).status).toBe(200);
    await tick;
    await h.waitFor(() => h!.store.listLaunches({ taskId: 'T1', status: 'live' }).length === 1);
    const prepare = calls.find((c) => c.name === 'prepare');
    expect(prepare).toMatchObject({ stalled: false, launchDurable: true });
    expect(calls.find((c) => c.name === 'spawn')).toMatchObject({ stalled: false, launchDurable: true });
    await h.store.durable();
    expect(h.store.durability()).toMatchObject({ lagMs: 0, pendingBatches: 0 });
    expect(((await http('GET', '/v1/outbox')).body['effects'] as Array<{ taskId: string }>).map((e) => e.taskId)).toEqual(['T1']);
    expect((await http('GET', '/v1/events?after=0&limit=500')).body['seq']).toBe(h.store.latestEventSeq());
    expect((await http('GET', '/v1/status')).body).toMatchObject({ storeLagMs: 0, storePendingBatches: 0 });
  }, 30_000);
});
