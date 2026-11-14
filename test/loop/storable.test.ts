import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { JournaledStore, type JournalSink } from '../../src/state/journal.js';
import { PgSink } from '../../src/state/pg/index.js';
import { SqliteStore } from '../../src/state/sqlite.js';
import type { Store } from '../../src/state/store.js';
import { dropRun, freshRunId, pgAvailable, stopTestPostgres, testDatabase } from '../state/pg-db.js';
import { makeHarness, type Harness } from './harness.js';

/**
 * Storable values at the agent API (ORC-88): strings Postgres cannot hold are stored with U+FFFD in
 * their place, and integer fields that are not safe integers answer 400 before anything is written.
 * See specs/state-backend "Storable values" and specs/agent-protocol "Integer fields".
 */
const open: Harness[] = [];
const sinks: PgSink[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) h.cleanup();
  for (const s of sinks.splice(0)) {
    await s.close();
    await dropRun(s.runId);
  }
});
afterAll(async () => {
  await stopTestPostgres();
});

interface Backend {
  name: string;
  available: boolean;
  store(): Promise<{ store: Store; sink?: PgSink }>;
}

const backends: Backend[] = [
  { name: 'SqliteStore', available: true, store: async () => ({ store: new SqliteStore(':memory:') }) },
  {
    name: 'JournaledStore over PgSink',
    available: pgAvailable,
    store: async () => {
      const sink = await PgSink.open({ connection: await testDatabase(), runId: freshRunId('storable') });
      sinks.push(sink);
      const fatal: unknown[] = [];
      const store = new JournaledStore(new SqliteStore(':memory:'), sink as JournalSink, { flushDeadlineMs: 600_000, onFatal: (f) => fatal.push(f) });
      return { store, sink };
    },
  },
];

async function live(store: Store): Promise<{ h: Harness; launchId: string; token: string }> {
  const h = makeHarness({ store });
  open.push(h);
  await h.orch.tick();
  const l = h.launchOf('T1');
  return { h, launchId: l.launchId, token: l.token };
}

for (const b of backends) {
  describe.skipIf(!b.available)(`agent log values on ${b.name}`, () => {
    it('a log text with NUL answers 200 and is stored with U+FFFD; Postgres accepts the batch and reloads the same rows', async () => {
      const { store, sink } = await b.store();
      const { h, launchId, token } = await live(store);
      const res = await h.orch.agentCall(launchId, token, 'log', { seq: 7, text: 'a\u0000b' });
      expect(res.status).toBe(200);
      if (sink) {
        // Postgres must take every batch: before the fix the batch holding the event is refused and retried until the deadline.
        const j = store as JournaledStore;
        const deadline = Date.now() + 5_000;
        while (j.durability().pendingBatches > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
        expect(j.durability().pendingBatches).toBe(0);
        expect(j.fatalReason()).toBeUndefined();
      }
      const ev = store.listEvents({ kind: 'agent.log', launchId }).at(-1)!;
      expect(ev.payload).toEqual({ text: 'a�b' });
      if (sink) {
        const reloaded = await sink.loadImage();
        expect(reloaded.listEvents({ kind: 'agent.log', launchId }).at(-1)!.payload).toEqual({ text: 'a�b' });
        reloaded.close();
      }
    });

    for (const seq of [1.5, 1e30]) {
      it(`a log seq of ${seq} answers 400 naming seq and writes nothing`, async () => {
        const { store } = await b.store();
        const { h, launchId, token } = await live(store);
        const before = { seq: store.latestEventSeq(), launch: JSON.stringify(store.getLaunch(launchId)), pending: store.durability().pendingBatches };
        const res = await h.orch.agentCall(launchId, token, 'log', { seq, text: 'x' });
        expect(res.status).toBe(400);
        expect(res.body['field']).toBe('seq');
        expect(String(res.body['error'])).toMatch(/seq/);
        expect(store.latestEventSeq()).toBe(before.seq);
        expect(JSON.stringify(store.getLaunch(launchId))).toBe(before.launch);
        expect(store.durability().pendingBatches).toBe(before.pending);
        expect(store.getDedup(launchId, seq)).toBeUndefined();
      });
    }
  });
}

describe('agent integer fields', () => {
  it('heartbeat, report and block refuse a seq that is not a safe non-negative integer with a 400 naming seq', async () => {
    const { h, launchId, token } = await live(new SqliteStore(':memory:'));
    const before = h.store.latestEventSeq();
    for (const op of ['heartbeat', 'report', 'block'] as const) {
      for (const seq of [1.5, 1e30, -1]) {
        const res = await h.orch.agentCall(launchId, token, op, { seq, kind: 'submit', message: 'm' });
        expect(res.status, `${op} ${seq}`).toBe(400);
        expect(res.body['field']).toBe('seq');
      }
    }
    expect(h.store.latestEventSeq()).toBe(before);
  });

  it('worker usage refuses token counts that are not safe integers, naming the field', async () => {
    const h = makeHarness();
    open.push(h);
    const res = h.orch.recordWorkerUsage('L', { workerId: 'w', usage: { tokens: { input: 1e30, output: 1 } } });
    expect(res.status).toBe(400);
    expect(String(res.body['error'])).toMatch(/usage\.tokens\.input/);
  });
});
