/**
 * The store backends the parametrized store suites run against: a plain SqliteStore, a
 * JournaledStore over an in-memory image and a SQLite sink, and a JournaledStore over a Postgres
 * sink (skipped when the tests have no Postgres, see pg-db.ts). After every journaled test the
 * sink must equal the image row for row; for Postgres, a fresh image loaded from it must too.
 */
import path from 'node:path';
import { expect } from 'vitest';
import { dumpTables, JournaledStore, type Row, SqliteSink } from '../../src/state/journal.js';
import { JSON_COLUMNS, PgSink } from '../../src/state/pg/index.js';
import { SqliteStore } from '../../src/state/sqlite.js';
import type { Store } from '../../src/state/store.js';
import { dropRun, freshRunId, pgAvailable, stopTestPostgres, testDatabase } from './pg-db.js';

export interface Backend {
  name: string;
  /** False when the backend cannot run here (no Postgres): its suites are skipped. */
  available: boolean;
  /** Open the store kept in `dir`: for a journal, a fresh image loaded from the sink. */
  open(dir: string): Promise<Store>;
  /** Close and open again, as a daemon restart does. */
  reopen(store: Store, dir: string): Promise<Store>;
  /** After a test: the durable copy equals the image. */
  check(store: Store): Promise<void>;
  /** Release anything `open` kept (the sinks). */
  release(): Promise<void>;
  /** After the file: stop what the backend started (the test cluster). */
  shutdown(): Promise<void>;
}

/**
 * Tables with every JSON document parsed, for comparing an image with Postgres: JSONB keeps the
 * document, not its text (it reorders keys), so documents compare as values.
 */
export function canonical(tables: Record<string, Row[]>): Record<string, Array<Record<string, unknown>>> {
  const out: Record<string, Array<Record<string, unknown>>> = {};
  for (const [t, rows] of Object.entries(tables)) {
    const json = JSON_COLUMNS[t] ?? [];
    out[t] = rows.map((r) => {
      const row: Record<string, unknown> = { ...r };
      for (const c of json) if (typeof row[c] === 'string') row[c] = JSON.parse(row[c] as string);
      return row;
    });
  }
  return out;
}

export const sqliteBackend: Backend = {
  name: 'SqliteStore',
  available: true,
  open: async (dir) => new SqliteStore(path.join(dir, 's.sqlite')),
  reopen: async (store, dir) => {
    store.close();
    return new SqliteStore(path.join(dir, 's.sqlite'));
  },
  check: async () => undefined,
  release: async () => undefined,
  shutdown: async () => undefined,
};

const sinks = new Map<string, SqliteSink>();

function sinkFor(dir: string): SqliteSink {
  let sink = sinks.get(dir);
  if (!sink) {
    sink = new SqliteSink(path.join(dir, 'sink.sqlite'));
    sinks.set(dir, sink);
  }
  return sink;
}

export const journaledBackend: Backend = {
  name: 'JournaledStore',
  available: true,
  open: async (dir) => {
    const sink = sinkFor(dir);
    const image = new SqliteStore(':memory:');
    sink.loadInto(image);
    return new JournaledStore(image, sink);
  },
  reopen: async (store, dir) => {
    await store.durable();
    store.close();
    return journaledBackend.open(dir);
  },
  check: async (store) => {
    const j = store as JournaledStore;
    await j.durable();
    expect(j.durability().pendingBatches).toBe(0);
    expect(j.fatalReason()).toBeUndefined();
    expect((j.sink as SqliteSink).tables()).toEqual(dumpTables(j.image.database()));
  },
  release: async () => {
    for (const s of sinks.values()) s.close();
    sinks.clear();
  },
  shutdown: async () => undefined,
};

/** One Postgres sink (one run id, one locked session) per test directory. */
const pgSinks = new Map<string, PgSink>();

async function pgSinkFor(dir: string): Promise<PgSink> {
  let sink = pgSinks.get(dir);
  if (!sink) {
    sink = await PgSink.open({ connection: await testDatabase(), runId: freshRunId('suite') });
    pgSinks.set(dir, sink);
  }
  return sink;
}

/** The image a fresh load from Postgres builds equals the running image, row for row. */
export async function expectReloadEquals(sink: PgSink, image: SqliteStore): Promise<void> {
  const running = canonical(dumpTables(image.database()));
  expect(canonical(await sink.tables())).toEqual(running);
  const fresh = await sink.loadImage();
  try {
    expect(canonical(dumpTables(fresh.database()))).toEqual(running);
  } finally {
    fresh.close();
  }
}

export const pgBackend: Backend = {
  name: 'JournaledStore over PgSink',
  available: pgAvailable,
  open: async (dir) => {
    const sink = await pgSinkFor(dir);
    return new JournaledStore(await sink.loadImage(), sink);
  },
  reopen: async (store, dir) => {
    await store.durable();
    store.close();
    return pgBackend.open(dir);
  },
  check: async (store) => {
    const j = store as JournaledStore;
    await j.durable();
    expect(j.durability().pendingBatches).toBe(0);
    expect(j.fatalReason()).toBeUndefined();
    await expectReloadEquals(j.sink as PgSink, j.image);
  },
  release: async () => {
    const all = [...pgSinks.values()];
    pgSinks.clear();
    for (const s of all) {
      await s.close();
      await dropRun(s.runId);
    }
  },
  shutdown: stopTestPostgres,
};

export const backends: Backend[] = [sqliteBackend, journaledBackend, pgBackend];
