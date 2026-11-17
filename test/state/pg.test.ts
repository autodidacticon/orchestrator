/**
 * Postgres sink specifics (ORC-15): run isolation, the run lock and fencing, idempotent and atomic
 * batches, launch insertion order, and number types after a load. Skipped without Postgres (pg-db.ts).
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type FatalInfo, FencedError, isFenced, isRejected, JournaledStore, type RejectedBatchError, type RowOp, TABLES } from '../../src/state/journal.js';
import { redactUrl, storeConfigError } from '../../src/config.js';
import { openStore, StoreOpenError } from '../../src/state/open.js';
import { batchStatements, COLUMNS, MIGRATIONS, migrate, NewerSchemaError, PgSink, readRun, RunLockedError, StoreSchemaError } from '../../src/state/pg/index.js';
import { SqliteStore } from '../../src/state/sqlite.js';
import { defaultEntry } from '../../src/state/status.js';
import type { Launch } from '../../src/state/store.js';
import { expectReloadEquals } from './backends.js';
import { ACCEPTED_SCHEMAS, adminClient, dropRun, freshRunId, freshSchema, pgAvailable, pgSource, REFUSED_SCHEMAS, stopTestPostgres, TEST_SCHEMA, testDatabase } from './pg-db.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The test database as a URL carrying a password (trust authentication ignores it). */
async function pgUrl(password: string): Promise<string> {
  const conn = await testDatabase();
  if (typeof conn === 'string') {
    const u = new URL(conn);
    if (!u.password) u.password = password;
    return u.toString();
  }
  return `postgresql://${conn.user}:${password}@${encodeURIComponent(String(conn.host))}:${conn.port}/${conn.database}`;
}

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
  const count = async (table: string, runId: string) => Number((await admin.query(`SELECT count(*)::int AS n FROM ${TEST_SCHEMA}.${table} WHERE run_id = $1`, [runId])).rows[0].n);

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
    expect(await migrate(admin, TEST_SCHEMA)).toEqual([]);
    const versions = (await admin.query(`SELECT version FROM ${TEST_SCHEMA}.orchestrator_migrations ORDER BY version`)).rows.map((x: { version: number }) => x.version);
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
    expect((await admin.query(`SELECT key FROM ${TEST_SCHEMA}.kv WHERE run_id = $1 ORDER BY key`, [r])).rows.map((x: { key: string }) => x.key)).toEqual(['before']);
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

  // Records an unknown version in the database: only on this file's own database on the run's cluster, never a shared TEST_DATABASE_URL, where the row would refuse every other file's open.
  it.skipIf(pgSource !== 'cluster')('a database migrated by a newer daemon is refused before the run lock', async () => {
    const known = Math.max(...MIGRATIONS.map((m) => m.version));
    const newer = known + 1;
    const versions = async () => (await admin.query(`SELECT version FROM ${TEST_SCHEMA}.orchestrator_migrations ORDER BY version`)).rows.map((x: { version: number }) => x.version);
    const r = run('newer');
    await open(r);
    const before = await versions();
    await admin.query(`INSERT INTO ${TEST_SCHEMA}.orchestrator_migrations (version, name) VALUES ($1, $2)`, [newer, 'from-a-newer-release']);
    try {
      const after = [...before, newer];
      // The first sink holds r's lock: a refusal for the version, not the lock, shows the check comes first.
      const same = await PgSink.open({ connection: await testDatabase(), runId: r }).catch((e: unknown) => e);
      expect(same).toBeInstanceOf(NewerSchemaError);
      expect(same).not.toBeInstanceOf(RunLockedError);
      expect(same).toMatchObject({ code: 'schemaNewer', recorded: newer, known });
      const other = run('newer-other');
      await expect(PgSink.open({ connection: await testDatabase(), runId: other })).rejects.toBeInstanceOf(NewerSchemaError);
      await expect(migrate(admin, TEST_SCHEMA)).rejects.toBeInstanceOf(NewerSchemaError);
      expect(await versions()).toEqual(after);

      const password = 'pw-s3cret-108';
      const url = await pgUrl(password);
      const err = await openStore({ store: { kind: 'postgres', url, flushDeadlineMs: 60_000 }, dataDir: tmpdir(), runId: other, onFatal: () => undefined }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(StoreOpenError);
      expect((err as StoreOpenError).code).toBe('schemaNewer');
      const message = (err as Error).message;
      expect(message).not.toContain(password);
      // The URL's host, port and database name hold digits too: look for the versions in the rest of the message.
      const shown = redactUrl(url)!;
      expect(message).toContain(shown);
      const rest = message.replace(shown, '');
      expect(rest).toMatch(new RegExp(`\\b${newer}\\b`));
      expect(rest).toMatch(new RegExp(`\\b${known}\\b`));
      expect(await versions()).toEqual(after);
    } finally {
      await admin.query(`DELETE FROM ${TEST_SCHEMA}.orchestrator_migrations WHERE version = $1`, [newer]);
    }
    expect(await versions()).toEqual(before);
    await open(run('newer-after'));
  });
});

interface Recorded {
  text: string;
  values: unknown[];
}

interface RecordingOptions {
  /** Whether the existence lookup finds the schema, and the rights the role holds on it. */
  schema?: { exists: boolean; usage?: boolean; create?: boolean };
  /** An error to throw for a statement, instead of answering it. */
  failOn?: (text: string) => unknown;
}

/**
 * A client that stands in for the server and answers `migrate()`'s and the loader's statements by what they ask for:
 * the schema lookup by `opts.schema`, the path settings by remembering the path they set, `current_schema()` by the
 * first schema of that path, the read of recorded versions with `recorded`, everything else with no rows.
 */
function recordingClient(recorded: number[], opts: RecordingOptions = {}): { client: pg.ClientBase; sent: string[]; log: Recorded[] } {
  const log: Recorded[] = [];
  const sent: string[] = [];
  let path: string | undefined;
  const query = async (q: string | { text: string; values?: unknown[] }, values?: unknown[]) => {
    const text = typeof q === 'string' ? q : q.text;
    const vals = (typeof q === 'string' ? values : (q.values ?? values)) ?? [];
    log.push({ text, values: vals });
    sent.push(text);
    const fail = opts.failOn?.(text);
    if (fail) throw fail;
    if (/pg_namespace/.test(text)) {
      const s = opts.schema ?? { exists: false };
      return { rows: s.exists ? [{ may_use: s.usage ?? true, may_create: s.create ?? true }] : [] };
    }
    const set = /set_config\(\s*'search_path'\s*,\s*\$1/i.test(text) ? String(vals[0]) : /^\s*SET\s+(LOCAL\s+)?search_path\s+(TO|=)\s+(.+)$/i.exec(text)?.[3];
    if (set !== undefined) {
      path = set;
      return { rows: [{}] };
    }
    if (/current_schema\(\)/i.test(text)) return { rows: [{ s: path ? path.split(',')[0]!.trim().replace(/^"|"$/g, '') : null }] };
    if (/^\s*SELECT\s+version\s+FROM\s+(\S+\.)?"?orchestrator_migrations\b/i.test(text)) return { rows: recorded.map((version) => ({ version })) };
    return { rows: [] };
  };
  return { client: { query } as unknown as pg.ClientBase, log, sent };
}

/** Whether a statement sets a transaction-local `search_path` holding `schema` alone (by `set_config(..., true)` or `SET LOCAL`). */
function setsLocalPathTo(r: Recorded, schema: string): boolean {
  const quoted = `"${schema}"`;
  if (/set_config\(\s*'search_path'\s*,\s*\$1\s*,\s*true\s*\)/i.test(r.text)) return r.values[0] === quoted;
  const m = /^\s*SET\s+LOCAL\s+search_path\s+(?:TO|=)\s+(.+?)\s*$/i.exec(r.text);
  return m?.[1] === quoted;
}

/** The store's tables and the bookkeeping table. */
const STORE_TABLES = [...TABLES.map((t) => t.name), 'orchestrator_migrations'];
const namesATable = (text: string) => STORE_TABLES.some((t) => new RegExp(`\\b${t}\\b`).test(text));

describe('migrate', () => {
  it('migrate refuses a recorded version it does not know', async () => {
    const known = Math.max(...MIGRATIONS.map((m) => m.version));
    const migrationSql = new Set(MIGRATIONS.map((m) => m.sql));
    for (const recorded of [[1, 2], [2]]) {
      const { client, sent } = recordingClient(recorded);
      const err = await migrate(client, TEST_SCHEMA).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NewerSchemaError);
      expect(err).toMatchObject({ code: 'schemaNewer', recorded: 2, known });
      expect((err as Error).message).toContain('2');
      expect((err as Error).message).toContain(String(known));
      expect((err as Error).message).toMatch(/upgrade/);
      expect(sent).toContain('ROLLBACK');
      expect(sent).not.toContain('COMMIT');
      expect(sent.filter((t) => migrationSql.has(t))).toEqual([]);
      expect(sent.filter((t) => /INSERT\s+INTO\s+(\S+\.)?"?orchestrator_migrations/i.test(t))).toEqual([]);
    }
    const { client, sent } = recordingClient([1]);
    await expect(migrate(client, TEST_SCHEMA)).resolves.toEqual([]);
    expect(sent).toContain('COMMIT');
    expect(sent).not.toContain('ROLLBACK');
    // The bookkeeping insert is seen when a migration is pending: the widened pattern matches the qualified name.
    const fresh = recordingClient([]);
    await expect(migrate(fresh.client, TEST_SCHEMA)).resolves.toEqual(MIGRATIONS.map((m) => m.version));
    expect(fresh.sent.filter((t) => /INSERT\s+INTO\s+(\S+\.)?"?orchestrator_migrations/i.test(t))).toHaveLength(MIGRATIONS.length);
  });
});

describe('store schema placement, without a server', () => {
  const S = 'scratch_place';

  it('every statement the sink builds names the schema', async () => {
    const value = (kind: string) => (kind === 'json' ? '{}' : kind === 'int' ? 1 : 'x');
    const ops: RowOp[] = [];
    for (const { name, key } of TABLES) {
      const row = Object.fromEntries(Object.entries(COLUMNS[name]!).map(([c, k]) => [c, value(k)]));
      ops.push({ op: 'upsert', table: name, row });
      ops.push({ op: 'delete', table: name, key: Object.fromEntries(key.map((c) => [c, row[c]!])) });
    }
    const statements = batchStatements(S, 'r1', ops);
    expect(statements).toHaveLength(2 * TABLES.length);
    // No statement reaches a table through an unqualified name.
    const unqualified = /\b(FROM|INTO|JOIN)\s+(?!"scratch_place"\.)/i;
    for (const [i, { name }] of TABLES.entries()) {
      const insert = statements[2 * i]!.text;
      const del = statements[2 * i + 1]!.text;
      expect(insert).toMatch(new RegExp(`^INSERT INTO "${S}"\\."${name}" `));
      expect(del).toMatch(new RegExp(`^DELETE FROM "${S}"\\."${name}" `));
      expect(insert).not.toMatch(unqualified);
      expect(del).not.toMatch(unqualified);
      if (name === 'launches') expect(insert).toMatch(new RegExp(`\\(SELECT COALESCE\\(MAX\\(ord\\), 0\\) \\+ 1 FROM "${S}"\\."launches" WHERE run_id = \\$1\\)`));
    }

    const reader = recordingClient([]);
    await readRun(reader.client, S, 'r1');
    const selects = reader.sent;
    expect(selects).toHaveLength(TABLES.length);
    for (const [i, { name }] of TABLES.entries()) {
      expect(selects[i]).toContain(`FROM "${S}"."${name}" WHERE`);
      expect(selects[i]).not.toMatch(unqualified);
    }

    // migrate(): every statement naming the bookkeeping table names the schema, whether it creates the schema or finds it.
    for (const exists of [false, true]) {
      const m = recordingClient([], { schema: { exists } });
      await migrate(m.client, S);
      const book = m.sent.filter((t) => /orchestrator_migrations/.test(t));
      expect(book.length).toBeGreaterThanOrEqual(3);
      for (const t of book) {
        expect(t).toContain(`"${S}"."orchestrator_migrations"`);
        expect(t.replaceAll(`"${S}"."orchestrator_migrations"`, '')).not.toMatch(/orchestrator_migrations/);
      }
    }
  });

  it('migrate creates the schema only when it is absent', async () => {
    const isLock = (t: string) => /pg_advisory_xact_lock/.test(t);
    const isCreate = (t: string) => /^\s*CREATE\s+SCHEMA\b/i.test(t);
    for (const exists of [false, true]) {
      const done = recordingClient([], { schema: { exists } });
      await migrate(done.client, S);
      const creates = done.sent.filter(isCreate);
      if (exists) {
        expect(creates).toEqual([]);
      } else {
        expect(creates).toEqual([`CREATE SCHEMA "${S}"`]);
        expect(done.sent.findIndex(isCreate)).toBeGreaterThan(done.sent.findIndex(isLock));
        expect(done.sent.findIndex(isLock)).toBeGreaterThan(-1);
      }
      // Never CREATE SCHEMA IF NOT EXISTS: the lookup comes first.
      expect(done.sent.filter((t) => /CREATE\s+SCHEMA\s+IF\s+NOT\s+EXISTS/i.test(t))).toEqual([]);
      const lookup = done.sent.findIndex((t) => /pg_namespace/.test(t));
      expect(lookup).toBeGreaterThan(done.sent.findIndex(isLock));
      if (!exists) expect(lookup).toBeLessThan(done.sent.findIndex(isCreate));
      // A transaction-local path holding the schema alone, set before the first statement that names a table.
      const pathAt = done.log.findIndex((r) => setsLocalPathTo(r, S));
      const firstTable = done.sent.findIndex((t) => namesATable(t) || MIGRATIONS.some((m) => m.sql === t));
      expect(pathAt).toBeGreaterThan(-1);
      expect(firstTable).toBeGreaterThan(pathAt);
      expect(done.sent[0]).toBe('BEGIN');
      expect(done.sent.at(-1)).toBe('COMMIT');
    }
  });

  it('a refused CREATE SCHEMA gives the grant advice for 42501 only, and always carries the server message', async () => {
    const refusal = (code: string, message: string) => Object.assign(new Error(message), { code });
    const denied = recordingClient([], { failOn: (t) => (/^CREATE SCHEMA/.test(t) ? refusal('42501', 'permission denied for database t_x') : undefined) });
    const err = (await migrate(denied.client, S).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(StoreSchemaError);
    expect(err.message).toContain(`"${S}"`);
    expect(err.message).toContain('permission denied for database t_x');
    expect(err.message).toContain('Grant the role CREATE on the database');
    expect(err.message).toContain(`create the schema "${S}" and grant the role USAGE and CREATE on it`);
    expect(denied.sent).toContain('ROLLBACK');
    expect(denied.sent).not.toContain('COMMIT');
    for (const [code, message] of [
      ['53100', 'could not extend file: No space left on device'],
      ['57014', 'canceling statement due to statement timeout'],
    ] as const) {
      const other = recordingClient([], { failOn: (t) => (/^CREATE SCHEMA/.test(t) ? refusal(code, message) : undefined) });
      const e = (await migrate(other.client, S).catch((x: unknown) => x)) as Error;
      expect(e).toBeInstanceOf(StoreSchemaError);
      expect(e.message).toContain(`"${S}"`);
      expect(e.message).toContain(message);
      expect(e.message).not.toMatch(/grant/i);
      expect(other.sent).toContain('ROLLBACK');
    }
    // A client-side failure (a lost connection) has no SQLSTATE: no advice either.
    const lost = recordingClient([], { failOn: (t) => (/^CREATE SCHEMA/.test(t) ? new Error('Connection terminated unexpectedly') : undefined) });
    const l = (await migrate(lost.client, S).catch((x: unknown) => x)) as Error;
    expect(l.message).toContain('Connection terminated unexpectedly');
    expect(l.message).not.toMatch(/grant/i);
  });

  it('an existing schema without USAGE or CREATE for the role is refused, naming the schema', async () => {
    for (const rights of [{ usage: false }, { create: false }, { usage: false, create: false }]) {
      const c = recordingClient([], { schema: { exists: true, ...rights } });
      const err = (await migrate(c.client, S).catch((e: unknown) => e)) as Error;
      expect(err).toBeInstanceOf(StoreSchemaError);
      expect(err.message).toContain(`"${S}"`);
      if (rights.usage === false) expect(err.message).toContain('USAGE');
      if (rights.create === false) expect(err.message).toContain('CREATE');
      expect(c.sent.filter((t) => namesATable(t))).toEqual([]);
    }
  });

  it('a schema name the store does not accept is refused before connecting', async () => {
    // Nothing listens on port 1: an accepted name gets as far as the connection and fails there.
    const unreachable: pg.ClientConfig = { host: '127.0.0.1', port: 1, connectionTimeoutMillis: 3_000 };
    for (const name of [...REFUSED_SCHEMAS, ...ACCEPTED_SCHEMAS]) {
      const err = (await PgSink.open({ connection: unreachable, runId: 'r', schema: name }).catch((e: unknown) => e)) as Error;
      expect(err).toBeInstanceOf(Error);
      const byConfig = storeConfigError({ leaseTtlMs: 600_000, store: { kind: 'postgres', url: 'postgres://h/db', flushDeadlineMs: 120_000, schema: name } });
      // PgSink.open's check and the configuration check agree on every name.
      expect(err instanceof StoreSchemaError, name).toBe(byConfig !== undefined);
      if (REFUSED_SCHEMAS.includes(name)) {
        expect(err.message).toContain(JSON.stringify(name));
        expect(err.message).toContain('store.schema');
        expect(err.message).toBe(byConfig);
      } else {
        expect(err.message).not.toContain('store.schema');
      }
    }
    // The helpers refuse a bad name before building a statement.
    expect(() => batchStatements('Bad-Name', 'r', [])).not.toThrow();
    expect(() => batchStatements('Bad-Name', 'r', [{ op: 'upsert', table: 'kv', row: { key: 'k', value: 'v' } }])).toThrow(StoreSchemaError);
    const c = recordingClient([]);
    await expect(migrate(c.client, 'Bad-Name')).rejects.toBeInstanceOf(StoreSchemaError);
    expect(c.sent).toEqual([]);
  });
});

/** One row in every table of `TABLES`, through the store's own writes. */
function writeEveryTable(store: JournaledStore): void {
  store.transaction(() => {
    store.setEntry('T1', { ...defaultEntry(), launches: 1 });
    store.appendEvent({ kind: 'x', taskId: 'T1', payload: { a: 1 } }, 1);
    store.putDedup('L1', 1, { ok: true });
    store.createLaunch(launch('L1', 1));
    store.createJob({ jobId: 'J1', taskId: 'T1', launchId: 'L1', sealedSha: 'x', baseSha: 'b', status: 'queued', applied: false, createdAt: 1, updatedAt: 1 });
    store.putReport({ launchId: 'L1', taskId: 'T1', kind: 'submit', body: { summary: 'ok' }, createdAt: 1 });
    store.setPayloadOverlay('T1', 'rev-1', { description: 'd' });
    store.setSnapshot('rev-1', 'nodes: []');
    store.setKv('k', 'v');
    store.createProposal({ id: 'T1-p1', taskId: 'T1', launchId: 'L1', status: 'pending', payload: { title: 't', description: 'd', acceptanceCriteria: ['a'] }, createdAt: 1 });
    store.insertOutbox({ sourceSeq: 1, taskId: 'T1', kind: 'setState', payload: {}, createdAt: 1 });
  });
}

const OTHER_SCHEMA_KINDS = "n.nspname NOT LIKE 'pg_temp%' AND n.nspname NOT LIKE 'pg_toast%'";

describe.skipIf(!pgAvailable)('store schema placement', () => {
  let admin: pg.Client;
  const opened: PgSink[] = [];
  const schemas: string[] = [];
  const runs: string[] = [];

  const scratch = (label = 'sch') => {
    const s = freshSchema(label);
    schemas.push(s);
    return s;
  };
  const run = (label: string) => {
    const id = freshRunId(label);
    runs.push(id);
    return id;
  };
  const openIn = async (schema: string, runId: string, connection?: string | pg.ClientConfig): Promise<PgSink> => {
    const sink = await PgSink.open({ connection: connection ?? (await testDatabase()), runId, schema });
    opened.push(sink);
    return sink;
  };
  /** The test database's connection with startup options (a `search_path` the connection asks for). */
  const withOptions = async (options: string): Promise<pg.ClientConfig> => {
    const conn = await testDatabase();
    return typeof conn === 'string' ? { connectionString: conn, options } : { ...conn, options };
  };
  const relationsIn = async (schema: string, kind: 'r' | 'i') =>
    (await admin.query('SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind = $2 ORDER BY 1', [schema, kind])).rows.map(
      (r: { relname: string }) => r.relname,
    );
  const allRelations = async () =>
    new Set((await admin.query(`SELECT n.nspname || '.' || c.relname AS r FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE ${OTHER_SCHEMA_KINDS}`)).rows.map((x: { r: string }) => x.r));
  const schemaExists = async (schema: string) => (await admin.query('SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = $1', [schema])).rows[0].n as number;
  const countIn = async (schema: string, table: string, runId?: string) =>
    Number((await admin.query(`SELECT count(*)::int AS n FROM "${schema}"."${table}"${runId ? ' WHERE run_id = $1' : ''}`, runId ? [runId] : [])).rows[0].n);

  beforeAll(async () => {
    admin = await adminClient();
  }, 120_000);
  afterEach(async () => {
    for (const s of opened.splice(0)) await s.close();
    for (const r of runs.splice(0)) await dropRun(r);
    for (const s of schemas.splice(0)) await admin.query(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
  });
  afterAll(async () => {
    await admin?.end();
    await stopTestPostgres();
  });

  it('the tables and indexes are created in the named schema', async () => {
    const s = scratch();
    expect(await schemaExists(s)).toBe(0);
    const before = await allRelations();
    await openIn(s, run('place'));
    expect(await relationsIn(s, 'r')).toEqual([...STORE_TABLES].sort());
    const indexes = await relationsIn(s, 'i');
    expect(indexes).toEqual(expect.arrayContaining(['events_task', 'launches_task', 'launches_status', 'proposals_status', 'outbox_status']));
    // The rest are primary-key and unique indexes, in the same schema.
    if (pgSource === 'cluster') {
      // On this file's own database nothing else runs: no schema other than the named one gained a relation.
      const gained = [...(await allRelations())].filter((r) => !before.has(r) && !r.startsWith(`${s}.`));
      expect(gained).toEqual([]);
    }
  });

  it("the sink's session path is its own schema, whatever the connection asked for", async () => {
    const s = scratch();
    const other = scratch('first');
    await admin.query(`CREATE SCHEMA "${other}"`);
    const conn = await withOptions(`-c search_path=${other},public`);
    // The connection really asks for the other schema first.
    const plain = new pg.Client(conn);
    await plain.connect();
    try {
      expect((await plain.query('SELECT current_schema() AS s')).rows[0].s).toBe(other);
    } finally {
      await plain.end();
    }
    const sink = await openIn(s, run('path'), conn);
    expect((await sink.client.query('SELECT current_schema() AS s')).rows[0].s).toBe(s);
    expect((await sink.client.query('SHOW search_path')).rows[0].search_path).toBe(`"${s}"`);
  });

  it('tables of the same names on the connection\'s own path are never read or written', async () => {
    const s = scratch();
    const decoy = scratch('decoy');
    // Tables named like all twelve of the store's, in the schema the connection puts first.
    await migrate(admin, decoy);
    expect(await relationsIn(decoy, 'r')).toEqual([...STORE_TABLES].sort());
    const decoyRelations = [...(await relationsIn(decoy, 'r')), ...(await relationsIn(decoy, 'i'))];
    const sink = await openIn(s, run('decoy'), await withOptions(`-c search_path=${decoy}`));
    const store = new JournaledStore(new SqliteStore(':memory:'), sink);
    writeEveryTable(store);
    store.updateLaunch('L1', { status: 'live' });
    await store.durable();
    for (const { name } of TABLES) expect(await countIn(s, name, sink.runId), name).toBeGreaterThan(0);
    await expectReloadEquals(sink, store.image);
    for (const name of TABLES.map((t) => t.name)) expect(await countIn(decoy, name), `${decoy}.${name}`).toBe(0);
    expect(await countIn(decoy, 'orchestrator_migrations')).toBe(MIGRATIONS.length);
    expect([...(await relationsIn(decoy, 'r')), ...(await relationsIn(decoy, 'i'))]).toEqual(decoyRelations);
    store.close();
  });

  it('a sink on another schema keeps every row there', async () => {
    await migrate(admin, TEST_SCHEMA); // the default schema exists, so "no row there" is a real count
    const s = scratch();
    const r = run('elsewhere');
    const sink = await openIn(s, r);
    const store = new JournaledStore(new SqliteStore(':memory:'), sink);
    writeEveryTable(store);
    await store.durable();
    const tables = await sink.tables();
    for (const { name } of TABLES) expect(tables[name]!.length, name).toBeGreaterThan(0);
    const image = await sink.loadImage();
    expect(image.getKv('k')).toBe('v');
    expect(image.getLaunch('L1')?.taskId).toBe('T1');
    image.close();
    for (const { name } of TABLES) {
      expect(await countIn(s, name, r), name).toBeGreaterThan(0);
      expect(await countIn(TEST_SCHEMA, name, r), name).toBe(0);
    }
    store.close();
  });

  it("migrate does not change the caller's search_path", async () => {
    const c = await adminClient();
    try {
      await c.query('SET search_path TO public, pg_catalog');
      const show = async () => (await c.query('SHOW search_path')).rows[0].search_path as string;
      const before = await show();
      // Succeeds, creating the schema.
      const ok = scratch();
      expect(await migrate(c, ok)).toEqual(MIGRATIONS.map((m) => m.version));
      expect(await show()).toBe(before);
      // Throws after the path was set: migration 1 fails.
      const bad = scratch();
      const failing = {
        query: (q: string | { text: string }, v?: unknown[]) => {
          if ((typeof q === 'string' ? q : q.text) === MIGRATIONS[0]!.sql) return Promise.reject(new Error('injected failure'));
          return c.query(q as string, v);
        },
      } as unknown as pg.ClientBase;
      await expect(migrate(failing, bad)).rejects.toThrow('injected failure');
      expect(await show()).toBe(before);
      // Succeeds again on the existing schema, with nothing pending.
      expect(await migrate(c, ok)).toEqual([]);
      expect(await show()).toBe(before);
    } finally {
      await c.end();
    }
  });

  it('the session path survives a refused batch', async () => {
    const s = scratch();
    const sink = await openIn(s, run('refused'));
    // graph_snapshot's id is CHECK (id = 1): the server refuses the batch for its content.
    const err = await sink.applyBatch([{ op: 'upsert', table: 'graph_snapshot', row: { id: 2, rev: 'r', content: 'c' } }]).catch((e: unknown) => e);
    expect(isRejected(err)).toBe(true);
    expect(sink.fenced).toBe(false);
    expect((await sink.client.query('SELECT current_schema() AS s')).rows[0].s).toBe(s);
    await sink.applyBatch([{ op: 'upsert', table: 'kv', row: { key: 'after', value: '1' } }]);
    expect(await countIn(s, 'kv', sink.runId)).toBe(1);
  });

  it('two sinks opening at once on a new schema both succeed', async () => {
    const s = scratch();
    const [a, b] = await Promise.all([openIn(s, run('twin-a')), openIn(s, run('twin-b'))]);
    expect(a.schema).toBe(s);
    expect(b.schema).toBe(s);
    expect(await schemaExists(s)).toBe(1);
    expect(await countIn(s, 'orchestrator_migrations')).toBe(MIGRATIONS.length);
  });

  it('a failed first open leaves no schema behind', async () => {
    const s = scratch();
    const c = await adminClient();
    try {
      const wrapper = {
        query: (q: string | { text: string }, v?: unknown[]) => {
          if ((typeof q === 'string' ? q : q.text) === MIGRATIONS[0]!.sql) throw new Error('refusing migration 1');
          return c.query(q as string, v);
        },
      } as unknown as pg.ClientBase;
      await expect(migrate(wrapper, s)).rejects.toThrow('refusing migration 1');
      expect(await schemaExists(s)).toBe(0);
    } finally {
      await c.end();
    }
  });

  it('one run id cannot be live in two schemas of one database', async () => {
    const [s1, s2] = [scratch('one'), scratch('two')];
    const r = run('both');
    await openIn(s1, r);
    const refused = await PgSink.open({ connection: await testDatabase(), runId: r, schema: s2 }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(RunLockedError);
    await openIn(s2, run('both-other'));
    // A run id free in this database opens in either schema.
    await openIn(s1, run('both-third'));
  });

  it.skipIf(pgSource !== 'cluster')('a role that may not create schemas uses a ready-made one and is refused without it', async () => {
    const role = `orch_role_${randomBytes(6).toString('hex')}`;
    const conn = (await testDatabase()) as pg.ClientConfig;
    const asRole: pg.ClientConfig = { ...conn, user: role };
    const ready = scratch('ready');
    const absent = scratch('absent');
    const noUsage = scratch('nousage');
    await admin.query(`CREATE ROLE ${role} LOGIN`);
    try {
      // A ready-made schema with USAGE and CREATE granted: the tables are created there.
      await admin.query(`CREATE SCHEMA "${ready}"`);
      await admin.query(`GRANT USAGE, CREATE ON SCHEMA "${ready}" TO ${role}`);
      const sink = await openIn(ready, run('role'), asRole);
      expect(await relationsIn(ready, 'r')).toEqual([...STORE_TABLES].sort());
      await sink.applyBatch([{ op: 'upsert', table: 'kv', row: { key: 'k', value: 'v' } }]);
      expect(await countIn(ready, 'kv', sink.runId)).toBe(1);

      // Absent, and the role may not create it: both remedies and the server's message.
      const err = (await PgSink.open({ connection: asRole, runId: run('role-absent'), schema: absent }).catch((e: unknown) => e)) as Error;
      expect(err).toBeInstanceOf(StoreSchemaError);
      expect(err.message).toContain(absent);
      expect(err.message).toContain('Grant the role CREATE on the database');
      expect(err.message).toContain(`create the schema "${absent}" and grant the role USAGE and CREATE on it`);
      expect(err.message).toMatch(/permission denied for database/);
      expect(await schemaExists(absent)).toBe(0);

      // Present, without USAGE: refused, naming the schema.
      await admin.query(`CREATE SCHEMA "${noUsage}"`);
      await admin.query(`GRANT CREATE ON SCHEMA "${noUsage}" TO ${role}`);
      const denied = (await PgSink.open({ connection: asRole, runId: run('role-nousage'), schema: noUsage }).catch((e: unknown) => e)) as Error;
      expect(denied).toBeInstanceOf(Error);
      expect(denied.message).toContain(noUsage);
      expect(await relationsIn(noUsage, 'r')).toEqual([]);
    } finally {
      for (const s of opened.splice(0)) await s.close();
      for (const s of [ready, absent, noUsage]) await admin.query(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
      await admin.query(`DROP OWNED BY ${role}`);
      await admin.query(`DROP ROLE ${role}`);
    }
  });

  it("dropRun deletes the run's rows", async () => {
    const r = freshRunId('drop');
    const sink = await PgSink.open({ connection: await testDatabase(), runId: r });
    expect(sink.schema).toBe(TEST_SCHEMA);
    const store = new JournaledStore(new SqliteStore(':memory:'), sink);
    writeEveryTable(store);
    await store.durable();
    store.close();
    await sink.close();
    for (const { name } of TABLES) expect(await countIn(TEST_SCHEMA, name, r), name).toBeGreaterThan(0);
    await dropRun(r);
    for (const { name } of TABLES) expect(await countIn(TEST_SCHEMA, name, r), name).toBe(0);
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
