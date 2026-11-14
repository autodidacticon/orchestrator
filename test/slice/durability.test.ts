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
    // latestSeq is the durable sequence number, the cursor clients pass to /v1/events.
    expect(status.body['latestSeq']).toBe(durableSeq);
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
    expect((await http('GET', '/v1/status')).body).toMatchObject({ storeLagMs: 0, storePendingBatches: 0, latestSeq: h.store.latestEventSeq() });
  }, 30_000);
});

describe('reads that write, and the event cursor, under a stalled sink', () => {
  async function liveLaunch() {
    const dir = mkdtempSync(path.join(tmpdir(), 'orch-durable-'));
    sink = new StallSink(new SqliteSink(path.join(dir, 'sink.sqlite')));
    h = await makeSlice({ graph: G, dir, config: { tracker, leaseTtlMs: 60_000 }, fileGraph: true, journal: { sink } });
    await h.orch.tick();
    await h.waitFor(() => h!.store.listLaunches({ taskId: 'T1', status: 'live' }).length === 1);
    await h.store.durable();
    return h.store.listLaunches({ taskId: 'T1', status: 'live' })[0]!;
  }
  /** GET the inbox; `answered` turns true when the response arrives. */
  function inbox(launch: { launchId: string; token: string }) {
    const state = { answered: false };
    const res = fetch(`${h!.orch.apiBaseUrl}/v1/launches/${launch.launchId}/inbox`, { headers: { authorization: `Bearer ${launch.token}` } })
      .then(async (r) => ({ status: r.status, body: (await r.json()) as { notices: Array<{ kind: string; message?: string }> } }))
      .finally(() => (state.answered = true));
    return { state, res };
  }

  it('the inbox hands out no notice whose record is not durable, and answers only once its own writes are durable', async () => {
    const launch = await liveLaunch();

    // A notice queued while the sink stalls is not handed out before its record is durable.
    sink!.stall();
    h!.orch.queueNotice(launch.launchId, { kind: 'nudge', message: 'm1' });
    const first = inbox(launch);
    await sleep(300);
    expect(first.state.answered).toBe(false);
    expect(h!.store.durability().pendingBatches).toBeGreaterThan(0);
    sink!.release();
    expect((await first.res).body.notices.map((n) => n.message)).toEqual(['m1']);
    await h!.store.durable();

    // A durable notice, then a stall: the inbox's own writes (lease renewal, progress, the cleared notice) hold the answer.
    h!.orch.queueNotice(launch.launchId, { kind: 'nudge', message: 'm2' });
    await h!.store.durable();
    sink!.stall();
    const second = inbox(launch);
    await sleep(300);
    expect(second.state.answered).toBe(false);
    // A notice queued during the wait is not handed out by this read, nor lost: the next read gets it.
    h!.orch.queueNotice(launch.launchId, { kind: 'nudge', message: 'm3' });
    sink!.release();
    expect((await second.res).body.notices.map((n) => n.message)).toEqual(['m2']);
    expect(h!.store.durability().pendingBatches).toBe(0);
    const third = inbox(launch);
    expect((await third.res).body.notices.map((n) => n.message)).toEqual(['m3']);
    expect((await inbox(launch).res).body.notices).toEqual([]);
  }, 30_000);

  it('two inbox reads at once never hand out the same notice', async () => {
    const launch = await liveLaunch();
    sink!.stall();
    h!.orch.queueNotice(launch.launchId, { kind: 'nudge', message: 'once' });
    const a = inbox(launch);
    const b = inbox(launch);
    await sleep(200);
    sink!.release();
    const got = [...(await a.res).body.notices, ...(await b.res).body.notices].map((n) => n.message);
    expect(got).toEqual(['once']);
  }, 30_000);

  it('the status cursor is durable, and /v1/events never answers a seq below the after it was given', async () => {
    await liveLaunch();
    sink!.stall();
    // A batch already in flight when the stall began may still land; read the durable seq once it has.
    await sleep(100);
    const durableSeq = h!.store.durability().eventSeq;
    // Writes whose responses wait for durability; not awaited.
    const posts = [http('POST', '/v1/tasks/T1/nudge', { message: 'n' }), http('POST', '/v1/pause')];
    // Polled without a tick: a tick waits for durability.
    for (let i = 0; i < 200 && h!.store.latestEventSeq() <= durableSeq; i++) await sleep(10);
    expect(h!.store.latestEventSeq()).toBeGreaterThan(durableSeq);
    const status = await http('GET', '/v1/status');
    expect(h!.store.durability().eventSeq).toBe(durableSeq);
    expect(status.body['latestSeq']).toBe(durableSeq);
    const above = h!.store.latestEventSeq();
    const ev = await http('GET', `/v1/events?after=${above}&limit=500`);
    expect(ev.body['events']).toEqual([]);
    expect(ev.body['seq']).toBe(above);
    const atCursor = await http('GET', `/v1/events?after=${status.body['latestSeq']}&limit=500`);
    expect(atCursor.body['seq']).toBe(durableSeq);
    sink!.release();
    await Promise.all(posts);
    await h!.store.durable();
    // A page cut by the limit ends at its last event, so the next read starts there.
    const page = await http('GET', '/v1/events?after=0&limit=2');
    const events = page.body['events'] as StoredEvent[];
    expect(events).toHaveLength(2);
    expect(page.body['seq']).toBe(events[1]!.seq);
  }, 30_000);
});
