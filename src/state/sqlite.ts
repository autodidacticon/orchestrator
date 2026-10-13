/**
 * SQLite implementation of the Store (better-sqlite3, WAL mode).
 * Rows hold JSON documents; the shape is the TypeScript type.
 */
import Database from 'better-sqlite3';
import type { Id } from '../graph/model.js';
import type { Entry } from './status.js';
import type {
  EventInput,
  JobStatus,
  Launch,
  LaunchStatus,
  Store,
  StoredEvent,
  StoredReport,
  VerifierJob,
} from './store.js';

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
`;

export class SqliteStore implements Store {
  private readonly db: Database.Database;

  constructor(public readonly path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(SCHEMA);
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
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
    const args: unknown[] = [];
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
    const args: unknown[] = [];
    if (filter.status) {
      const list = Array.isArray(filter.status) ? filter.status : [filter.status];
      where.push(`status IN (${list.map(() => '?').join(',')})`);
      args.push(...list);
    }
    if (filter.taskId) {
      where.push('task_id = ?');
      args.push(filter.taskId);
    }
    const sql = `SELECT doc FROM launches${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at, launch_id`;
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
    const args: unknown[] = [];
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
    return this.db.prepare('SELECT rev, content FROM graph_snapshot WHERE id = 1').get() as
      | { rev: string; content: string }
      | undefined;
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

  close(): void {
    this.db.close();
  }
}
