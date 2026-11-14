import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyPgOps, PgSink } from '../../src/state/pg/index.js';
import { canonical } from './backends.js';
import { dropRun, freshRunId, pgAvailable, stopTestPostgres, testDatabase } from './pg-db.js';
import { applyOps, dumpTables, type FatalInfo, FencedError, isRejected, JournaledStore, type JournalSink, RejectedBatchError, type Row, type RowOp, SqliteSink } from '../../src/state/journal.js';
import { SqliteStore } from '../../src/state/sqlite.js';
import { defaultEntry } from '../../src/state/status.js';
import type { Launch } from '../../src/state/store.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'orch-journal-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function until(pred: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise((r) => setTimeout(r, 2));
  }
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The durable copy a randomized run drives: SQLite or Postgres. */
interface FuzzSink {
  apply(ops: readonly RowOp[]): Promise<void>;
  /** Write the first `n` ops inside the sink's transaction, then fail and roll back. */
  failPartway(ops: readonly RowOp[], n: number): Promise<never>;
  /** The sink's tables, comparable with `canon(dumpTables(image))`. */
  tables(): Promise<unknown>;
  canon(t: Record<string, Row[]>): unknown;
  loadInto(image: SqliteStore): Promise<void>;
  close(): Promise<void>;
}

const sqliteFuzzSink = (file: string): FuzzSink => {
  const sink = new SqliteSink(file);
  return {
    apply: (ops) => sink.applyBatch(ops),
    failPartway: async (ops, n) => {
      sink.db.exec('BEGIN');
      try {
        applyOps(sink.db, ops.slice(0, n));
        throw new Error('sink unavailable');
      } finally {
        sink.db.exec('ROLLBACK');
      }
    },
    tables: async () => sink.tables(),
    canon: (t) => t,
    loadInto: async (image) => sink.loadInto(image),
    close: async () => sink.close(),
  };
};

const pgFuzzSink = async (): Promise<FuzzSink> => {
  const sink = await PgSink.open({ connection: await testDatabase(), runId: freshRunId('fuzz') });
  return {
    apply: (ops) => sink.applyBatch(ops),
    failPartway: async (ops, n) => {
      await sink.client.query('BEGIN');
      try {
        await applyPgOps(sink.client, sink.runId, ops.slice(0, n));
        throw new Error('sink unavailable');
      } finally {
        await sink.client.query('ROLLBACK');
      }
    },
    tables: async () => canonical(await sink.tables()),
    canon: canonical,
    loadInto: (image) => sink.loadInto(image),
    close: async () => {
      await sink.close();
      await dropRun(sink.runId);
    },
  };
};

/** A sink that fails some applies, some of them after writing part of the batch, and remembers the last batch it accepted. */
class FlakySink implements JournalSink {
  failRate = 0;
  lastApplied: RowOp[] | undefined;
  accepted = 0;
  constructor(
    readonly inner: FuzzSink,
    private readonly rand: () => number,
  ) {}
  async applyBatch(ops: readonly RowOp[]): Promise<void> {
    // Partial: some rows reach the sink's transaction before it fails, and roll back with it.
    if (this.rand() < this.failRate) await this.inner.failPartway(ops, Math.floor(this.rand() * ops.length));
    await this.inner.apply(ops);
    this.lastApplied = [...ops];
    this.accepted++;
  }
}

const UNSTORABLE = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Every string in a value, object keys included. */
function allStrings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) allStrings(x, out);
  else if (v && typeof v === 'object')
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      allStrings(x, out);
    }
  return out;
}

const launch = (id: string, n: number): Launch => ({ launchId: id, taskId: `T${n % 4}`, attempt: 1, launchNo: n, status: 'preparing', token: `tok-${id}`, branch: 'b', worktree: 'w', baseSha: 's', graphRev: 'r', createdAt: n % 3 });

async function runFuzz(seed: number, steps: number, sinkDb: FuzzSink): Promise<{ batches: number; crashes: number; flushes: number }> {
  const rand = mulberry32(seed);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const sink = new FlakySink(sinkDb, rand);
  let image = new SqliteStore(':memory:');
  let store = new JournaledStore(image, sink, { autoFlush: false });
  /** Image tables at each committed, not yet flushed batch boundary, oldest first. */
  let expected: Array<Record<string, Row[]>> = [];
  let lastFlushed = dumpTables(image.database());
  let launchNo = 0;
  let batches = 0;
  let crashes = 0;
  let flushes = 0;

  // Strings Postgres cannot store as they are: NUL, lone surrogates of both halves, a pair cut at either end. See specs/state-backend "Storable values".
  const nasty = (): string => {
    const parts = ['ok', '\u0000', '\uD83D', '\uDE00', '😀', 'é', '\\u0000', 'x'];
    let s = '';
    for (let i = Math.floor(rand() * 5); i > 0; i--) s += pick(parts);
    return s;
  };

  const write = () => {
    const k = rand();
    if (k < 0.12) store.setEntry(`T${Math.floor(rand() * 6)}`, { ...defaultEntry(), launches: Math.floor(rand() * 5), ...(rand() < 0.3 ? { carry: [{ kind: 'checkFailed', output: nasty() }] } : {}) } as never);
    else if (k < 0.26) store.appendEvent({ kind: pick(['a', 'b', 'transition']), taskId: `T${Math.floor(rand() * 4)}`, payload: { n: Math.floor(rand() * 100), s: nasty(), [nasty()]: [nasty()] } }, Math.floor(rand() * 1000));
    else if (k < 0.38) store.insertOutbox({ sourceSeq: Math.floor(rand() * 10), taskId: `T${Math.floor(rand() * 3)}`, kind: pick(['setState', 'comment'] as const), payload: { state: 'x' }, createdAt: 1 });
    else if (k < 0.44) store.ackOutbox(1 + Math.floor(rand() * 20), { ok: true }, 5);
    else if (k < 0.5) store.nackOutbox(1 + Math.floor(rand() * 20), `no${nasty()}`, 3);
    else if (k < 0.58) store.setKv(`k${Math.floor(rand() * 5)}`, `${rand()}${nasty()}`);
    else if (k < 0.64) store.putAttachment({ id: `a${Math.floor(rand() * 3)}`, pids: [1, 2], since: 1 });
    else if (k < 0.69) store.deleteAttachment(`a${Math.floor(rand() * 3)}`);
    // A duplicate launch id is a failing statement.
    else if (k < 0.78) store.createLaunch(launch(`L${rand() < 0.3 ? Math.floor(rand() * Math.max(1, launchNo)) : launchNo++}`, launchNo));
    // A missing launch throws.
    else if (k < 0.86) store.updateLaunch(`L${Math.floor(rand() * (launchNo + 2))}`, { status: pick(['live', 'ended'] as const), pid: Math.floor(rand() * 100) });
    else if (k < 0.92) store.putDedup(`L${Math.floor(rand() * 3)}`, Math.floor(rand() * 3), { r: rand(), text: nasty() });
    else if (k < 0.96) store.setSnapshot(`rev${Math.floor(rand() * 3)}`, `nodes: [] # ${nasty()}`);
    else store.putReport({ launchId: `L${Math.floor(rand() * 4)}`, taskId: 'T1', kind: 'submit', body: { s: rand(), summary: nasty() }, createdAt: Math.floor(rand() * 10) });
  };

  const level = (depth: number) => {
    const n = 1 + Math.floor(rand() * 4);
    for (let i = 0; i < n; i++) {
      try {
        if (depth < 3 && rand() < 0.3) store.transaction(() => level(depth + 1));
        else write();
      } catch {
        /* a failing statement or a rolled-back level: the caller continues */
      }
    }
    // Roll back at any level.
    if (rand() < 0.2) throw new Error(`rollback at depth ${depth}`);
  };

  for (let step = 0; step < steps; step++) {
    const before = store.durability().pendingBatches;
    const r = rand();
    if (r < 0.55) {
      try {
        if (rand() < 0.6) store.transaction(() => level(1));
        else write();
      } catch {
        /* top-level rollback or failing bare write */
      }
      const after = store.durability().pendingBatches;
      expect(after - before).toBeLessThanOrEqual(1);
      if (after > before) {
        expected.push(dumpTables(image.database()));
        batches++;
      }
    } else if (r < 0.9) {
      sink.failRate = rand() < 0.3 ? 0.6 : 0;
      const accepted = sink.accepted;
      // Pump by hand: the flusher's attempt without its timer.
      await store.flushOnce();
      if (sink.accepted > accepted) {
        flushes++;
        lastFlushed = expected.shift()!;
        expect(await sinkDb.tables()).toEqual(sinkDb.canon(lastFlushed));
        expect(store.durability().pendingBatches).toBe(expected.length);
        // Applying an already-applied batch again changes nothing.
        if (rand() < 0.3) {
          await sinkDb.apply(sink.lastApplied!);
          expect(await sinkDb.tables()).toEqual(sinkDb.canon(lastFlushed));
        }
      } else {
        expect(await sinkDb.tables()).toEqual(sinkDb.canon(lastFlushed));
      }
    } else if (r < 0.95) {
      // Crash: the unflushed batches are lost; a fresh image loads from the sink.
      store.close();
      image = new SqliteStore(':memory:');
      await sinkDb.loadInto(image);
      expect(sinkDb.canon(dumpTables(image.database()))).toEqual(sinkDb.canon(lastFlushed));
      store = new JournaledStore(image, sink, { autoFlush: false });
      expected = [];
      crashes++;
    }
  }
  // Drain what is pending: a fresh image loaded from the sink equals the running image, row for row.
  sink.failRate = 0;
  while (await store.flushOnce()) flushes++;
  expect(store.durability().pendingBatches).toBe(0);
  const fresh = new SqliteStore(':memory:');
  await sinkDb.loadInto(fresh);
  expect(sinkDb.canon(dumpTables(fresh.database()))).toEqual(sinkDb.canon(dumpTables(image.database())));
  fresh.close();
  // No row holds a string Postgres refuses; the replacement character is there in their place.
  const strings = allStrings(canonical(dumpTables(image.database())));
  expect(strings.filter((s) => UNSTORABLE.test(s))).toEqual([]);
  expect(strings.some((s) => s.includes('�'))).toBe(true);
  store.close();
  await sinkDb.close();
  return { batches, crashes, flushes };
}

describe('journal', () => {
  it('a seeded randomized run: the sink equals the image at each flushed batch boundary, and a reloaded image equals the last flushed state', async () => {
    let totals = { batches: 0, crashes: 0, flushes: 0 };
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const r = await runFuzz(seed, 1500, sqliteFuzzSink(path.join(dir, `sink-${seed}.sqlite`)));
      totals = { batches: totals.batches + r.batches, crashes: totals.crashes + r.crashes, flushes: totals.flushes + r.flushes };
    }
    // The run exercised what it claims to.
    expect(totals.batches).toBeGreaterThan(1000);
    expect(totals.flushes).toBeGreaterThan(500);
    expect(totals.crashes).toBeGreaterThan(50);
  }, 60_000);

  it('applying an already-applied batch a second time leaves the sink unchanged', async () => {
    const sink = new SqliteSink(path.join(dir, 'sink.sqlite'));
    const recorded: RowOp[][] = [];
    const store = new JournaledStore(new SqliteStore(':memory:'), { applyBatch: async (ops) => (recorded.push([...ops]), sink.applyBatch(ops)) });
    store.transaction(() => {
      store.createLaunch(launch('L1', 1));
      store.appendEvent({ kind: 'x' }, 1);
      store.insertOutbox({ sourceSeq: 1, taskId: 'T1', kind: 'setState', payload: {}, createdAt: 1 });
      store.putAttachment({ id: 'a', pids: [1], since: 1 });
    });
    store.transaction(() => {
      store.updateLaunch('L1', { status: 'live' });
      store.deleteAttachment('a');
      store.ackOutbox(1, {}, 2);
    });
    await store.durable();
    const before = sink.tables();
    for (const ops of recorded) await sink.applyBatch(ops);
    expect(sink.tables()).toEqual(before);
    await sink.applyBatch(recorded[1]!);
    expect(sink.tables()).toEqual(before);
    expect(before['launches']).toHaveLength(1);
    expect(before['kv']).toEqual([]);
    store.close();
    sink.close();
  });

  it('one top-level transaction is one batch of row operations carrying the resulting rows; a rolled-back level contributes nothing', async () => {
    const batches: RowOp[][] = [];
    const store = new JournaledStore(new SqliteStore(':memory:'), { applyBatch: async (ops) => void batches.push([...ops]) });
    store.transaction(() => {
      store.setKv('a', '1');
      try {
        store.transaction(() => {
          store.setKv('b', '1');
          throw new Error('inner');
        });
      } catch {
        /* inner level discarded */
      }
      store.transaction(() => store.setKv('c', '1'));
      store.setKv('a', '2');
    });
    expect(() => store.transaction(() => (store.setKv('d', '1'), (() => { throw new Error('outer'); })()))).toThrow('outer');
    store.setKv('e', '1');
    await store.durable();
    expect(batches).toEqual([
      [
        { op: 'upsert', table: 'kv', row: { key: 'a', value: '2' } },
        { op: 'upsert', table: 'kv', row: { key: 'c', value: '1' } },
      ],
      [{ op: 'upsert', table: 'kv', row: { key: 'e', value: '1' } }],
    ]);
    store.close();
  });

  it('a sink that fails past flushDeadlineMs calls onFatal exactly once with the unflushed batch count', async () => {
    const fatal: FatalInfo[] = [];
    const now = { value: 1_000 };
    let attempts = 0;
    const store = new JournaledStore(
      new SqliteStore(':memory:'),
      { applyBatch: async () => (attempts++, Promise.reject(new Error('down'))) },
      { flushDeadlineMs: 60_000, retryBaseMs: 2, retryMaxMs: 5, clock: () => now.value, onFatal: (f) => fatal.push(f) },
    );
    store.setKv('a', '1');
    store.setKv('b', '1');
    store.transaction(() => store.setKv('c', '1'));
    let resolved = false;
    void store.durable().then(() => (resolved = true));
    // Within the deadline the flusher keeps retrying and nothing is fatal.
    await until(() => attempts >= 5);
    now.value += 30_000;
    expect(fatal).toEqual([]);
    expect(store.durability()).toMatchObject({ pendingBatches: 3, lagMs: 30_000 });
    // Past it, the next failed retry is fatal, once.
    now.value += 30_001;
    await until(() => fatal.length > 0);
    expect(fatal).toEqual([expect.objectContaining({ reason: 'deadline', unflushedBatches: 3 })]);
    const after = attempts;
    await new Promise((r) => setTimeout(r, 30));
    expect(fatal).toHaveLength(1);
    expect(attempts).toBe(after);
    expect(resolved).toBe(false);
    store.close();
  });

  it('a sink that stalls past flushDeadlineMs calls onFatal once', async () => {
    const fatal: FatalInfo[] = [];
    const store = new JournaledStore(new SqliteStore(':memory:'), { applyBatch: () => new Promise<void>(() => undefined) }, { flushDeadlineMs: 50, onFatal: (f) => fatal.push(f) });
    store.setKv('a', '1');
    await until(() => fatal.length > 0);
    expect(fatal).toEqual([expect.objectContaining({ reason: 'deadline', unflushedBatches: 1 })]);
    await new Promise((r) => setTimeout(r, 80));
    expect(fatal).toHaveLength(1);
    store.close();
  });

  it('the flusher retries a failed batch and then applies every batch in commit order', async () => {
    const fatal: FatalInfo[] = [];
    const sink = new SqliteSink(path.join(dir, 'sink.sqlite'));
    const applied: RowOp[][] = [];
    let failures = 0;
    const store = new JournaledStore(
      new SqliteStore(':memory:'),
      {
        applyBatch: async (ops) => {
          if (failures < 2) {
            failures++;
            throw new Error('transient');
          }
          await sink.applyBatch(ops);
          applied.push([...ops]);
        },
      },
      { retryBaseMs: 2, retryMaxMs: 5, onFatal: (f) => fatal.push(f) },
    );
    store.setKv('a', '1');
    store.transaction(() => (store.createLaunch(launch('L1', 1)), store.appendEvent({ kind: 'x' }, 1)));
    store.setKv('a', '2');
    await store.durable();
    expect(failures).toBe(2);
    expect(fatal).toEqual([]);
    expect(applied.map((ops) => ops.map((o) => o.table))).toEqual([['kv'], ['launches', 'events'], ['kv']]);
    expect(sink.tables()).toEqual(dumpTables(store.image.database()));
    expect(store.durability()).toMatchObject({ lagMs: 0, pendingBatches: 0, eventSeq: 1 });
    store.close();
    sink.close();
  });

  it('a sink that reports fenced calls onFatal immediately, once', async () => {
    const fatal: FatalInfo[] = [];
    const store = new JournaledStore(new SqliteStore(':memory:'), { applyBatch: async () => Promise.reject(new FencedError()) }, { flushDeadlineMs: 60_000, onFatal: (f) => fatal.push(f) });
    store.setKv('a', '1');
    await new Promise((r) => setImmediate(r));
    expect(fatal).toEqual([expect.objectContaining({ reason: 'fenced', unflushedBatches: 1 })]);
    store.setKv('b', '1');
    await new Promise((r) => setTimeout(r, 20));
    expect(fatal).toHaveLength(1);
    store.close();
  });

  it('durability reports the highest event and outbox ids known durable, and ids keep increasing after a reload', async () => {
    let release!: () => void;
    let gate = new Promise<void>((r) => (release = r));
    const sink = new SqliteSink(path.join(dir, 'sink.sqlite'));
    const store = new JournaledStore(new SqliteStore(':memory:'), { applyBatch: async (ops) => (await gate, sink.applyBatch(ops)) });
    const s1 = store.appendEvent({ kind: 'x' }, 1);
    const o1 = store.insertOutbox({ sourceSeq: s1, taskId: 'T1', kind: 'setState', payload: {}, createdAt: 1 })!;
    expect(store.durability()).toMatchObject({ eventSeq: 0, outboxId: 0, pendingBatches: 2 });
    release();
    await store.durable();
    expect(store.durability()).toEqual({ lagMs: 0, pendingBatches: 0, eventSeq: s1, outboxId: o1 });
    gate = new Promise<void>((r) => (release = r));
    store.appendEvent({ kind: 'y' }, 2);
    expect(store.durability()).toMatchObject({ eventSeq: s1, pendingBatches: 1 });
    // Crash before the flush: a reloaded image issues the unflushed sequence number again.
    store.close();
    const image = new SqliteStore(':memory:');
    sink.loadInto(image);
    const again = new JournaledStore(image, sink);
    expect(again.durability()).toMatchObject({ eventSeq: s1, outboxId: o1 });
    expect(again.appendEvent({ kind: 'z' }, 3)).toBe(s1 + 1);
    expect(again.insertOutbox({ sourceSeq: s1 + 1, taskId: 'T1', kind: 'setState', payload: {}, createdAt: 1 })!).toBeGreaterThan(o1);
    await again.durable();
    again.close();
    sink.close();
  });
});

describe.skipIf(!pgAvailable)('journal over PgSink', () => {
  afterAll(() => stopTestPostgres());

  it('the same seeded randomized run against Postgres: the sink equals the image at each flushed batch boundary, and a reloaded image equals the last flushed state', async () => {
    let totals = { batches: 0, crashes: 0, flushes: 0 };
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const r = await runFuzz(seed, 1500, await pgFuzzSink());
      totals = { batches: totals.batches + r.batches, crashes: totals.crashes + r.crashes, flushes: totals.flushes + r.flushes };
    }
    expect(totals.batches).toBeGreaterThan(1000);
    expect(totals.flushes).toBeGreaterThan(500);
    expect(totals.crashes).toBeGreaterThan(50);
  }, 180_000);

  it('a batch Postgres rejects with a data error calls onFatal once, at once, with reason rejected, the table, the key and the SQLSTATE', async () => {
    const sink = await PgSink.open({ connection: await testDatabase(), runId: freshRunId('rejected') });
    const fatal: Array<{ info: FatalInfo; at: number }> = [];
    const image = new SqliteStore(':memory:');
    // The deadline is ten minutes away: only the rejection can stop the journal within this test.
    const store = new JournaledStore(image, sink, { flushDeadlineMs: 600_000, retryBaseMs: 2, retryMaxMs: 5, onFatal: (info) => fatal.push({ info, at: Date.now() }) });
    try {
      store.setKv('before', '1');
      await store.durable();
      const started = Date.now();
      // Past the storable-value boundary on purpose: a row written straight into the image, as a bug would.
      let seq = 0;
      store.transaction(() => {
        image.database().prepare('INSERT INTO events (ts, kind, payload) VALUES (?, ?, ?)').run(1, 'secret-kind', '{"text":"tok-SECRET\\u0000"}');
        seq = image.latestEventSeq();
      });
      store.setKv('after', '1');
      await until(() => fatal.length > 0, 5_000);
      await new Promise((r) => setTimeout(r, 50));
      expect(fatal).toHaveLength(1);
      const { info, at } = fatal[0]!;
      expect(at - started).toBeLessThan(2_000);
      expect(info).toMatchObject({ reason: 'rejected', table: 'events', key: { seq }, sqlstate: '22P05', unflushedBatches: 2 });
      const message = String(info.error);
      expect(message).toMatch(/table events/);
      expect(message).toMatch(new RegExp(`"seq":${seq}`));
      expect(message).toMatch(/SQLSTATE 22P05/);
      // No row contents in what the daemon logs.
      expect(message).not.toMatch(/SECRET|secret-kind|unsupported Unicode/);
      expect(store.readiness()).toEqual([expect.stringMatching(/rejected a batch.*table events/)]);
      // Nothing of the refused batch reached Postgres; the earlier one did.
      const rows = await sink.tables();
      expect(rows['events']).toEqual([]);
      expect(rows['kv']!.map((r) => r['key'])).toEqual(['before']);
    } finally {
      store.close();
      await sink.close();
      await dropRun(sink.runId);
    }
  });

  // What Postgres refuses as the boundary would otherwise let through, sent to the sink directly; each is a rejected batch with its SQLSTATE.
  const refused: Array<{ what: string; op: RowOp; key: Record<string, unknown>; sqlstate: RegExp }> = [
    { what: 'a NUL escape in jsonb', op: { op: 'upsert', table: 'overlay', row: { id: 'T1', entry: '{"o":"a\\u0000"}' } }, key: { id: 'T1' }, sqlstate: /^22P05$/ },
    { what: 'a lone surrogate escape in jsonb', op: { op: 'upsert', table: 'overlay', row: { id: 'T1', entry: '{"o":"\\ud800"}' } }, key: { id: 'T1' }, sqlstate: /^22P02$/ },
    { what: 'a NUL character in text', op: { op: 'upsert', table: 'kv', row: { key: 'k', value: 'a\u0000b' } }, key: { key: 'k' }, sqlstate: /^22021$/ },
    { what: '1.5 in bigint', op: { op: 'upsert', table: 'dedup', row: { launch_id: 'L1', seq: 1.5, response: 'null' } }, key: { launch_id: 'L1', seq: 1.5 }, sqlstate: /^22P02$/ },
    { what: '1e30 in bigint', op: { op: 'upsert', table: 'dedup', row: { launch_id: 'L1', seq: 1e30, response: 'null' } }, key: { launch_id: 'L1', seq: 1e30 }, sqlstate: /^22(P02|003)$/ },
  ];
  for (const r of refused) {
    it(`Postgres refuses ${r.what}: a rejected batch with SQLSTATE ${r.sqlstate.source}, and the sink still writes`, async () => {
      const sink = await PgSink.open({ connection: await testDatabase(), runId: freshRunId('refused') });
      try {
        const err = await sink.applyBatch([r.op]).then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(isRejected(err)).toBe(true);
        expect((err as RejectedBatchError).refusal).toMatchObject({ table: r.op.table, key: r.key });
        expect((err as RejectedBatchError).refusal.sqlstate).toMatch(r.sqlstate);
        await sink.applyBatch([{ op: 'upsert', table: 'kv', row: { key: 'ok', value: '1' } }]);
        expect(sink.fenced).toBe(false);
      } finally {
        await sink.close();
        await dropRun(sink.runId);
      }
    });
  }

  it('a batch Postgres refuses for a non-integer in a bigint column is rejected at once with SQLSTATE 22P02', async () => {
    const sink = await PgSink.open({ connection: await testDatabase(), runId: freshRunId('rejected-int') });
    const fatal: FatalInfo[] = [];
    const image = new SqliteStore(':memory:');
    const store = new JournaledStore(image, sink, { flushDeadlineMs: 600_000, onFatal: (f) => fatal.push(f) });
    try {
      store.transaction(() => image.database().prepare('INSERT INTO dedup (launch_id, seq, response) VALUES (?, ?, ?)').run('L1', 1.5, 'null'));
      await until(() => fatal.length > 0, 5_000);
      expect(fatal).toEqual([expect.objectContaining({ reason: 'rejected', table: 'dedup', key: { launch_id: 'L1', seq: 1.5 }, sqlstate: '22P02' })]);
    } finally {
      store.close();
      await sink.close();
      await dropRun(sink.runId);
    }
  });
});

describe('rejected batches', () => {
  it('a sink that rejects a batch for its content calls onFatal once, at once, with reason rejected, well before flushDeadlineMs', async () => {
    const fatal: FatalInfo[] = [];
    let applies = 0;
    const sink: JournalSink = {
      applyBatch: async () => {
        applies++;
        throw new RejectedBatchError({ table: 'events', key: { seq: 1 }, sqlstate: '22P05' });
      },
    };
    const store = new JournaledStore(new SqliteStore(':memory:'), sink, { flushDeadlineMs: 600_000, retryBaseMs: 2, retryMaxMs: 5, onFatal: (f) => fatal.push(f) });
    store.appendEvent({ kind: 'x' }, 1);
    store.setKv('b', '1');
    await until(() => fatal.length > 0, 1_000);
    await new Promise((r) => setTimeout(r, 30));
    expect(applies).toBe(1);
    expect(fatal).toEqual([expect.objectContaining({ reason: 'rejected', table: 'events', key: { seq: 1 }, sqlstate: '22P05', unflushedBatches: 2 })]);
    expect(String(fatal[0]!.error)).toBe('RejectedBatchError: batch rejected by the sink: table events, key {"seq":1}, SQLSTATE 22P05');
    store.close();
  });

  it('a sink error that is not a rejection still retries until it lands', async () => {
    const fatal: FatalInfo[] = [];
    let fails = 3;
    const inner = new SqliteSink(path.join(dir, 'sink.sqlite'));
    const sink: JournalSink = { applyBatch: async (ops) => (fails-- > 0 ? Promise.reject(Object.assign(new Error('could not serialize'), { code: '40001' })) : inner.applyBatch(ops)) };
    const store = new JournaledStore(new SqliteStore(':memory:'), sink, { flushDeadlineMs: 600_000, retryBaseMs: 2, retryMaxMs: 5, onFatal: (f) => fatal.push(f) });
    store.setKv('a', '1');
    await store.durable();
    expect(fatal).toEqual([]);
    expect(inner.tables()['kv']).toHaveLength(1);
    store.close();
    inner.close();
  });
});
