/**
 * Journaled store: a synchronous memory image (a SqliteStore) whose committed writes are recorded as
 * row operations and applied, batch by batch and in order, to a durable sink behind it.
 *
 * Capture: temporary triggers on the image's own connection record the primary key of every row a
 * statement inserts, updates, or deletes into a temporary table. That table lives in the same
 * transaction as the write, so a savepoint that rolls back discards exactly its own keys and a
 * level that returns hands them to its parent. When the top-level transaction (or a bare write,
 * which runs as one) ends, the keys are read in order of first appearance and turned into one batch:
 * an upsert carrying the row as it now is, or a delete by key when the row is gone. Applying a batch
 * twice changes nothing. Event sequence numbers and outbox ids are assigned by the image and travel in
 * the row.
 *
 * See specs/state-backend.
 */
// First: sqlite.js installs the filter for node:sqlite's experimental warning before the binding loads.
import { SCHEMA, SqliteStore } from './sqlite.js';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { Id } from '../graph/model.js';
import type { Entry } from './status.js';
import type {
  Attachment,
  Durability,
  EffectStatus,
  EventInput,
  JobStatus,
  Launch,
  LaunchStatus,
  NewOutboxEffect,
  OutboxEffect,
  Proposal,
  ProposalStatus,
  ProposedGraph,
  Store,
  StoredEvent,
  StoredReport,
  VerifierJob,
} from './store.js';

export type Row = Record<string, SQLInputValue>;

export type RowOp = { op: 'upsert'; table: string; row: Row } | { op: 'delete'; table: string; key: Row };

/** The durable copy. One `applyBatch` is one sink transaction: all of it lands or none of it does. */
export interface JournalSink {
  applyBatch(ops: readonly RowOp[]): Promise<void>;
  /** True once the sink knows its session (and the run lock with it) is gone, before any batch has failed on it. */
  readonly lockLost?: boolean;
}

/** Thrown by a sink when this daemon no longer owns the run; the journal stops at once. */
export class FencedError extends Error {
  readonly fenced = true;
  constructor(message = 'fenced: this daemon no longer owns the run') {
    super(message);
    this.name = 'FencedError';
  }
}

/** Where a sink refused a batch for its content: the table and key of the refused row, and the SQLSTATE. No row contents. */
export interface Refusal {
  table?: string;
  key?: Record<string, unknown>;
  sqlstate: string;
}

/**
 * Thrown by a sink that refused a batch for its content (Postgres SQLSTATE classes 22 and 23): applying it again can
 * never succeed, so the journal stops at once with reason `rejected`. The message names the table, the key and the
 * SQLSTATE and nothing of the row. See specs/state-backend "Fatal flush".
 */
export class RejectedBatchError extends Error {
  readonly retryable = false;
  readonly refusal: Refusal;
  constructor(refusal: Refusal, cause?: unknown) {
    const where = refusal.table ? `table ${refusal.table}, key ${JSON.stringify(refusal.key ?? {})}` : 'at commit';
    super(`batch rejected by the sink: ${where}, SQLSTATE ${refusal.sqlstate}`, cause === undefined ? undefined : { cause });
    this.name = 'RejectedBatchError';
    this.refusal = refusal;
  }
}

export function isRejected(err: unknown): err is RejectedBatchError {
  return err instanceof RejectedBatchError || (typeof err === 'object' && err !== null && (err as { retryable?: unknown }).retryable === false && typeof (err as { refusal?: unknown }).refusal === 'object');
}

export function isFenced(err: unknown): boolean {
  return err instanceof FencedError || (typeof err === 'object' && err !== null && (err as { fenced?: unknown }).fenced === true);
}

/** Every table of the store with its primary key columns, in schema order. */
export const TABLES: ReadonlyArray<{ name: string; key: readonly string[] }> = [
  { name: 'overlay', key: ['id'] },
  { name: 'events', key: ['seq'] },
  { name: 'dedup', key: ['launch_id', 'seq'] },
  { name: 'launches', key: ['launch_id'] },
  { name: 'verifier_jobs', key: ['job_id'] },
  { name: 'reports', key: ['launch_id'] },
  { name: 'payload_overlays', key: ['task_id', 'graph_rev'] },
  { name: 'graph_snapshot', key: ['id'] },
  { name: 'kv', key: ['key'] },
  { name: 'proposals', key: ['id'] },
  { name: 'outbox', key: ['id'] },
];

const KEYS = new Map(TABLES.map((t) => [t.name, t.key]));

export interface FatalInfo {
  /** `rejected`: the sink refused the oldest batch for its content (see `RejectedBatchError`). */
  reason: 'deadline' | 'fenced' | 'rejected';
  /** Committed batches that never reached the sink. */
  unflushedBatches: number;
  error?: unknown;
  /** Under `rejected`: the refused row's table and key, and the SQLSTATE. */
  table?: string;
  key?: Record<string, unknown>;
  sqlstate?: string;
}

export interface JournalOptions {
  /** When the oldest unflushed batch is older than this, `onFatal` is called. Default 30s. */
  flushDeadlineMs?: number;
  /** Called once: when the deadline passes, the sink reports fenced, or the sink rejects a batch for its content. Wired to process exit in ORC-20. */
  onFatal?: (info: FatalInfo) => void;
  /** First retry delay after a failed apply; doubles up to `retryMaxMs`. */
  retryBaseMs?: number;
  retryMaxMs?: number;
  /** Start applying batches as they commit. Tests that pump flushes by hand pass false and call `flushOnce`. */
  autoFlush?: boolean;
  clock?: () => number;
}

interface Batch {
  no: number;
  ops: RowOp[];
  committedAt: number;
  eventSeq: number;
  outboxId: number;
}

function plain(row: Record<string, unknown>): Row {
  // node:sqlite rows have a null prototype.
  return { ...row } as Row;
}

/** Install the capture triggers on the image's connection. Temporary: they see only this connection's writes. */
function installCapture(db: DatabaseSync): void {
  db.exec('CREATE TEMP TABLE IF NOT EXISTS _journal (n INTEGER PRIMARY KEY, tbl TEXT NOT NULL, pk TEXT NOT NULL)');
  for (const { name, key } of TABLES) {
    const pk = (ref: 'NEW' | 'OLD') => `json_array(${key.map((c) => `${ref}.${c}`).join(', ')})`;
    const rec = (ref: 'NEW' | 'OLD') => `INSERT INTO _journal (tbl, pk) VALUES ('${name}', ${pk(ref)});`;
    db.exec(`
      CREATE TEMP TRIGGER IF NOT EXISTS _j_${name}_ins AFTER INSERT ON main.${name} BEGIN ${rec('NEW')} END;
      CREATE TEMP TRIGGER IF NOT EXISTS _j_${name}_upd AFTER UPDATE ON main.${name} BEGIN ${rec('OLD')} ${rec('NEW')} END;
      CREATE TEMP TRIGGER IF NOT EXISTS _j_${name}_del AFTER DELETE ON main.${name} BEGIN ${rec('OLD')} END;
    `);
  }
}

/** Every table's rows, ordered by primary key (launches by rowid, which orders listing ties). */
export function dumpTables(db: DatabaseSync): Record<string, Row[]> {
  const out: Record<string, Row[]> = {};
  for (const { name, key } of TABLES) {
    const order = name === 'launches' ? 'rowid' : key.join(', ');
    out[name] = (db.prepare(`SELECT * FROM main.${name} ORDER BY ${order}`).all() as Array<Record<string, unknown>>).map(plain);
  }
  return out;
}

function upsertSql(table: string, cols: string[]): string {
  const key = KEYS.get(table)!;
  const rest = cols.filter((c) => !key.includes(c));
  const set = rest.length ? `DO UPDATE SET ${rest.map((c) => `${c} = excluded.${c}`).join(', ')}` : 'DO NOTHING';
  return `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) ON CONFLICT(${key.join(', ')}) ${set}`;
}

/** Apply one batch inside an open transaction on `db`. Idempotent: an upsert keeps the row's rowid. */
export function applyOps(db: DatabaseSync, ops: readonly RowOp[]): void {
  for (const op of ops) {
    if (!KEYS.has(op.table)) throw new Error(`unknown table ${op.table}`);
    if (op.op === 'delete') {
      const cols = Object.keys(op.key);
      db.prepare(`DELETE FROM ${op.table} WHERE ${cols.map((c) => `${c} = ?`).join(' AND ')}`).run(...cols.map((c) => op.key[c]!));
    } else {
      const cols = Object.keys(op.row);
      db.prepare(upsertSql(op.table, cols)).run(...cols.map((c) => op.row[c]!));
    }
  }
}

/** A SQLite file as the durable copy. For tests and single-host use; Postgres is ORC-15. */
export class SqliteSink implements JournalSink {
  readonly db: DatabaseSync;

  constructor(public readonly path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(SCHEMA);
  }

  async applyBatch(ops: readonly RowOp[]): Promise<void> {
    this.db.exec('BEGIN');
    try {
      applyOps(this.db, ops);
      this.db.exec('COMMIT');
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* the original error is rethrown */
      }
      throw err;
    }
  }

  tables(): Record<string, Row[]> {
    return dumpTables(this.db);
  }

  /** Copy every row into an empty image, launches in their insertion order. Recovery after a crash. */
  loadInto(image: SqliteStore): void {
    const target = image.database();
    const ops: RowOp[] = [];
    for (const [table, rows] of Object.entries(this.tables())) for (const row of rows) ops.push({ op: 'upsert', table, row });
    target.exec('BEGIN');
    try {
      applyOps(target, ops);
      target.exec('COMMIT');
    } catch (err) {
      target.exec('ROLLBACK');
      throw err;
    }
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }
}

export class JournaledStore implements Store {
  private readonly db: DatabaseSync;
  private depth = 0;
  private closed = false;
  private readonly pending: Batch[] = [];
  private committed = 0;
  private flushed = 0;
  private flushing: Promise<void> | undefined;
  private fatal: FatalInfo | undefined;
  private deadlineTimer: NodeJS.Timeout | undefined;
  private readonly waiters: Array<{ upTo: number; resolve: () => void }> = [];
  private durableEventSeq: number;
  private durableOutboxId: number;
  private latestEventSeqSeen: number;
  private latestOutboxIdSeen: number;
  private readonly opts: Required<Omit<JournalOptions, 'onFatal'>> & Pick<JournalOptions, 'onFatal'>;

  /** `image` must already hold the sink's state (empty, or loaded with `SqliteSink.loadInto`). */
  constructor(
    readonly image: SqliteStore,
    readonly sink: JournalSink,
    opts: JournalOptions = {},
  ) {
    this.opts = {
      flushDeadlineMs: opts.flushDeadlineMs ?? 30_000,
      onFatal: opts.onFatal,
      retryBaseMs: opts.retryBaseMs ?? 50,
      retryMaxMs: opts.retryMaxMs ?? 2_000,
      autoFlush: opts.autoFlush ?? true,
      clock: opts.clock ?? (() => Date.now()),
    };
    this.db = image.database();
    installCapture(this.db);
    this.db.exec('DELETE FROM temp._journal');
    this.durableEventSeq = this.latestEventSeqSeen = image.latestEventSeq();
    this.durableOutboxId = this.latestOutboxIdSeen = image.latestOutboxId();
  }

  // ---- journal ----

  transaction<T>(fn: () => T): T {
    this.depth++;
    try {
      return this.image.transaction(fn);
    } finally {
      this.depth--;
      // Harvest whatever the image committed. A rolled-back level's keys were rolled back with it.
      if (this.depth === 0) this.harvest();
    }
  }

  private write<T>(fn: () => T): T {
    if (this.closed) throw new Error('store closed');
    return this.depth > 0 ? fn() : this.transaction(fn);
  }

  private harvest(): void {
    const keys = this.db.prepare('SELECT tbl, pk FROM temp._journal GROUP BY tbl, pk ORDER BY MIN(n)').all() as Array<{ tbl: string; pk: string }>;
    if (!keys.length) return;
    this.db.exec('DELETE FROM temp._journal');
    const ops: RowOp[] = [];
    let eventSeq = this.latestEventSeqSeen;
    let outboxId = this.latestOutboxIdSeen;
    for (const { tbl, pk } of keys) {
      const cols = KEYS.get(tbl)!;
      const values = JSON.parse(pk) as SQLInputValue[];
      const row = this.db.prepare(`SELECT * FROM main.${tbl} WHERE ${cols.map((c) => `${c} = ?`).join(' AND ')}`).get(...values) as Record<string, unknown> | undefined;
      if (row) {
        const r = plain(row);
        ops.push({ op: 'upsert', table: tbl, row: r });
        if (tbl === 'events') eventSeq = Math.max(eventSeq, Number(r['seq']));
        if (tbl === 'outbox') outboxId = Math.max(outboxId, Number(r['id']));
      } else {
        const key: Row = {};
        cols.forEach((c, i) => (key[c] = values[i]!));
        ops.push({ op: 'delete', table: tbl, key });
      }
    }
    this.latestEventSeqSeen = eventSeq;
    this.latestOutboxIdSeen = outboxId;
    this.pending.push({ no: ++this.committed, ops, committedAt: this.opts.clock(), eventSeq, outboxId });
    this.armDeadline();
    if (this.opts.autoFlush) this.kick();
  }

  // ---- flusher ----

  private kick(): void {
    if (this.flushing || this.fatal) return;
    this.flushing = this.drain().finally(() => {
      this.flushing = undefined;
      // A batch committed while the last apply was settling.
      if (this.pending.length && !this.fatal && this.opts.autoFlush) this.kick();
    });
  }

  private async drain(): Promise<void> {
    let attempt = 0;
    while (this.pending.length && !this.fatal) {
      const ok = await this.applyOldest();
      if (ok) {
        attempt = 0;
        continue;
      }
      if (this.fatal) return;
      attempt++;
      const delay = Math.min(this.opts.retryBaseMs * 2 ** (attempt - 1), this.opts.retryMaxMs);
      await new Promise<void>((r) => setTimeout(r, delay).unref());
      this.checkDeadline();
    }
  }

  /** Apply the oldest pending batch once. True when it landed. Tests that pump by hand use `flushOnce`. */
  private async applyOldest(): Promise<boolean> {
    const batch = this.pending[0];
    if (!batch || this.fatal) return false;
    try {
      await this.sink.applyBatch(batch.ops);
    } catch (err) {
      if (isFenced(err)) this.die('fenced', err);
      // Refused for its content: every retry fails the same way, and every later batch waits behind it.
      else if (isRejected(err)) this.die('rejected', err);
      else this.checkDeadline(err);
      return false;
    }
    if (this.fatal) return false;
    this.pending.shift();
    this.flushed = batch.no;
    this.durableEventSeq = batch.eventSeq;
    this.durableOutboxId = batch.outboxId;
    this.armDeadline();
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      const w = this.waiters[i]!;
      if (w.upTo <= this.flushed) {
        this.waiters.splice(i, 1);
        w.resolve();
      }
    }
    return true;
  }

  /** Manual pump: apply at most one pending batch. Resolves true when one landed. */
  async flushOnce(): Promise<boolean> {
    if (this.flushing) await this.flushing;
    return this.applyOldest();
  }

  private armDeadline(): void {
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    this.deadlineTimer = undefined;
    const oldest = this.pending[0];
    if (!oldest || this.fatal) return;
    const due = oldest.committedAt + this.opts.flushDeadlineMs - this.opts.clock();
    this.deadlineTimer = setTimeout(() => {
      this.deadlineTimer = undefined;
      this.checkDeadline();
    }, Math.max(0, due) + 1);
    this.deadlineTimer.unref();
  }

  private checkDeadline(err?: unknown): void {
    const oldest = this.pending[0];
    if (!oldest || this.fatal) return;
    if (this.opts.clock() - oldest.committedAt > this.opts.flushDeadlineMs) this.die('deadline', err);
    else if (!this.deadlineTimer) this.armDeadline();
  }

  private die(reason: FatalInfo['reason'], error?: unknown): void {
    if (this.fatal) return;
    this.fatal = { reason, unflushedBatches: this.pending.length, error };
    if (reason === 'rejected' && isRejected(error)) {
      const { table, key, sqlstate } = error.refusal;
      Object.assign(this.fatal, { sqlstate, ...(table !== undefined ? { table } : {}), ...(key !== undefined ? { key } : {}) });
    }
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    this.deadlineTimer = undefined;
    // Waiters never resolve: an effect behind an unflushed record must not happen.
    this.opts.onFatal?.(this.fatal);
  }

  /**
   * Why the store cannot take work, empty when it can: a fatal condition, a lost run lock, or a lag above zero for
   * longer than one flush retry. See specs/state-backend "Store readiness".
   */
  readiness(): string[] {
    if (this.fatal) {
      const why = { fenced: 'the run lock was lost', deadline: 'the flush deadline passed', rejected: `the sink rejected a batch (${String((this.fatal.error as Error | undefined)?.message ?? 'rejected')})` }[this.fatal.reason];
      return [`store: ${why}; ${this.fatal.unflushedBatches} batches unflushed`];
    }
    if (this.sink.lockLost) return ['store: the session holding the run lock was lost'];
    const d = this.durability();
    if (d.lagMs > this.opts.retryMaxMs) return [`store: ${d.pendingBatches} batches unflushed for ${d.lagMs}ms, longer than one flush retry (${this.opts.retryMaxMs}ms)`];
    return [];
  }

  /** Stop at once with reason `fenced`: the sink reported the run lock lost while no batch was in flight. */
  fence(error?: unknown): void {
    this.die('fenced', error);
  }

  /** The fatal condition, once one occurred. */
  fatalReason(): FatalInfo | undefined {
    return this.fatal;
  }

  durable(): Promise<void> {
    const upTo = this.committed;
    if (this.flushed >= upTo) return Promise.resolve();
    return new Promise<void>((resolve) => this.waiters.push({ upTo, resolve }));
  }

  durability(): Durability {
    const oldest = this.pending[0];
    return {
      lagMs: oldest ? Math.max(1, this.opts.clock() - oldest.committedAt) : 0,
      pendingBatches: this.pending.length,
      eventSeq: this.durableEventSeq,
      outboxId: this.durableOutboxId,
    };
  }

  // ---- reads answer from the image ----

  getEntry(id: Id): Entry | undefined {
    return this.image.getEntry(id);
  }
  allEntries(): Map<Id, Entry> {
    return this.image.allEntries();
  }
  listEvents(filter?: Parameters<Store['listEvents']>[0]): StoredEvent[] {
    return this.image.listEvents(filter);
  }
  latestEventSeq(): number {
    return this.image.latestEventSeq();
  }
  getDedup(launchId: string, seq: number): unknown | undefined {
    return this.image.getDedup(launchId, seq);
  }
  getLaunch(launchId: string): Launch | undefined {
    return this.image.getLaunch(launchId);
  }
  getLaunchByToken(token: string): Launch | undefined {
    return this.image.getLaunchByToken(token);
  }
  listLaunches(filter?: { status?: LaunchStatus | LaunchStatus[]; taskId?: Id }): Launch[] {
    return this.image.listLaunches(filter);
  }
  getJob(jobId: string): VerifierJob | undefined {
    return this.image.getJob(jobId);
  }
  listJobs(filter?: { status?: JobStatus | JobStatus[]; taskId?: Id; applied?: boolean }): VerifierJob[] {
    return this.image.listJobs(filter);
  }
  getProposal(id: string): Proposal | undefined {
    return this.image.getProposal(id);
  }
  listProposals(filter?: { status?: ProposalStatus; taskId?: Id }): Proposal[] {
    return this.image.listProposals(filter);
  }
  getReport(launchId: string): StoredReport | undefined {
    return this.image.getReport(launchId);
  }
  getCompletionReport(taskId: Id): StoredReport | undefined {
    return this.image.getCompletionReport(taskId);
  }
  getPayloadOverlay(taskId: Id, graphRev: string): Record<string, unknown> | undefined {
    return this.image.getPayloadOverlay(taskId, graphRev);
  }
  getSnapshot(): { rev: string; content: string } | undefined {
    return this.image.getSnapshot();
  }
  getKv(key: string): string | undefined {
    return this.image.getKv(key);
  }
  getProposedGraph(): ProposedGraph | undefined {
    return this.image.getProposedGraph();
  }
  listAttachments(): Attachment[] {
    return this.image.listAttachments();
  }
  listOutbox(filter?: { status?: EffectStatus; afterId?: number; limit?: number }): OutboxEffect[] {
    return this.image.listOutbox(filter);
  }
  getOutbox(id: number): OutboxEffect | undefined {
    return this.image.getOutbox(id);
  }
  countOutbox(status: EffectStatus): number {
    return this.image.countOutbox(status);
  }
  latestOutboxId(): number {
    return this.image.latestOutboxId();
  }
  lastSetState(taskId: Id): string | undefined {
    return this.image.lastSetState(taskId);
  }

  // ---- writes are journaled ----

  setEntry(id: Id, entry: Entry): void {
    this.write(() => this.image.setEntry(id, entry));
  }
  appendEvent(ev: EventInput, ts: number): number {
    return this.write(() => this.image.appendEvent(ev, ts));
  }
  putDedup(launchId: string, seq: number, response: unknown): void {
    this.write(() => this.image.putDedup(launchId, seq, response));
  }
  createLaunch(l: Launch): void {
    this.write(() => this.image.createLaunch(l));
  }
  updateLaunch(launchId: string, patch: Partial<Launch>): void {
    this.write(() => this.image.updateLaunch(launchId, patch));
  }
  createJob(j: VerifierJob): void {
    this.write(() => this.image.createJob(j));
  }
  updateJob(jobId: string, patch: Partial<VerifierJob>): void {
    this.write(() => this.image.updateJob(jobId, patch));
  }
  dropJob(jobId: string): void {
    this.write(() => this.image.dropJob(jobId));
  }
  createProposal(p: Proposal): void {
    this.write(() => this.image.createProposal(p));
  }
  updateProposal(id: string, patch: Partial<Proposal>): void {
    this.write(() => this.image.updateProposal(id, patch));
  }
  putReport(r: StoredReport): void {
    this.write(() => this.image.putReport(r));
  }
  setPayloadOverlay(taskId: Id, graphRev: string, payload: Record<string, unknown>): void {
    this.write(() => this.image.setPayloadOverlay(taskId, graphRev, payload));
  }
  setSnapshot(rev: string, content: string): void {
    this.write(() => this.image.setSnapshot(rev, content));
  }
  setKv(key: string, value: string): void {
    this.write(() => this.image.setKv(key, value));
  }
  setProposedGraph(rev: string, content: string): ProposedGraph {
    return this.write(() => this.image.setProposedGraph(rev, content));
  }
  putAttachment(a: Attachment): void {
    this.write(() => this.image.putAttachment(a));
  }
  deleteAttachment(id: string): void {
    this.write(() => this.image.deleteAttachment(id));
  }
  insertOutbox(e: NewOutboxEffect): number | undefined {
    return this.write(() => this.image.insertOutbox(e));
  }
  ackOutbox(id: number, result: unknown, now: number): OutboxEffect | undefined {
    return this.write(() => this.image.ackOutbox(id, result, now));
  }
  nackOutbox(id: number, error: string, maxAttempts: number): OutboxEffect | undefined {
    return this.write(() => this.image.nackOutbox(id, error, maxAttempts));
  }

  /**
   * Close the image. Batches already committed stay queued and keep flushing to the sink, so a
   * caller that wants them durable awaits `durable()` (before or after close).
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.image.close();
    if (!this.pending.length && this.deadlineTimer) clearTimeout(this.deadlineTimer);
  }
}
