/**
 * The store backends the parametrized store suites run against: a plain SqliteStore, and a
 * JournaledStore over an in-memory image and a SQLite sink. After every journaled test the sink's
 * tables must equal the image's, row for row.
 */
import path from 'node:path';
import { expect } from 'vitest';
import { dumpTables, JournaledStore, SqliteSink } from '../../src/state/journal.js';
import { SqliteStore } from '../../src/state/sqlite.js';
import type { Store } from '../../src/state/store.js';

export interface Backend {
  name: string;
  /** Open the store kept in `dir`: for the journal, a fresh image loaded from the sink. */
  open(dir: string): Store;
  /** Close and open again, as a daemon restart does. */
  reopen(store: Store, dir: string): Promise<Store>;
  /** After a test: the durable copy equals the image. */
  check(store: Store): Promise<void>;
  /** Release anything `open` kept (the sinks). */
  release(): void;
}

export const sqliteBackend: Backend = {
  name: 'SqliteStore',
  open: (dir) => new SqliteStore(path.join(dir, 's.sqlite')),
  reopen: async (store, dir) => {
    store.close();
    return new SqliteStore(path.join(dir, 's.sqlite'));
  },
  check: async () => undefined,
  release: () => undefined,
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
  open: (dir) => {
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
  release: () => {
    for (const s of sinks.values()) s.close();
    sinks.clear();
  },
};

export const backends: Backend[] = [sqliteBackend, journaledBackend];
