/**
 * SQLite implementation of the Store over Node's built-in `node:sqlite` binding,
 * WAL mode, no native dependency. Rows hold JSON documents; the shape is the
 * TypeScript type. A constraint violation throws an Error with `code`
 * `ERR_SQLITE_ERROR`, the extended result code in `errcode`, SQLite's short
 * text in `errstr`, and SQLite's own message (`UNIQUE constraint failed: ...`).
 * See specs/crash-recovery "Store transactions" and specs/host-integration "Quiet SQLite binding".
 */
import { releaseSqliteWarningFilter } from './sqlite-warning.js';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { Id } from '../graph/model.js';
import type { Entry } from './status.js';
import type {
  Attachment,
  EffectStatus,
  EventInput,
  JobStatus,
  Launch,
  LaunchStatus,
  NewOutboxEffect,
  OutboxEffect,
  Proposal,
  ProposalStatus,
  Store,
  StoredEvent,
  StoredReport,
  VerifierJob,
} from './store.js';

// Armed after `node:sqlite` has evaluated, so its queued warning is handled before the fallback restore.
releaseSqliteWarningFilter();

interface OutboxRow {
  id: number;
  source_seq: number;
  task_id: string;
  kind: string;
  payload: string;
  status: string;
  attempts: number;
  result: string | null;
  error: string | null;
  created_at: number;
  applied_at: number | null;
}

function rowToEffect(r: OutboxRow): OutboxEffect {
  return {
    id: r.id,
    sourceSeq: r.source_seq,
    taskId: r.task_id,
    kind: r.kind as OutboxEffect['kind'],
    payload: JSON.parse(r.payload) as Record<string, unknown>,
    status: r.status as EffectStatus,
    attempts: r.attempts,
    result: r.result === null ? undefined : (JSON.parse(r.result) as unknown),
    error: r.error ?? undefined,
    createdAt: r.created_at,
    appliedAt: r.applied_at ?? undefined,
  };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS overlay (id TEXT PRIMARY KEY, entry TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL, task_id TEXT, launch_id TEXT, payload TEXT);
CREATE INDEX IF NOT EXISTS events_task ON events(task_id);
CREATE TABLE IF NOT EXISTS dedup (launch_id TEXT NOT NULL, seq INTEGER NOT NULL, response TEXT NOT NULL, PRIMARY KEY (launch_id, seq));
CREATE TABLE IF NOT EXISTS launches (launch_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, status TEXT NOT NULL, token TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, doc TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS launches_task ON launches(task_id);
CREATE INDEX IF NOT EXISTS launches_status ON launches(status);
CREATE TABLE IF NOT EXISTS verifier_jobs (job_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, status TEXT NOT NULL, applied INTEGER NOT NULL, created_at INTEGER NOT NULL, doc TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reports (launch_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, kind TEXT NOT NULL, created_at INTEGER NOT NULL, doc TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS payload_overlays (task_id TEXT NOT NULL, graph_rev TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (task_id, graph_rev));
CREATE TABLE IF NOT EXISTS graph_snapshot (id INTEGER PRIMARY KEY CHECK (id = 1), rev TEXT NOT NULL, content TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS proposals (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, launch_id TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, doc TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS proposals_status ON proposals(status);
CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, source_seq INTEGER NOT NULL, task_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, result TEXT, error TEXT, created_at INTEGER NOT NULL, applied_at INTEGER);
CREATE UNIQUE INDEX IF NOT EXISTS outbox_key ON outbox(source_seq, task_id, kind);
CREATE INDEX IF NOT EXISTS outbox_status ON outbox(status);
`;

const BUSY_TIMEOUT_MS = 5000;
const SQLITE_BUSY = 5;

/** Run `sql`, retrying with a short blocking backoff while SQLite reports SQLITE_BUSY, until `timeoutMs`. */
function execRetryingBusy(db: DatabaseSync, sql: string, timeoutMs: number): void {
  const deadline = Date.now() + timeoutMs;
  for (let waitMs = 5; ; waitMs = Math.min(waitMs * 2, 100)) {
    try {
      db.exec(sql);
      return;
    } catch (err) {
      const code = (err as { errcode?: number }).errcode;
      if (code === undefined || (code & 0xff) !== SQLITE_BUSY || Date.now() >= deadline) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
    }
  }
}

export class SqliteStore implements Store {
  private readonly db: DatabaseSync;
  private depth = 0;
  private closed = false;

  constructor(public readonly path: string) {
    this.db = new DatabaseSync(path);
    // better-sqlite3 waited five seconds for a locked database by default; node:sqlite waits zero.
    this.db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    // Two processes opening a new file both hold a shared lock and want the exclusive one to switch
    // it to WAL; SQLite answers SQLITE_BUSY without calling the busy handler, so retry here.
    execRetryingBusy(this.db, 'PRAGMA journal_mode = WAL', BUSY_TIMEOUT_MS);
    this.db.exec('PRAGMA synchronous = NORMAL');
    execRetryingBusy(this.db, SCHEMA, BUSY_TIMEOUT_MS);
  }

  /**
   * One deferred transaction at the top level; a call made inside a transaction
   * nests as a savepoint, so an inner throw undoes only the inner writes and the
   * outer function decides whether to continue, and an outer throw undoes both.
   */
  transaction<T>(fn: () => T): T {
    const level = this.depth;
    const savepoint = `orch_${level}`;
    this.db.exec(level === 0 ? 'BEGIN' : `SAVEPOINT ${savepoint}`);
    this.depth = level + 1;
    try {
      const out = fn();
      this.db.exec(level === 0 ? 'COMMIT' : `RELEASE ${savepoint}`);
      return out;
    } catch (err) {
      try {
        // SQLite ends the transaction itself on FULL, IOERR, NOMEM, and INTERRUPT; the caller must see the original error.
        this.db.exec(level === 0 ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
      } catch {
        /* ignore: the original error is rethrown */
      }
      throw err;
    } finally {
      this.depth = level;
    }
  }

  getEntry(id: Id): Entry | undefined {
    const row = this.db.prepare('SELECT entry FROM overlay WHERE id = ?').get(id) as { entry: string } | undefined;
    return row ? (JSON.parse(row.entry) as Entry) : undefined;
  }

  setEntry(id: Id, entry: Entry): void {
    this.db
      .prepare('INSERT INTO overlay (id, entry) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET entry = excluded.entry')
      .run(id, JSON.stringify(entry));
  }

  allEntries(): Map<Id, Entry> {
    const rows = this.db.prepare('SELECT id, entry FROM overlay').all() as Array<{ id: string; entry: string }>;
    return new Map(rows.map((r) => [r.id, JSON.parse(r.entry) as Entry]));
  }

  appendEvent(ev: EventInput, ts: number): number {
    const res = this.db
      .prepare('INSERT INTO events (ts, kind, task_id, launch_id, payload) VALUES (?, ?, ?, ?, ?)')
      .run(ts, ev.kind, ev.taskId ?? null, ev.launchId ?? null, ev.payload ? JSON.stringify(ev.payload) : null);
    return Number(res.lastInsertRowid);
  }

  listEvents(filter: { kind?: string; kinds?: string[]; taskId?: Id; launchId?: string; afterSeq?: number; limit?: number } = {}): StoredEvent[] {
    const where: string[] = [];
    const args: SQLInputValue[] = [];
    if (filter.kind) {
      where.push('kind = ?');
      args.push(filter.kind);
    }
    if (filter.kinds && filter.kinds.length) {
      where.push(`kind IN (${filter.kinds.map(() => '?').join(',')})`);
      args.push(...filter.kinds);
    }
    if (filter.taskId) {
      where.push('task_id = ?');
      args.push(filter.taskId);
    }
    if (filter.launchId) {
      where.push('launch_id = ?');
      args.push(filter.launchId);
    }
    if (filter.afterSeq !== undefined) {
      where.push('seq > ?');
      args.push(filter.afterSeq);
    }
    const limit = filter.limit && filter.limit > 0 ? ` LIMIT ${Math.floor(filter.limit)}` : '';
    const sql = `SELECT seq, ts, kind, task_id, launch_id, payload FROM events${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY seq${limit}`;
    const rows = this.db.prepare(sql).all(...args) as Array<{
      seq: number;
      ts: number;
      kind: string;
      task_id: string | null;
      launch_id: string | null;
      payload: string | null;
    }>;
    return rows.map((r) => ({
      seq: r.seq,
      ts: r.ts,
      kind: r.kind,
      taskId: r.task_id ?? undefined,
      launchId: r.launch_id ?? undefined,
      payload: r.payload ? (JSON.parse(r.payload) as Record<string, unknown>) : undefined,
    }));
  }

  latestEventSeq(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').get() as { seq: number };
    return row.seq;
  }

  getDedup(launchId: string, seq: number): unknown | undefined {
    const row = this.db.prepare('SELECT response FROM dedup WHERE launch_id = ? AND seq = ?').get(launchId, seq) as
      | { response: string }
      | undefined;
    return row ? JSON.parse(row.response) : undefined;
  }

  putDedup(launchId: string, seq: number, response: unknown): void {
    this.db
      .prepare('INSERT OR REPLACE INTO dedup (launch_id, seq, response) VALUES (?, ?, ?)')
      .run(launchId, seq, JSON.stringify(response ?? null));
  }

  createLaunch(l: Launch): void {
    this.db
      .prepare('INSERT INTO launches (launch_id, task_id, status, token, created_at, doc) VALUES (?, ?, ?, ?, ?, ?)')
      .run(l.launchId, l.taskId, l.status, l.token, l.createdAt, JSON.stringify(l));
  }

  updateLaunch(launchId: string, patch: Partial<Launch>): void {
    const cur = this.getLaunch(launchId);
    if (!cur) throw new Error(`launch ${launchId} not found`);
    const next = { ...cur, ...patch };
    this.db
      .prepare('UPDATE launches SET status = ?, token = ?, doc = ? WHERE launch_id = ?')
      .run(next.status, next.token, JSON.stringify(next), launchId);
  }

  getLaunch(launchId: string): Launch | undefined {
    const row = this.db.prepare('SELECT doc FROM launches WHERE launch_id = ?').get(launchId) as { doc: string } | undefined;
    return row ? (JSON.parse(row.doc) as Launch) : undefined;
  }

  getLaunchByToken(token: string): Launch | undefined {
    const row = this.db.prepare('SELECT doc FROM launches WHERE token = ?').get(token) as { doc: string } | undefined;
    return row ? (JSON.parse(row.doc) as Launch) : undefined;
  }

  listLaunches(filter: { status?: LaunchStatus | LaunchStatus[]; taskId?: Id } = {}): Launch[] {
    const where: string[] = [];
    const args: SQLInputValue[] = [];
    if (filter.status) {
      const list = Array.isArray(filter.status) ? filter.status : [filter.status];
      where.push(`status IN (${list.map(() => '?').join(',')})`);
      args.push(...list);
    }
    if (filter.taskId) {
      where.push('task_id = ?');
      args.push(filter.taskId);
    }
    const sql = `SELECT doc FROM launches${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at, rowid`;
    return (this.db.prepare(sql).all(...args) as Array<{ doc: string }>).map((r) => JSON.parse(r.doc) as Launch);
  }

  createJob(j: VerifierJob): void {
    this.db
      .prepare('INSERT INTO verifier_jobs (job_id, task_id, status, applied, created_at, doc) VALUES (?, ?, ?, ?, ?, ?)')
      .run(j.jobId, j.taskId, j.status, j.applied ? 1 : 0, j.createdAt, JSON.stringify(j));
  }

  updateJob(jobId: string, patch: Partial<VerifierJob>): void {
    const cur = this.getJob(jobId);
    if (!cur) throw new Error(`job ${jobId} not found`);
    const next = { ...cur, ...patch };
    this.db
      .prepare('UPDATE verifier_jobs SET status = ?, applied = ?, doc = ? WHERE job_id = ?')
      .run(next.status, next.applied ? 1 : 0, JSON.stringify(next), jobId);
  }

  getJob(jobId: string): VerifierJob | undefined {
    const row = this.db.prepare('SELECT doc FROM verifier_jobs WHERE job_id = ?').get(jobId) as { doc: string } | undefined;
    return row ? (JSON.parse(row.doc) as VerifierJob) : undefined;
  }

  listJobs(filter: { status?: JobStatus | JobStatus[]; taskId?: Id; applied?: boolean } = {}): VerifierJob[] {
    const where: string[] = [];
    const args: SQLInputValue[] = [];
    if (filter.status) {
      const list = Array.isArray(filter.status) ? filter.status : [filter.status];
      where.push(`status IN (${list.map(() => '?').join(',')})`);
      args.push(...list);
    }
    if (filter.taskId) {
      where.push('task_id = ?');
      args.push(filter.taskId);
    }
    if (filter.applied !== undefined) {
      where.push('applied = ?');
      args.push(filter.applied ? 1 : 0);
    }
    const sql = `SELECT doc FROM verifier_jobs${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at, job_id`;
    return (this.db.prepare(sql).all(...args) as Array<{ doc: string }>).map((r) => JSON.parse(r.doc) as VerifierJob);
  }

  dropJob(jobId: string): void {
    this.updateJob(jobId, { status: 'dropped', applied: true });
  }

  createProposal(p: Proposal): void {
    this.db
      .prepare('INSERT INTO proposals (id, task_id, launch_id, status, created_at, doc) VALUES (?, ?, ?, ?, ?, ?)')
      .run(p.id, p.taskId, p.launchId, p.status, p.createdAt, JSON.stringify(p));
  }

  updateProposal(id: string, patch: Partial<Proposal>): void {
    const cur = this.getProposal(id);
    if (!cur) throw new Error(`proposal ${id} not found`);
    const next = { ...cur, ...patch };
    this.db.prepare('UPDATE proposals SET status = ?, doc = ? WHERE id = ?').run(next.status, JSON.stringify(next), id);
  }

  getProposal(id: string): Proposal | undefined {
    const row = this.db.prepare('SELECT doc FROM proposals WHERE id = ?').get(id) as { doc: string } | undefined;
    return row ? (JSON.parse(row.doc) as Proposal) : undefined;
  }

  listProposals(filter: { status?: ProposalStatus; taskId?: Id } = {}): Proposal[] {
    const where: string[] = [];
    const args: SQLInputValue[] = [];
    if (filter.status) {
      where.push('status = ?');
      args.push(filter.status);
    }
    if (filter.taskId) {
      where.push('task_id = ?');
      args.push(filter.taskId);
    }
    const sql = `SELECT doc FROM proposals${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at, id`;
    return (this.db.prepare(sql).all(...args) as Array<{ doc: string }>).map((r) => JSON.parse(r.doc) as Proposal);
  }

  putReport(r: StoredReport): void {
    this.db
      .prepare('INSERT OR REPLACE INTO reports (launch_id, task_id, kind, created_at, doc) VALUES (?, ?, ?, ?, ?)')
      .run(r.launchId, r.taskId, r.kind, r.createdAt, JSON.stringify(r));
  }

  getReport(launchId: string): StoredReport | undefined {
    const row = this.db.prepare('SELECT doc FROM reports WHERE launch_id = ?').get(launchId) as { doc: string } | undefined;
    return row ? (JSON.parse(row.doc) as StoredReport) : undefined;
  }

  getCompletionReport(taskId: Id): StoredReport | undefined {
    const row = this.db
      .prepare("SELECT doc FROM reports WHERE task_id = ? AND kind = 'submit' ORDER BY created_at DESC LIMIT 1")
      .get(taskId) as { doc: string } | undefined;
    return row ? (JSON.parse(row.doc) as StoredReport) : undefined;
  }

  getPayloadOverlay(taskId: Id, graphRev: string): Record<string, unknown> | undefined {
    const row = this.db
      .prepare('SELECT payload FROM payload_overlays WHERE task_id = ? AND graph_rev = ?')
      .get(taskId, graphRev) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as Record<string, unknown>) : undefined;
  }

  setPayloadOverlay(taskId: Id, graphRev: string, payload: Record<string, unknown>): void {
    this.db
      .prepare('INSERT OR REPLACE INTO payload_overlays (task_id, graph_rev, payload) VALUES (?, ?, ?)')
      .run(taskId, graphRev, JSON.stringify(payload));
  }

  getSnapshot(): { rev: string; content: string } | undefined {
    const row = this.db.prepare('SELECT rev, content FROM graph_snapshot WHERE id = 1').get() as { rev: string; content: string } | undefined;
    // node:sqlite rows have a null prototype; hand out a plain object.
    return row ? { rev: row.rev, content: row.content } : undefined;
  }

  setSnapshot(rev: string, content: string): void {
    this.db
      .prepare('INSERT INTO graph_snapshot (id, rev, content) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET rev = excluded.rev, content = excluded.content')
      .run(rev, content);
  }

  getKv(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  }

  setKv(key: string, value: string): void {
    this.db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(key, value);
  }

  listAttachments(): Attachment[] {
    const rows = this.db.prepare("SELECT value FROM kv WHERE key LIKE 'attachment:%' ORDER BY key").all() as unknown as Array<{ value: string }>;
    return rows.map((r) => JSON.parse(r.value) as Attachment);
  }

  putAttachment(a: Attachment): void {
    this.setKv(`attachment:${a.id}`, JSON.stringify(a));
  }

  deleteAttachment(id: string): void {
    this.db.prepare('DELETE FROM kv WHERE key = ?').run(`attachment:${id}`);
  }

  insertOutbox(e: NewOutboxEffect): number | undefined {
    const res = this.db
      .prepare(
        "INSERT OR IGNORE INTO outbox (source_seq, task_id, kind, payload, status, attempts, created_at) VALUES (?, ?, ?, ?, 'pending', 0, ?)",
      )
      .run(e.sourceSeq, e.taskId, e.kind, JSON.stringify(e.payload), e.createdAt);
    return res.changes ? Number(res.lastInsertRowid) : undefined;
  }

  listOutbox(filter: { status?: EffectStatus; afterId?: number; limit?: number } = {}): OutboxEffect[] {
    const where: string[] = [];
    const args: SQLInputValue[] = [];
    if (filter.status) {
      where.push('status = ?');
      args.push(filter.status);
    }
    if (filter.afterId !== undefined) {
      where.push('id > ?');
      args.push(filter.afterId);
    }
    const limit = filter.limit && filter.limit > 0 ? ` LIMIT ${Math.floor(filter.limit)}` : '';
    const sql = `SELECT * FROM outbox${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id${limit}`;
    return (this.db.prepare(sql).all(...args) as unknown as OutboxRow[]).map(rowToEffect);
  }

  getOutbox(id: number): OutboxEffect | undefined {
    const row = this.db.prepare('SELECT * FROM outbox WHERE id = ?').get(id) as unknown as OutboxRow | undefined;
    return row ? rowToEffect(row) : undefined;
  }

  ackOutbox(id: number, result: unknown, now: number): OutboxEffect | undefined {
    const cur = this.getOutbox(id);
    if (!cur) return undefined;
    if (cur.status === 'applied') return cur;
    this.db
      .prepare("UPDATE outbox SET status = 'applied', result = ?, error = NULL, applied_at = ? WHERE id = ?")
      .run(JSON.stringify(result ?? null), now, id);
    return this.getOutbox(id);
  }

  nackOutbox(id: number, error: string, maxAttempts: number): OutboxEffect | undefined {
    const cur = this.getOutbox(id);
    if (!cur) return undefined;
    if (cur.status === 'applied') return cur;
    const attempts = cur.attempts + 1;
    const status: EffectStatus = attempts >= maxAttempts ? 'failed' : 'pending';
    this.db.prepare('UPDATE outbox SET status = ?, attempts = ?, error = ? WHERE id = ?').run(status, attempts, error, id);
    return this.getOutbox(id);
  }

  countOutbox(status: EffectStatus): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM outbox WHERE status = ?').get(status) as { n: number };
    return row.n;
  }

  lastSetState(taskId: Id): string | undefined {
    const row = this.db
      .prepare("SELECT payload FROM outbox WHERE task_id = ? AND kind = 'setState' ORDER BY id DESC LIMIT 1")
      .get(taskId) as { payload: string } | undefined;
    if (!row) return undefined;
    const state = (JSON.parse(row.payload) as { state?: unknown }).state;
    return typeof state === 'string' ? state : undefined;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
