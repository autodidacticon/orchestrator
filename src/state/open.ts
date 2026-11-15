/**
 * Store selection: open the run's store by `store.kind`. `sqlite` is the file store under the data directory;
 * `postgres` takes the run lock, loads the memory image for the run, and journals it to the database.
 * See specs/state-backend "Store selection".
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { type Config, redactUrl } from '../config.js';
import { type FatalInfo, JournaledStore, type JournalOptions, type ShutdownRejection } from './journal.js';
import { PgSink, RunLockedError } from './pg/sink.js';
import { SqliteStore } from './sqlite.js';
import type { Store } from './store.js';

export const SQLITE_FILE = 'store.sqlite';

export interface OpenedStore {
  store: Store;
  kind: Config['store']['kind'];
  /** The Postgres sink, under `postgres`. */
  sink?: PgSink;
  /**
   * Wait (up to `timeoutMs`) for committed batches to reach the sink, then close the image and the sink. Resolves
   * with the committed batches that never reached the sink (always 0 under `sqlite`).
   */
  close(timeoutMs?: number): Promise<CloseOutcome>;
}

export interface CloseOutcome {
  /** Committed batches dropped by the close: their records are lost. Non-zero means the daemon exits non-zero. */
  unflushedBatches: number;
  /** A batch the sink rejected for its content while the store closed, with its cause (also logged by the journal). */
  rejected?: ShutdownRejection;
}

/** How long a close waits for the apply in flight to settle once the sink is closed under it. */
const SETTLE_MS = 1_000;

export interface OpenStoreOptions {
  store: Config['store'];
  dataDir: string;
  /** The run the lock and the rows are keyed by. */
  runId: string;
  /** The journal's fatal condition (deadline, the run lock lost, or a batch rejected for its content), called once. The daemon logs it and exits. */
  onFatal: (info: FatalInfo) => void;
  /** Where the journal reports a batch the sink rejects after the shutdown stopped the flusher. */
  log?: JournalOptions['log'];
  /** Journal retry tuning, for tests. */
  retryBaseMs?: number;
  retryMaxMs?: number;
}

/** A clear error for a refused Postgres open, never carrying the password. */
export class StoreOpenError extends Error {
  constructor(message: string, readonly code: 'runLocked' | 'noUrl' | 'connect') {
    super(message);
    this.name = 'StoreOpenError';
  }
}

export async function openStore(opts: OpenStoreOptions): Promise<OpenedStore> {
  if (opts.store.kind === 'sqlite') {
    const store = new SqliteStore(path.join(opts.dataDir, SQLITE_FILE));
    return {
      store,
      kind: 'sqlite',
      close: async () => {
        store.close();
        return { unflushedBatches: 0 };
      },
    };
  }
  const url = opts.store.url;
  if (!url) throw new StoreOpenError('store.kind is postgres but no database URL is set: set store.url, store.urlFile, DATABASE_URL_FILE or DATABASE_URL', 'noUrl');
  let sink: PgSink;
  try {
    sink = await PgSink.open({ connection: url, runId: opts.runId });
  } catch (err) {
    if (err instanceof RunLockedError) throw new StoreOpenError(`${err.message} (database ${redactUrl(url)})`, 'runLocked');
    throw new StoreOpenError(`could not open the Postgres store at ${redactUrl(url)}: ${err instanceof Error ? err.message : String(err)}`, 'connect');
  }
  let journal: JournaledStore | undefined;
  let lostEarly: unknown;
  sink.onLost((err) => {
    if (journal) journal.fence(err);
    else lostEarly = err ?? new Error('connection ended');
  });
  let image: SqliteStore;
  try {
    image = await sink.loadImage();
  } catch (err) {
    await sink.close();
    throw new StoreOpenError(`could not load run ${opts.runId} from ${redactUrl(url)}: ${err instanceof Error ? err.message : String(err)}`, 'connect');
  }
  journal = new JournaledStore(image, sink, {
    flushDeadlineMs: opts.store.flushDeadlineMs,
    onFatal: opts.onFatal,
    ...(opts.log ? { log: opts.log } : {}),
    ...(opts.retryBaseMs !== undefined ? { retryBaseMs: opts.retryBaseMs } : {}),
    ...(opts.retryMaxMs !== undefined ? { retryMaxMs: opts.retryMaxMs } : {}),
  });
  if (lostEarly !== undefined) journal.fence(lostEarly);
  const j = journal;
  return {
    store: j,
    kind: 'postgres',
    sink,
    close: (timeoutMs = 5_000) => closeJournaled(j, () => sink.close(), timeoutMs),
  };
}

/**
 * Wait up to `timeoutMs` for committed batches to reach the sink, then stop the flusher, close the image and the
 * sink, and return the batches that never reached it. Stopping the flusher first keeps the sink's own close from
 * being reported as a lost run lock. See specs/state-backend "Shutdown with unflushed batches".
 */
export async function closeJournaled(j: JournaledStore, closeSink: () => Promise<void>, timeoutMs: number): Promise<CloseOutcome> {
  if (!j.fatalReason()) {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([j.durable(), new Promise<void>((r) => (timer = setTimeout(r, timeoutMs)))]);
    if (timer) clearTimeout(timer);
  }
  const unflushedBatches = j.abandon();
  j.close();
  await closeSink();
  // An apply still in flight settles once the sink is closed under it; a rejection it reports is logged before the
  // caller exits. Bounded, so a sink that never answers does not hold the exit.
  if (unflushedBatches > 0) {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([j.settled(), new Promise<void>((r) => (timer = setTimeout(r, SETTLE_MS)))]);
    if (timer) clearTimeout(timer);
  }
  const rejected = j.rejectionAtShutdown();
  return { unflushedBatches, ...(rejected ? { rejected } : {}) };
}

/** Whether the run directory holds a SQLite store; a Postgres run has none. */
export function hasSqliteStore(dataDir: string): boolean {
  return existsSync(path.join(dataDir, SQLITE_FILE));
}
