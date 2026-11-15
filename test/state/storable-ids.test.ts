import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GraphValidationError, parseGraph } from '../../src/graph/load.js';
import { dumpTables, type JournalSink, JournaledStore, SqliteSink } from '../../src/state/journal.js';
import { PgSink } from '../../src/state/pg/index.js';
import { assertStorableId, hasUnstorable, isUnstorable, unstorableIdMessage } from '../../src/state/storable.js';
import { defaultEntry } from '../../src/state/status.js';
import type { Launch, Store } from '../../src/state/store.js';
import { makeSlice, type SliceHarness } from '../slice/harness.js';
import { backends } from './backends.js';
import { dropRun, freshRunId, pgAvailable, stopTestPostgres, testDatabase } from './pg-db.js';

/**
 * Storable ids (ORC-98). The store rewrites a NUL or a lone surrogate in every string it writes, key columns included, so an
 * id holding one would be stored under another id and never found by its own. Such an id is refused where it enters: graph
 * load (node ids and deps), the claim route (workerId, taskId, attachment) and the attachment route (id). Every id that
 * passes is stored unchanged and found again on every backend. See specs/state-backend "Storable ids".
 */

const NUL = 'T\u0000x';
const HIGH = 'T\uD83D'; // a lone high surrogate
const LOW = '\uDE00T'; // a lone low surrogate
const BAD = [NUL, HIGH, LOW];
// Ids that pass: non-ASCII, a surrogate pair, and U+FFFD itself (what the store would have written for a NUL).
const GOOD = ['T-é', 'T😀', 'T�x'];

describe('the id check', () => {
  it('flags NUL and lone surrogates of either half, and passes pairs and other text', () => {
    for (const id of BAD) expect(hasUnstorable(id), JSON.stringify(id)).toBe(true);
    for (const id of [...GOOD, 'plain', '']) expect(hasUnstorable(id), JSON.stringify(id)).toBe(false);
    // The global regex keeps no state between calls.
    for (let i = 0; i < 3; i++) expect(hasUnstorable(NUL)).toBe(true);
  });

  it('names the field and the id, escaped, in a typed error', () => {
    expect(unstorableIdMessage('workerId', 'w1')).toBeUndefined();
    let err: unknown;
    try {
      assertStorableId('workerId', 'w\u0000');
    } catch (e) {
      err = e;
    }
    expect(isUnstorable(err)).toBe(true);
    expect((err as { field: string }).field).toBe('workerId');
    expect((err as Error).message).toContain('workerId "w\\u0000"');
    expect((err as Error).message).not.toContain('\u0000');
  });
});

describe('graph load refuses an id the store would rewrite', () => {
  const graph = (id: string, dep?: string) =>
    JSON.stringify({ nodes: [{ id: 'A' }, { id, deps: dep === undefined ? [] : [dep] }] });

  it.each(BAD.map((id) => [JSON.stringify(id), id]))('node id %s', (_name, id) => {
    let err: unknown;
    try {
      parseGraph(graph(id));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(GraphValidationError);
    expect((err as GraphValidationError).code).toBe('unstorableId');
    expect((err as GraphValidationError).details).toEqual({ field: 'nodes.1.id', id });
    expect((err as Error).message).toContain(`nodes.1.id: node id ${JSON.stringify(id)}`);
  });

  it.each(BAD.map((id) => [JSON.stringify(id), id]))('dependency %s', (_name, id) => {
    expect(() => parseGraph(graph('B', id))).toThrow(expect.objectContaining({ code: 'unstorableId', details: { field: 'nodes.1.deps.0', id } }));
  });

  it('reads the YAML escapes as the characters it refuses', () => {
    for (const [text, id] of [['"T\\0x"', NUL], ['"T\\ud83d"', HIGH], ['"\\ude00T"', LOW]] as const) {
      const parsed = (parseYamlNodes(`nodes:\n  - id: ${text}\n`)[0] as { id: string }).id;
      expect(parsed).toBe(id);
      expect(() => parseGraph(`nodes:\n  - id: ${text}\n`)).toThrow(/holds a NUL character or a lone surrogate/);
    }
  });

  it('loads ids that hold other text unchanged', () => {
    const g = parseGraph(JSON.stringify({ nodes: GOOD.map((id, i) => ({ id, deps: i ? [GOOD[i - 1]] : [] })) }));
    expect([...g.nodes.keys()]).toEqual(GOOD);
  });
});

function parseYamlNodes(text: string): unknown[] {
  return (parseYaml(text) as { nodes: unknown[] }).nodes;
}

const launch = (launchId: string, taskId: string, worker: string): Launch =>
  ({ launchId, taskId, launchNo: 1, status: 'live', token: `tok-${launchId}`, worktree: '/w', branch: 'b', baseSha: 's', createdAt: 1, worker: { id: worker, claimedAt: 1 } }) as unknown as Launch;

for (const backend of backends) {
  (backend.available ? describe : describe.skip)(`ids that pass the entry check are stored unchanged and found again (${backend.name})`, () => {
    let dir: string;
    let store: Store;
    beforeEach(async () => {
      dir = mkdtempSync(path.join(tmpdir(), 'orch-ids-'));
      store = await backend.open(dir);
    });
    afterEach(async () => {
      store.close();
      await backend.release();
      rmSync(dir, { recursive: true, force: true });
    });
    afterAll(() => backend.shutdown());

    it('every key column round-trips by the same id, across a reopen', async () => {
      const write = (s: Store) =>
        s.transaction(() => {
          GOOD.forEach((id, i) => {
            const lid = `L-${id}`;
            s.setEntry(id, { ...defaultEntry(), attempts: i + 1 });
            s.appendEvent({ kind: 'k', taskId: id, launchId: lid }, 1);
            s.putDedup(lid, 1, { ok: id });
            s.createLaunch(launch(lid, id, `w-${id}`));
            s.createJob({ jobId: `J-${id}`, taskId: id, launchId: lid, sealedSha: 's', baseSha: 'b', status: 'queued', applied: false, createdAt: 1, updatedAt: 1 } as never);
            s.createProposal({ id: `P-${id}`, taskId: id, launchId: lid, status: 'pending', createdAt: 1 } as never);
            s.putReport({ launchId: lid, taskId: id, kind: 'submit', createdAt: 1 } as never);
            s.setPayloadOverlay(id, `rev-${id}`, { note: id });
            s.setKv(`key-${id}`, id);
            s.putAttachment({ id: `A-${id}`, pids: [1], since: 1 });
            s.insertOutbox({ sourceSeq: i + 1, taskId: id, kind: 'comment', payload: { body: id }, createdAt: 1 });
          });
        });
      const read = (s: Store) => {
        GOOD.forEach((id, i) => {
          const lid = `L-${id}`;
          expect(s.getEntry(id)?.attempts, id).toBe(i + 1);
          expect(s.listEvents({ taskId: id }).map((e) => e.launchId)).toEqual([lid]);
          expect(s.listEvents({ launchId: lid }).map((e) => e.taskId)).toEqual([id]);
          expect(s.getDedup(lid, 1)).toEqual({ ok: id });
          expect(s.getLaunch(lid)?.taskId).toBe(id);
          expect(s.listLaunches({ taskId: id }).map((l) => l.launchId)).toEqual([lid]);
          expect(s.listLaunches({ status: 'live' }).find((l) => l.worker?.id === `w-${id}`)?.launchId).toBe(lid);
          expect(s.getJob(`J-${id}`)?.taskId).toBe(id);
          expect(s.listJobs({ taskId: id }).map((j) => j.jobId)).toEqual([`J-${id}`]);
          expect(s.getProposal(`P-${id}`)?.taskId).toBe(id);
          expect(s.listProposals({ taskId: id }).map((p) => p.id)).toEqual([`P-${id}`]);
          expect(s.getReport(lid)?.taskId).toBe(id);
          expect(s.getCompletionReport(id)?.launchId).toBe(lid);
          expect(s.getPayloadOverlay(id, `rev-${id}`)).toEqual({ note: id });
          expect(s.getKv(`key-${id}`)).toBe(id);
          expect(s.listAttachments().map((a) => a.id)).toContain(`A-${id}`);
          expect(s.listOutbox().find((e) => e.taskId === id)?.payload).toEqual({ body: id });
        });
      };
      write(store);
      read(store);
      await backend.check(store);
      store = await backend.reopen(store, dir);
      read(store);
      await backend.check(store);
    });

    it('would store an unstorable id under another id, which is why entry refuses it', async () => {
      store.setEntry(NUL, defaultEntry());
      expect(store.getEntry(NUL)).toBeUndefined();
      expect(store.getEntry('T�x')).toBeDefined();
      await backend.check(store);
    });
  });
}

/** The daemon on each backend: a plain SqliteStore, a journal over a SQLite sink, a journal over Postgres. */
const daemons: Array<{ name: string; available: boolean; sink: () => Promise<JournalSink | undefined> }> = [
  { name: 'SqliteStore', available: true, sink: async () => undefined },
  { name: 'JournaledStore', available: true, sink: async () => new SqliteSink(path.join(mkdtempSync(path.join(tmpdir(), 'orch-ids-sink-')), 'sink.sqlite')) },
  { name: 'JournaledStore over PgSink', available: pgAvailable, sink: async () => PgSink.open({ connection: await testDatabase(), runId: freshRunId('ids') }) },
];

const G = `nodes:
  - { id: T1, deps: [], behavior: hang, description: d, acceptanceCriteria: [a] }
`;

async function http(h: SliceHarness, method: 'POST' | 'PUT', route: string, body: Record<string, unknown>) {
  const res = await fetch(`${h.orch.apiBaseUrl}${route}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

for (const d of daemons) {
  (d.available ? describe : describe.skip)(`the API refuses an id the store would rewrite (${d.name})`, () => {
    let h: SliceHarness | undefined;
    let sink: JournalSink | undefined;
    afterEach(async () => {
      await h?.cleanup();
      h = undefined;
      if (sink instanceof PgSink) {
        await sink.close();
        await dropRun(sink.runId);
      } else (sink as SqliteSink | undefined)?.close();
      sink = undefined;
    });
    afterAll(async () => {
      if (d.available && d.name.includes('Pg')) await stopTestPostgres();
    });

    it('claims, attachments and graphs with such an id answer 400 naming it and write nothing; a good worker id finds its launch again', async () => {
      sink = await d.sink();
      h = await makeSlice({ graph: G, config: { leaseTtlMs: 60_000, runner: { mode: 'pull', claimWindowMs: 60_000 } }, ...(sink ? { journal: { sink } } : {}) });
      await h.orch.tick();
      const before = h.store.latestEventSeq();
      for (const id of BAD) {
        for (const [field, body] of [
          ['workerId', { workerId: id }],
          ['taskId', { workerId: 'w1', taskId: id }],
          ['attachment', { workerId: 'w1', attachment: id }],
        ] as const) {
          const r = await http(h, 'POST', '/v1/claims', body);
          expect(r.status, `${field} ${JSON.stringify(id)}`).toBe(400);
          expect(r.body).toMatchObject({ field });
          expect(String(r.body['error'])).toContain(`${field} ${JSON.stringify(id)}`);
        }
        const a = await http(h, 'POST', '/v1/attachments', { id, pids: [process.pid] });
        expect(a.status).toBe(400);
        expect(a.body).toMatchObject({ field: 'id' });
        const g = await http(h, 'PUT', '/v1/graph', { nodes: [{ id, description: 'd', acceptanceCriteria: ['a'] }] });
        expect(g.status).toBe(400);
        expect(g.body).toMatchObject({ code: 'unstorableId', details: { field: 'nodes.0.id', id } });
      }
      // Nothing was written: no event, no claim, no attachment.
      expect(h.store.latestEventSeq()).toBe(before);
      expect(h.store.listLaunches({ status: 'live' })).toEqual([]);
      expect(h.store.listAttachments()).toEqual([]);

      // A worker id that passes is stored unchanged, so the worker's next claim finds the launch it holds.
      const worker = 'w😀-é-�';
      const c1 = await http(h, 'POST', '/v1/claims', { workerId: worker });
      expect(c1.status).toBe(200);
      await h.store.durable();
      const again = await http(h, 'POST', '/v1/claims', { workerId: worker });
      expect(again.body).toMatchObject({ launchId: c1.body['launchId'], repeated: true });
      expect(h.store.getLaunch(String(c1.body['launchId']))?.worker?.id).toBe(worker);
      if (h.store instanceof JournaledStore) {
        await h.store.durable();
        const j = h.store;
        if (j.sink instanceof SqliteSink) expect(j.sink.tables()).toEqual(dumpTables(j.image.database()));
      }
    });
  });
}
