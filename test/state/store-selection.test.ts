/**
 * Store selection (ORC-20): the store block, URL redaction, the lease-versus-deadline check, the override
 * document never selecting a store, the proposed-graph slot on every backend, the store graph source, journal
 * readiness, and opening Postgres with its fatal paths. See specs/state-backend and specs/graph-import.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configSchema, defaultConfig, leaseCoversFlushDeadline, minLeaseTtlMs, redactUrl, storeConfigError, storeSchemaOf, storeUrlSource, urlSecrets, withStoreEnv } from '../../src/config.js';
import { StoreGraphSource } from '../../src/graph/source.js';
import { parseOverridePatch, parseSetFlags, readOverrides, type Resolved, storeReportOf } from '../../src/runs/resolve.js';
import { STORE_SCHEMA_RULE } from '../../src/state/pg/schema.js';
import { type FatalInfo, JournaledStore, type JournalSink, type RowOp } from '../../src/state/journal.js';
import { openStore, type OpenedStore, StoreOpenError } from '../../src/state/open.js';
import { SqliteStore } from '../../src/state/sqlite.js';
import { backends } from './backends.js';
import { ACCEPTED_SCHEMAS, adminClient, dropRun, freshRunId, pgAvailable, pgSource, REFUSED_SCHEMAS, stopTestPostgres, TEST_SCHEMA, testDatabase } from './pg-db.js';

const G1 = 'nodes:\n  - { id: T1, deps: [], description: d, acceptanceCriteria: [a] }\n';
const G2 = 'nodes:\n  - { id: T1, deps: [], description: d, acceptanceCriteria: [a] }\n  - { id: T2, deps: [T1], description: d, acceptanceCriteria: [a] }\n';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'orch-storesel-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function until(pred: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('store block', () => {
  it('defaults to sqlite with a 120s flush deadline; DATABASE_URL fills an unset url under postgres only and never overrides the file', () => {
    const d = defaultConfig();
    expect(d.store).toEqual({ kind: 'sqlite', flushDeadlineMs: 120_000 });
    expect(withStoreEnv(d, { DATABASE_URL: 'postgres://u:p@h/db' }).store.url).toBeUndefined();
    expect(withStoreEnv(defaultConfig({ store: { kind: 'postgres' } }), { DATABASE_URL: 'postgres://u:p@h/db' }).store.url).toBe('postgres://u:p@h/db');
    const fromFile = defaultConfig({ store: { kind: 'postgres', url: 'postgres://file@h/db' } });
    expect(withStoreEnv(fromFile, { DATABASE_URL: 'postgres://env@h/db' }).store.url).toBe('postgres://file@h/db');
    expect(withStoreEnv(d, {}).store.url).toBeUndefined();
  });

  it('a URL file (store.urlFile, else DATABASE_URL_FILE) fills an unset url; two sources at once and an unreadable or empty file are refused without the URL (ORC-100)', () => {
    const file = path.join(dir, 'uri');
    writeFileSync(file, '  postgres://u:pw-file@h/db\n');
    const other = path.join(dir, 'other');
    writeFileSync(other, 'postgres://u:pw-other@h/db');
    // Under sqlite no URL file is read, not even a missing one.
    expect(withStoreEnv(defaultConfig(), { DATABASE_URL_FILE: path.join(dir, 'absent') }).store.url).toBeUndefined();
    const d = defaultConfig({ store: { kind: 'postgres' } });
    expect(withStoreEnv(d, { DATABASE_URL_FILE: file }).store.url).toBe('postgres://u:pw-file@h/db');
    // Read once per process: a later change to the file is not seen by a second resolution.
    writeFileSync(file, 'postgres://u:pw-rotated@h/db');
    expect(withStoreEnv(d, { DATABASE_URL_FILE: file }).store.url).toBe('postgres://u:pw-file@h/db');
    const withFile = defaultConfig({ store: { kind: 'postgres', urlFile: file } });
    expect(withStoreEnv(withFile, {}).store.url).toBe('postgres://u:pw-file@h/db');
    // store.urlFile wins over both environment inputs; store.url wins over the environment's file.
    expect(withStoreEnv(withFile, { DATABASE_URL_FILE: other, DATABASE_URL: 'postgres://env@h/db' }).store.url).toBe('postgres://u:pw-file@h/db');
    const withUrl = defaultConfig({ store: { kind: 'postgres', url: 'postgres://cfg@h/db' } });
    expect(withStoreEnv(withUrl, { DATABASE_URL_FILE: other }).store.url).toBe('postgres://cfg@h/db');
    expect(() => withStoreEnv(defaultConfig({ store: { kind: 'postgres', url: 'postgres://cfg@h/db', urlFile: file } }), {})).toThrow('store.url and store.urlFile are both set');
    expect(() => withStoreEnv(d, { DATABASE_URL: 'postgres://env@h/db', DATABASE_URL_FILE: file })).toThrow('DATABASE_URL and DATABASE_URL_FILE are both set');
    // Not refused under sqlite (no file is read), nor when the config names its own source.
    expect(withStoreEnv(defaultConfig(), { DATABASE_URL: 'postgres://env@h/db', DATABASE_URL_FILE: file }).store.url).toBeUndefined();
    const missing = path.join(dir, 'absent');
    expect(() => withStoreEnv(d, { DATABASE_URL_FILE: missing })).toThrow(`cannot read the database URL file ${missing} (DATABASE_URL_FILE): ENOENT`);
    const empty = path.join(dir, 'empty');
    writeFileSync(empty, '\n');
    expect(() => withStoreEnv(defaultConfig({ store: { kind: 'postgres', urlFile: empty } }), {})).toThrow(`the database URL file ${empty} (store.urlFile) is empty`);
    expect(storeConfigError({ leaseTtlMs: 600_000, store: { kind: 'postgres', flushDeadlineMs: 120_000 } })).toContain('DATABASE_URL_FILE');
  });

  it('removes the password from every URL form, and names every printed form of it as a secret', () => {
    expect(redactUrl('postgresql://orch:hunter2@db.example:5432/orch?sslmode=require')).toBe('postgresql://orch@db.example:5432/orch?sslmode=require');
    expect(redactUrl('postgres://orch@db/orch?password=hunter2&sslmode=disable')).toBe('postgres://orch@db/orch?sslmode=disable');
    expect(redactUrl("host=db user=orch password='hun ter2' dbname=orch")).toBe('host=db user=orch password= dbname=orch');
    expect(redactUrl('postgres://orch@db/orch')).toBe('postgres://orch@db/orch');
    expect(redactUrl(undefined)).toBeUndefined();
    expect(urlSecrets('postgresql://orch:p%40ss@db/orch')).toEqual(['p%40ss', 'p@ss']);
    expect(urlSecrets('postgres://orch@db/orch')).toEqual([]);
  });

  it('under postgres, a lease shorter than the flush deadline is refused naming both; sqlite is unchecked', () => {
    const msg = storeConfigError({ leaseTtlMs: 60_000, store: { kind: 'postgres', url: 'postgres://h/db', flushDeadlineMs: 120_000 } });
    expect(msg).toContain('leaseTtlMs (60000)');
    expect(msg).toContain('store.flushDeadlineMs (120000)');
    // A lease equal to the deadline is refused too: a stall may begin a renewal interval into the lease, and the lease must outlast the deadline by one more.
    const equal = storeConfigError({ leaseTtlMs: 120_000, store: { kind: 'postgres', url: 'postgres://h/db', flushDeadlineMs: 120_000 } });
    expect(equal).toContain('leaseTtlMs (120000)');
    expect(equal).toContain('at least 360000');
    expect(minLeaseTtlMs(120_000)).toBe(360_000);
    for (const deadline of [1, 2, 1_500, 120_000, 120_001]) {
      // The suggested minimum always passes; a lease whose margin falls short is refused.
      const min = minLeaseTtlMs(deadline);
      expect(min - 2 * Math.max(1, Math.floor(min / 3))).toBeGreaterThanOrEqual(deadline);
      expect(storeConfigError({ leaseTtlMs: min, store: { kind: 'postgres', url: 'postgres://h/db', flushDeadlineMs: deadline } })).toBeUndefined();
      expect(leaseCoversFlushDeadline(min, deadline)).toBe(true);
    }
    for (const [ttl, deadline] of [[300_000, 120_000], [240_000, 120_000], [3_000, 1_500]] as const) {
      expect(leaseCoversFlushDeadline(ttl, deadline)).toBe(false);
      expect(storeConfigError({ leaseTtlMs: ttl, store: { kind: 'postgres', url: 'postgres://h/db', flushDeadlineMs: deadline } })).toBeDefined();
    }
    expect(storeConfigError({ leaseTtlMs: 600_000, store: { kind: 'postgres', url: 'postgres://h/db', flushDeadlineMs: 120_000 } })).toBeUndefined();
    expect(storeConfigError({ leaseTtlMs: 1_000, store: { kind: 'sqlite', flushDeadlineMs: 120_000 } })).toBeUndefined();
    expect(storeConfigError({ leaseTtlMs: 600_000, store: { kind: 'postgres', flushDeadlineMs: 120_000 } })).toContain('DATABASE_URL');
  });

  it('a store key in the stored override document is ignored and its siblings survive; a patch or --set naming store is refused', () => {
    const store = new SqliteStore(':memory:');
    store.setKv('config.overrides', JSON.stringify({ capacity: 3, store: { kind: 'postgres', url: 'postgres://x:y@h/db' } }));
    expect(readOverrides(store)).toEqual({ capacity: 3 });
    store.close();
    expect(parseOverridePatch({ store: { kind: 'postgres' } }).ok).toBe(false);
    expect(() => parseSetFlags(['store={"kind":"postgres"}'])).toThrow(/unknown key/);
    // store.schema is never an override either.
    const withSchema = new SqliteStore(':memory:');
    withSchema.setKv('config.overrides', JSON.stringify({ capacity: 2, store: { schema: 'x' } }));
    expect(readOverrides(withSchema)).toEqual({ capacity: 2 });
    withSchema.close();
    expect(() => parseSetFlags(['store.schema=x'])).toThrow(/unknown key/);
    expect(parseOverridePatch({ store: { schema: 'x' } }).ok).toBe(false);
  });

  it('store.schema accepts lower-case names and refuses the rest under postgres only', () => {
    const check = (kind: 'sqlite' | 'postgres', schema: string) =>
      storeConfigError({ leaseTtlMs: 600_000, store: { kind, url: 'postgres://h/db', flushDeadlineMs: 120_000, schema } });
    for (const name of REFUSED_SCHEMAS) {
      const msg = check('postgres', name);
      expect(msg, JSON.stringify(name)).toContain('store.schema');
      expect(msg).toContain(JSON.stringify(name));
      expect(msg).toContain(STORE_SCHEMA_RULE);
      expect(check('sqlite', name)).toBeUndefined();
    }
    for (const name of ACCEPTED_SCHEMAS) {
      expect(check('postgres', name), name).toBeUndefined();
      expect(check('sqlite', name)).toBeUndefined();
    }
    // Unset is the default, which passes.
    expect(storeConfigError({ leaseTtlMs: 600_000, store: { kind: 'postgres', url: 'postgres://h/db', flushDeadlineMs: 120_000 } })).toBeUndefined();
    expect(storeSchemaOf(defaultConfig().store)).toBe('orchestrator');
    expect(storeSchemaOf(defaultConfig({ store: { schema: '' } }).store)).toBe('');
    // A value that is not a string fails the parse on every store kind, at store.schema.
    for (const kind of ['sqlite', 'postgres'] as const) {
      for (const value of [123, true]) {
        const parsed = configSchema.safeParse({ store: { kind, schema: value } });
        expect(parsed.success).toBe(false);
        expect(parsed.error?.issues.map((i) => i.path)).toContainEqual(['store', 'schema']);
        expect(() => configSchema.parse({ store: { kind, schema: value } })).toThrow();
      }
    }
  });

  it('the store report shows the schema in force under postgres', () => {
    const report = (raw: Record<string, unknown>) => {
      const config = withStoreEnv(defaultConfig(raw as never), { DATABASE_URL: 'postgres://u:pw@h/db' });
      return storeReportOf({ config, inputs: { fileRaw: raw } } as unknown as Pick<Resolved, 'config' | 'inputs'>);
    };
    expect(report({ store: { kind: 'postgres' } }).schema).toBe('orchestrator');
    expect(report({ store: { kind: 'postgres', schema: 'team_a' } }).schema).toBe('team_a');
    expect(report({ store: { kind: 'sqlite' } })).not.toHaveProperty('schema');
    expect(report({ store: { kind: 'sqlite', schema: 'team_a' } })).not.toHaveProperty('schema');
    expect(report({})).not.toHaveProperty('schema');
  });

  it('under sqlite DATABASE_URL is not a store input: no url and no urlSource; a url written in the file is still reported', () => {
    const env = { DATABASE_URL: 'postgres://u:pw@h/db' };
    const sqlite = withStoreEnv(defaultConfig(), env);
    expect(sqlite.store.url).toBeUndefined();
    expect(storeUrlSource(sqlite, undefined, env)).toBeUndefined();
    const rep = storeReportOf({ config: sqlite, inputs: { fileRaw: undefined } } as unknown as Pick<Resolved, 'config' | 'inputs'>);
    expect(rep).not.toHaveProperty('url');
    expect(rep).not.toHaveProperty('urlSource');
    const fileRaw = { store: { kind: 'sqlite', url: 'postgres://file:pw@h/db' } };
    const fromFile = withStoreEnv(defaultConfig(fileRaw as never), env);
    expect(fromFile.store.url).toBe('postgres://file:pw@h/db');
    expect(storeUrlSource(fromFile, fileRaw, env)).toBe('file');
    const repFile = storeReportOf({ config: fromFile, inputs: { fileRaw } } as unknown as Pick<Resolved, 'config' | 'inputs'>);
    expect(repFile).toMatchObject({ kind: 'sqlite', url: 'postgres://file@h/db', urlSource: 'file' });
    // Under postgres DATABASE_URL alone fills the url, from the environment.
    const pgOnly = withStoreEnv(defaultConfig({ store: { kind: 'postgres' } }), env);
    expect(pgOnly.store.url).toBe('postgres://u:pw@h/db');
    expect(storeUrlSource(pgOnly, { store: { kind: 'postgres' } }, env)).toBe('environment');
  });
});

describe.each(backends)('proposed-graph slot: $name', (backend) => {
  afterEach(async () => {
    await backend.release();
  });
  afterAll(async () => {
    await backend.shutdown();
  });

  it.skipIf(!backend.available)('holds the proposed graph apart from the accepted snapshot, with a stamp per write, across a reopen', async () => {
    let store = await backend.open(dir);
    expect(store.getProposedGraph()).toBeUndefined();
    store.setSnapshot('rev-accepted', G1);
    const first = store.setProposedGraph('rev-2', G2);
    const again = store.setProposedGraph('rev-2', G2);
    expect(again.stamp).toBe(first.stamp + 1);
    store = await backend.reopen(store, dir);
    expect(store.getProposedGraph()).toMatchObject({ rev: 'rev-2', content: G2, stamp: again.stamp });
    expect(store.getSnapshot()).toEqual({ rev: 'rev-accepted', content: G1 });
    await backend.check(store);
    store.close();
  });
});

describe('StoreGraphSource', () => {
  it('reads the proposed slot once per write: an unchanged rejected document is not returned again, a re-sent one is', async () => {
    const store = new SqliteStore(':memory:');
    const source = new StoreGraphSource(store);
    expect(await source.poll(undefined)).toBeUndefined();
    store.setProposedGraph('x', G1);
    const got = await source.poll(undefined);
    expect(got?.content).toBe(G1);
    // Rejected: the known rev stays undefined, the stamp is unchanged.
    expect(await source.poll(undefined)).toBeUndefined();
    store.setProposedGraph('x', G1);
    expect((await source.poll(undefined))?.content).toBe(G1);
    // Accepted: polling with the accepted rev returns nothing.
    expect(await source.poll(got!.graph.rev)).toBeUndefined();
    store.close();
  });
});

/** A sink whose applies hang until released. */
class StallSink implements JournalSink {
  lockLost = false;
  release: (() => void) | undefined;
  async applyBatch(_ops: readonly RowOp[]): Promise<void> {
    await new Promise<void>((r) => (this.release = r));
  }
}

describe('journal readiness', () => {
  it('is ready with nothing pending; not ready once the lag exceeds one flush retry, when the lock is lost, and after a fatal', async () => {
    const sink = new StallSink();
    const fatal: FatalInfo[] = [];
    const j = new JournaledStore(new SqliteStore(':memory:'), sink, { flushDeadlineMs: 60_000, retryMaxMs: 50, onFatal: (i) => fatal.push(i) });
    expect(j.readiness()).toEqual([]);
    j.setKv('a', '1');
    expect(j.readiness()).toEqual([]);
    await new Promise((r) => setTimeout(r, 80));
    expect(j.readiness()[0]).toMatch(/1 batches unflushed for \d+ms, longer than one flush retry \(50ms\)/);
    sink.release?.();
    await j.durable();
    expect(j.readiness()).toEqual([]);
    sink.lockLost = true;
    expect(j.readiness()).toEqual(['store: the session holding the run lock was lost']);
    j.fence(new Error('gone'));
    expect(fatal).toMatchObject([{ reason: 'fenced', unflushedBatches: 0 }]);
    expect(j.readiness()[0]).toContain('the run lock was lost');
    j.close();
  });
});

describe('openStore', () => {
  it('sqlite opens <dataDir>/store.sqlite', async () => {
    const opened = await openStore({ store: { kind: 'sqlite', flushDeadlineMs: 120_000 }, dataDir: dir, runId: 'r', onFatal: () => undefined });
    expect(opened.kind).toBe('sqlite');
    expect(opened.store).toBeInstanceOf(SqliteStore);
    await opened.close();
  });
});

/** The test database as a URL carrying a password (trust authentication ignores it). */
async function pgUrl(password = 'pw-s3cret'): Promise<string> {
  const conn = await testDatabase();
  if (typeof conn === 'string') {
    const u = new URL(conn);
    if (!u.password) u.password = password;
    return u.toString();
  }
  return `postgresql://${conn.user}:${password}@${encodeURIComponent(String(conn.host))}:${conn.port}/${conn.database}`;
}

describe.skipIf(!pgAvailable)('openStore over Postgres', () => {
  const runs: string[] = [];
  const opened: OpenedStore[] = [];
  afterEach(async () => {
    for (const o of opened.splice(0)) await o.close(200).catch(() => undefined);
    for (const r of runs.splice(0)) await dropRun(r);
  });
  afterAll(async () => {
    await stopTestPostgres();
  });

  it('takes the run lock, loads the image, and a second open of the run is refused with a clear error', async () => {
    const runId = freshRunId('sel');
    runs.push(runId);
    const url = await pgUrl();
    const a = await openStore({ store: { kind: 'postgres', url, flushDeadlineMs: 120_000 }, dataDir: dir, runId, onFatal: () => undefined });
    opened.push(a);
    a.store.setKv('k', 'v');
    a.store.setProposedGraph('r', G1);
    await a.store.durable();
    const refused = await openStore({ store: { kind: 'postgres', url, flushDeadlineMs: 120_000 }, dataDir: dir, runId, onFatal: () => undefined }).catch((e: Error) => e);
    expect(refused).toBeInstanceOf(Error);
    expect((refused as Error).message).toContain('locked by another session');
    expect((refused as Error).message).toContain(`schema "${TEST_SCHEMA}"`);
    expect((refused as Error).message).toContain('the run lock is per database');
    expect((refused as Error).message).not.toContain('pw-s3cret');
    await a.close();
    opened.pop();
    const b = await openStore({ store: { kind: 'postgres', url, flushDeadlineMs: 120_000 }, dataDir: dir, runId, onFatal: () => undefined });
    opened.push(b);
    expect(b.store.getKv('k')).toBe('v');
    expect(b.store.getProposedGraph()).toMatchObject({ rev: 'r', content: G1 });
  });

  it('a failed open and a failed load name the schema', async () => {
    // Open: nothing listens on port 1.
    const unreachable = 'postgresql://u:pw-s3cret@127.0.0.1:1/db';
    const notOpened = await openStore({ store: { kind: 'postgres', url: unreachable, flushDeadlineMs: 120_000, schema: 'team_x' }, dataDir: dir, runId: freshRunId('sel'), onFatal: () => undefined }).catch((e: Error) => e);
    expect(notOpened).toBeInstanceOf(StoreOpenError);
    expect((notOpened as Error).message).toMatch(/^could not open the Postgres store at /);
    expect((notOpened as Error).message).toContain('schema "team_x"');
    expect((notOpened as Error).message).not.toContain('pw-s3cret');
    // Load: a row the loader cannot read (an event seq above the safe integer range).
    const runId = freshRunId('sel');
    runs.push(runId);
    const url = await pgUrl();
    const first = await openStore({ store: { kind: 'postgres', url, flushDeadlineMs: 120_000 }, dataDir: dir, runId, onFatal: () => undefined });
    await first.close();
    const admin = await adminClient();
    try {
      await admin.query(`INSERT INTO ${TEST_SCHEMA}.events (run_id, seq, ts, kind) VALUES ($1, 9007199254740993, 1, 'x')`, [runId]);
    } finally {
      await admin.end();
    }
    const notLoaded = await openStore({ store: { kind: 'postgres', url, flushDeadlineMs: 120_000 }, dataDir: dir, runId, onFatal: () => undefined }).catch((e: Error) => e);
    expect(notLoaded).toBeInstanceOf(StoreOpenError);
    expect((notLoaded as Error).message).toMatch(new RegExp(`^could not load run ${runId} from `));
    expect((notLoaded as Error).message).toContain(`schema "${TEST_SCHEMA}"`);
    expect((notLoaded as Error).message).not.toContain('pw-s3cret');
  });

  it('a terminated lock session is fatal at once, with no batch in flight and a deadline far away', async () => {
    const runId = freshRunId('sel');
    runs.push(runId);
    const fatal: FatalInfo[] = [];
    const o = await openStore({ store: { kind: 'postgres', url: await pgUrl(), flushDeadlineMs: 600_000 }, dataDir: dir, runId, onFatal: (i) => fatal.push(i) });
    opened.push(o);
    const admin = await adminClient();
    try {
      await admin.query('SELECT pg_terminate_backend($1)', [o.sink!.backendPid]);
    } finally {
      await admin.end();
    }
    await until(() => fatal.length > 0, 5_000);
    expect(fatal).toMatchObject([{ reason: 'fenced', unflushedBatches: 0 }]);
    expect(o.store.readiness?.()[0]).toContain('the run lock was lost');
  });

  // Stalls the server by stopping its backend process: only on the cluster this run started, never a TEST_DATABASE_URL server (maybe remote, maybe someone else's).
  it.skipIf(pgSource !== 'cluster')('a stalled server is fatal once the flush deadline passes, with the unflushed batch count', async () => {
    const runId = freshRunId('sel');
    runs.push(runId);
    const fatal: FatalInfo[] = [];
    const o = await openStore({ store: { kind: 'postgres', url: await pgUrl(), flushDeadlineMs: 400 }, dataDir: dir, runId, onFatal: (i) => fatal.push(i) });
    opened.push(o);
    const pid = o.sink!.backendPid;
    process.kill(pid, 'SIGSTOP');
    try {
      o.store.setKv('a', '1');
      o.store.setKv('b', '2');
      await until(() => fatal.length > 0, 5_000);
    } finally {
      process.kill(pid, 'SIGCONT');
    }
    expect(fatal).toHaveLength(1);
    expect(fatal[0]).toMatchObject({ reason: 'deadline', unflushedBatches: 2 });
  });

  it('a session lost while closing is not fatal', async () => {
    const runId = freshRunId('sel');
    runs.push(runId);
    const fatal: FatalInfo[] = [];
    const o = await openStore({ store: { kind: 'postgres', url: await pgUrl(), flushDeadlineMs: 60_000 }, dataDir: dir, runId, onFatal: (i) => fatal.push(i) });
    o.store.setKv('a', '1');
    await o.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(fatal).toEqual([]);
    const c = new pg.Client(typeof (await testDatabase()) === 'string' ? { connectionString: (await testDatabase()) as string } : ((await testDatabase()) as pg.ClientConfig));
    await c.connect();
    try {
      expect((await c.query(`SELECT value FROM ${TEST_SCHEMA}.kv WHERE run_id = $1 AND key = 'a'`, [runId])).rows).toEqual([{ value: '1' }]);
    } finally {
      await c.end();
    }
  });
});
