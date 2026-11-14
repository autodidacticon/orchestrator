/**
 * Postgres sink specifics (ORC-15): run isolation, the run lock and fencing, idempotent and atomic
 * batches, launch insertion order, and number types after a load. Skipped without Postgres (pg-db.ts).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type FatalInfo, FencedError, isFenced, isRejected, JournaledStore, type RejectedBatchError, type RowOp } from '../../src/state/journal.js';
import { MIGRATIONS, migrate, PgSink, RunLockedError } from '../../src/state/pg/index.js';
import { SqliteStore } from '../../src/state/sqlite.js';
import { defaultEntry } from '../../src/state/status.js';
import type { Launch } from '../../src/state/store.js';
import { expectReloadEquals } from './backends.js';
import { adminClient, dropRun, freshRunId, pgAvailable, stopTestPostgres, testDatabase } from './pg-db.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const launch = (id: string, createdAt: number, token = `tok-${id}`): Launch => ({
  launchId: id,
  taskId: 'T1',
  attempt: 1,
  launchNo: 1,
  status: 'preparing',
  token,
  branch: 'b',
  worktree: 'w',
  baseSha: 's',
  graphRev: 'r',
  createdAt,
});

async function until(pred: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await pred())) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe.skipIf(!pgAvailable)('PgSink', () => {
  let admin: pg.Client;
  const opened: PgSink[] = [];
  const runs: string[] = [];

  const open = async (runId: string): Promise<PgSink> => {
    const sink = await PgSink.open({ connection: await testDatabase(), runId });
    opened.push(sink);
    return sink;
  };
  const run = (label: string) => {
    const id = freshRunId(label);
    runs.push(id);
    return id;
  };
  const count = async (table: string, runId: string) => Number((await admin.query(`SELECT count(*)::int AS n FROM ${table} WHERE run_id = $1`, [runId])).rows[0].n);

  beforeAll(async () => {
    admin = await adminClient();
  }, 120_000);
  afterEach(async () => {
    for (const s of opened.splice(0)) await s.close();
    for (const r of runs.splice(0)) await dropRun(r);
  });
  afterAll(async () => {
    await admin?.end();
    await stopTestPostgres();
  });

  it('migrations apply once and a second open finds them applied', async () => {
    const r = run('mig');
    await open(r);
    expect(await migrate(admin)).toEqual([]);
    const versions = (await admin.query('SELECT version FROM orchestrator_migrations ORDER BY version')).rows.map((x: { version: number }) => x.version);
    expect(versions).toEqual(MIGRATIONS.map((m) => m.version));
  });

  it('two runs with different run ids in one database do not see each other\'s rows, and each loads only its own', async () => {
    const [ra, rb] = [run('iso-a'), run('iso-b')];
    const a = new JournaledStore(new SqliteStore(':memory:'), await open(ra));
    const b = new JournaledStore(new SqliteStore(':memory:'), await open(rb));
    // The same keys in both runs, with different contents: run_id leads every key and unique index.
    for (const [s, tag] of [
      [a, 'A'],
      [b, 'B'],
    ] as const) {
      s.transaction(() => {
        s.setEntry('T1', { ...defaultEntry(), launches: tag === 'A' ? 1 : 2 });
        s.appendEvent({ kind: `ev-${tag}`, taskId: 'T1' }, 1);
        s.createLaunch(launch('L1', 1, 'same-token'));
        s.insertOutbox({ sourceSeq: 1, taskId: 'T1', kind: 'setState', payload: { tag }, createdAt: 1 });
        s.setKv('k', tag);
        s.setSnapshot(`rev-${tag}`, 'nodes: []');
      });
    }
    b.setKv('only-b', '1');
    await a.durable();
    await b.durable();
    expect(await count('kv', ra)).toBe(1);
    expect(await count('kv', rb)).toBe(2);
    const imgA = await (a.sink as PgSink).loadImage();
    const imgB = await (b.sink as PgSink).loadImage();
    expect(imgA.getKv('k')).toBe('A');
    expect(imgA.getKv('only-b')).toBeUndefined();
    expect(imgA.listEvents().map((e) => e.kind)).toEqual(['ev-A']);
    expect(imgA.getEntry('T1')?.launches).toBe(1);
    expect(imgA.getSnapshot()?.rev).toBe('rev-A');
    expect(imgA.listOutbox().map((e) => e.payload)).toEqual([{ tag: 'A' }]);
    expect(imgB.getKv('k')).toBe('B');
    expect(imgB.getKv('only-b')).toBe('1');
    expect(imgB.listEvents().map((e) => e.kind)).toEqual(['ev-B']);
    expect(imgB.getLaunchByToken('same-token')?.launchId).toBe('L1');
    await expectReloadEquals(a.sink as PgSink, a.image);
    await expectReloadEquals(b.sink as PgSink, b.image);
    imgA.close();
    imgB.close();
    a.close();
    b.close();
  });

  it('a second session asking for a run\'s lock while the first holds it is refused; a terminated session fences its sink, which writes nothing afterwards', async () => {
    const r = run('lock');
    const first = await open(r);
    await expect(open(r)).rejects.toBeInstanceOf(RunLockedError);
    // Another run is not affected by this run's lock.
    await open(run('lock-other'));

    const fatal: FatalInfo[] = [];
    const store = new JournaledStore(new SqliteStore(':memory:'), first, { onFatal: (f) => fatal.push(f), retryBaseMs: 2, retryMaxMs: 5 });
    store.setKv('before', '1');
    await store.durable();
    expect(await count('kv', r)).toBe(1);

    // Terminate the lock holder from the server side.
    const killed = await admin.query('SELECT pg_terminate_backend($1) AS ok', [first.backendPid]);
    expect(killed.rows[0].ok).toBe(true);
    await until(async () => (await admin.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid = $1', [first.backendPid])).rows[0].n === 0);

    store.setKv('after', '1');
    await until(() => fatal.length > 0);
    expect(fatal).toEqual([expect.objectContaining({ reason: 'fenced', unflushedBatches: 1 })]);
    expect(first.fenced).toBe(true);
    // The sink never reconnects: later batches throw at once, and nothing reaches Postgres.
    const later: RowOp[] = [{ op: 'upsert', table: 'kv', row: { key: 'later', value: '1' } }];
    await expect(first.applyBatch(later)).rejects.toBeInstanceOf(FencedError);
    store.setKv('later-still', '1');
    await new Promise((res) => setTimeout(res, 50));
    expect(fatal).toHaveLength(1);
    expect((await admin.query('SELECT key FROM kv WHERE run_id = $1 ORDER BY key', [r])).rows.map((x: { key: string }) => x.key)).toEqual(['before']);
    const sessions = await admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1", [`orchestrator:${r}`]);
    expect(sessions.rows[0].n).toBe(0);
    store.close();

    // The lock went with the session: a new daemon can take the run.
    const next = await open(r);
    const image = await next.loadImage();
    expect(image.getKv('before')).toBe('1');
    expect(image.getKv('after')).toBeUndefined();
    image.close();
  });

  it('a batch applied twice leaves Postgres unchanged; a batch that fails part-way leaves none of its rows', async () => {
    const r = run('idem');
    const sink = await open(r);
    const recorded: RowOp[][] = [];
    const store = new JournaledStore(new SqliteStore(':memory:'), { applyBatch: async (ops) => (recorded.push([...ops]), sink.applyBatch(ops)) });
    store.transaction(() => {
      store.createLaunch(launch('L1', 1));
      store.createLaunch(launch('L0', 1));
      store.appendEvent({ kind: 'x', payload: { a: 1, nested: { b: [1, 2] } } }, 1);
      store.insertOutbox({ sourceSeq: 1, taskId: 'T1', kind: 'setState', payload: {}, createdAt: 1 });
      store.putAttachment({ id: 'a', pids: [1], since: 1 });
      store.putDedup('L1', 1, null);
    });
    store.transaction(() => {
      store.updateLaunch('L1', { status: 'live' });
      store.deleteAttachment('a');
      store.ackOutbox(1, null, 2);
    });
    await store.durable();
    const before = await sink.tables({ raw: true });
    for (const ops of recorded) await sink.applyBatch(ops);
    await sink.applyBatch(recorded[1]!);
    expect(await sink.tables({ raw: true })).toEqual(before);
    expect(before['launches']!.map((l) => [l['launch_id'], l['ord']])).toEqual([
      ['L1', 1],
      ['L0', 2],
    ]);
    expect(before['kv']).toEqual([]);
    // JSON null and SQL NULL stay apart.
    expect(before['dedup']![0]!['response']).toBe('null');
    expect(before['outbox']![0]!['result']).toBe('null');
    expect(before['outbox']![0]!['error']).toBeNull();

    // Part-way failure: the first rows are written inside the transaction, then a duplicate token fails it.
    const partial: RowOp[] = [
      { op: 'upsert', table: 'kv', row: { key: 'partial', value: '1' } },
      { op: 'upsert', table: 'events', row: { seq: 99, ts: 1, kind: 'p', task_id: null, launch_id: null, payload: null } },
      { op: 'delete', table: 'launches', key: { launch_id: 'L0' } },
      { op: 'upsert', table: 'launches', row: { launch_id: 'L2', task_id: 'T1', status: 'preparing', token: 'tok-L1', created_at: 1, doc: JSON.stringify(launch('L2', 1, 'tok-L1')) } },
    ];
    const err = await sink.applyBatch(partial).then(
      () => undefined,
      (e: unknown) => e,
    );
    // A constraint error refuses the batch for its content: not retryable, naming the row's table and key and the SQLSTATE (ORC-88).
    expect(isRejected(err)).toBe(true);
    expect((err as RejectedBatchError).refusal).toEqual({ table: 'launches', key: { launch_id: 'L2' }, sqlstate: '23505' });
    expect((err as Error).cause).toMatchObject({ code: '23505' });
    expect(String(err)).not.toMatch(/tok-L1/);
    expect(isFenced(err)).toBe(false);
    expect(await sink.tables({ raw: true })).toEqual(before);
    // The session is still the lock holder and still writes.
    await sink.applyBatch([{ op: 'upsert', table: 'kv', row: { key: 'ok', value: '1' } }]);
    expect(sink.fenced).toBe(false);
    expect(await count('kv', r)).toBe(1);
    store.close();
  });

  it('two launches with equal created_at inserted in non-alphabetical id order come back from a loaded image in insertion order', async () => {
    const r = run('order');
    const sink = await open(r);
    const store = new JournaledStore(new SqliteStore(':memory:'), sink);
    store.createLaunch(launch('Lz', 5));
    store.transaction(() => {
      store.createLaunch(launch('Lm', 5));
      store.createLaunch(launch('La', 5));
    });
    store.createLaunch(launch('Lb', 4));
    // An update does not move a launch.
    store.updateLaunch('Lz', { status: 'live' });
    await store.durable();
    expect(store.listLaunches().map((l) => l.launchId)).toEqual(['Lb', 'Lz', 'Lm', 'La']);
    const image = await sink.loadImage();
    expect(image.listLaunches().map((l) => l.launchId)).toEqual(['Lb', 'Lz', 'Lm', 'La']);
    expect(image.listLaunches({ status: 'preparing' }).map((l) => l.launchId)).toEqual(['Lb', 'Lm', 'La']);
    image.close();
    store.close();
  });

  it('after a load, event seq and ts, outbox id and createdAt are numbers, and new ids are above every loaded one', async () => {
    const r = run('types');
    const sink = await open(r);
    const store = new JournaledStore(new SqliteStore(':memory:'), sink);
    let lastSeq = 0;
    let lastId = 0;
    for (let i = 1; i <= 3; i++) {
      lastSeq = store.appendEvent({ kind: 'x', taskId: 'T1' }, 1_700_000_000_000 + i);
      lastId = store.insertOutbox({ sourceSeq: lastSeq, taskId: 'T1', kind: 'comment', payload: { i }, createdAt: 1_700_000_000_000 + i })!;
    }
    store.ackOutbox(lastId, { ok: true }, 1_700_000_000_999);
    store.createLaunch(launch('L1', 1_700_000_000_123));
    await store.durable();
    store.close();

    // The loader's own rows: bigint columns parsed, not strings (SQLite would coerce '5' silently).
    const rows = await sink.tables();
    for (const e of rows['events']!) for (const c of ['seq', 'ts']) expect(typeof e[c]).toBe('number');
    for (const o of rows['outbox']!) for (const c of ['id', 'source_seq', 'created_at', 'attempts']) expect(typeof o[c]).toBe('number');
    expect(typeof rows['outbox']!.at(-1)!['applied_at']).toBe('number');
    expect(typeof rows['launches']![0]!['created_at']).toBe('number');

    const image = await sink.loadImage();
    const events = image.listEvents();
    expect(events).toHaveLength(3);
    for (const e of events) {
      expect(typeof e.seq).toBe('number');
      expect(typeof e.ts).toBe('number');
    }
    const outbox = image.listOutbox();
    for (const o of outbox) {
      expect(typeof o.id).toBe('number');
      expect(typeof o.createdAt).toBe('number');
      expect(typeof o.sourceSeq).toBe('number');
    }
    expect(typeof image.getOutbox(lastId)!.appliedAt).toBe('number');
    expect(typeof image.getLaunch('L1')!.createdAt).toBe('number');
    // The image's next ids are above every loaded id.
    const again = new JournaledStore(image, sink);
    expect(again.durability()).toMatchObject({ eventSeq: lastSeq, outboxId: lastId });
    expect(again.appendEvent({ kind: 'y' }, 1)).toBe(lastSeq + 1);
    expect(again.insertOutbox({ sourceSeq: lastSeq + 1, taskId: 'T1', kind: 'comment', payload: {}, createdAt: 1 })!).toBeGreaterThan(lastId);
    await again.durable();
    await expectReloadEquals(sink, again.image);
    again.close();
  });
});

describe('Postgres driver', () => {
  it('the lockfile contains no native module: pg is pure JavaScript and pg-native is not installed', () => {
    const lock = JSON.parse(readFileSync(path.join(here, '../../package-lock.json'), 'utf8')) as {
      packages: Record<string, { dev?: boolean; hasInstallScript?: boolean; optional?: boolean }>;
    };
    const prod = Object.entries(lock.packages).filter(([k, v]) => k !== '' && !v.dev);
    expect(prod.filter(([, v]) => v.hasInstallScript).map(([k]) => k)).toEqual([]);
    expect(Object.keys(lock.packages).filter((k) => /(^|\/)(pg-native|libpq)$/.test(k))).toEqual([]);
    expect(prod.map(([k]) => k)).toContain('node_modules/pg');
  });
});
