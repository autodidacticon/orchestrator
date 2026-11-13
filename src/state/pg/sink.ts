/**
 * Postgres as the journal's durable sink (ORC-15), on the pure-JavaScript `pg` driver.
 *
 * One daemon owns one run. `PgSink.open` connects one dedicated session, applies the migrations,
 * and takes a session-level advisory lock keyed by the run id; it refuses to open when another
 * session holds it. Every batch is written on that same session, so while the lock is held no
 * other daemon can write the run. When the session is lost (terminated by the server, network
 * failure, a failed rollback) the sink latches fenced: that batch and every later one throw
 * `FencedError` without touching the network, and the sink never reconnects to write.
 *
 * One batch is one Postgres transaction of upserts and deletes by primary key, `run_id` leading.
 * Applying a batch twice changes nothing. The loader rebuilds a memory image for one run.
 * See specs/state-backend.
 */
import { createHash } from 'node:crypto';
import pg from 'pg';
import { applyOps, FencedError, type JournalSink, type Row, type RowOp, TABLES } from '../journal.js';
import { SqliteStore } from '../sqlite.js';
import { COLUMNS, MIGRATIONS } from './schema.js';

/** Advisory lock key serializing migrations across daemons sharing one database. */
const MIGRATION_LOCK_KEY = '7307245890181612657';

const KEYS = new Map(TABLES.map((t) => [t.name, t.key]));

/** Thrown by `PgSink.open` when another session holds the run's lock. */
export class RunLockedError extends Error {
  readonly code = 'runLocked';
  constructor(readonly runId: string) {
    super(`run ${runId} is locked by another session: another daemon owns it`);
    this.name = 'RunLockedError';
  }
}

/** The advisory lock key for a run: the first 8 bytes of a SHA-256, as a signed bigint. */
export function runLockKey(runId: string): string {
  return createHash('sha256').update(`orchestrator-run:${runId}`).digest().readBigInt64BE(0).toString();
}

function toNumber(v: string): number {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error(`bigint ${v} is outside the safe integer range`);
  return n;
}

/** `bigint` (int8) comes back from `pg` as a string; this client parses it to a number. */
const TYPES = {
  getTypeParser: ((oid: number, format?: 'text' | 'binary') =>
    oid === 20 ? toNumber : (pg.types.getTypeParser as (o: number, f?: string) => unknown)(oid, format)) as never,
};

function isSqlState(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code);
}

/** SQLSTATEs meaning the session is gone: connection exceptions and operator intervention shutdowns. */
function isConnectionLoss(err: unknown): boolean {
  if (!isSqlState(err)) return true; // a client-side error: "Connection terminated", "not queryable"
  const code = (err as { code: string }).code;
  return code.startsWith('08') || code === '57P01' || code === '57P02' || code === '57P03';
}

function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`bad identifier ${name}`);
  return `"${name}"`;
}

function columnsOf(table: string, row: Row): string[] {
  const known = COLUMNS[table];
  if (!known) throw new Error(`unknown table ${table}`);
  const cols = Object.keys(row);
  for (const c of cols) if (!(c in known)) throw new Error(`unknown column ${table}.${c}`);
  return cols;
}

interface Query {
  text: string;
  values: unknown[];
}

/** The statements for one batch, `run_id` as `$1`. Throws on an unknown table or column before anything is sent. */
export function batchStatements(runId: string, ops: readonly RowOp[]): Query[] {
  const out: Query[] = [];
  for (const op of ops) {
    const key = KEYS.get(op.table);
    if (!key) throw new Error(`unknown table ${op.table}`);
    const t = quoteIdent(op.table);
    if (op.op === 'delete') {
      const cols = columnsOf(op.table, op.key);
      out.push({
        text: `DELETE FROM ${t} WHERE run_id = $1 AND ${cols.map((c, i) => `${quoteIdent(c)} = $${i + 2}`).join(' AND ')}`,
        values: [runId, ...cols.map((c) => op.key[c])],
      });
      continue;
    }
    const cols = columnsOf(op.table, op.row);
    const kinds = COLUMNS[op.table]!;
    const names = ['run_id', ...cols.map(quoteIdent)];
    const params = ['$1', ...cols.map((c, i) => (kinds[c] === 'json' ? `$${i + 2}::jsonb` : `$${i + 2}`))];
    if (op.table === 'launches') {
      // Insertion order: set on first insert, never in DO UPDATE, so an update or a re-applied batch keeps it.
      names.push('ord');
      params.push('(SELECT COALESCE(MAX(ord), 0) + 1 FROM launches WHERE run_id = $1)');
    }
    const rest = cols.filter((c) => !key.includes(c));
    const conflict = `ON CONFLICT (run_id, ${key.map(quoteIdent).join(', ')}) ${
      rest.length ? `DO UPDATE SET ${rest.map((c) => `${quoteIdent(c)} = EXCLUDED.${quoteIdent(c)}`).join(', ')}` : 'DO NOTHING'
    }`;
    out.push({ text: `INSERT INTO ${t} (${names.join(', ')}) VALUES (${params.join(', ')}) ${conflict}`, values: [runId, ...cols.map((c) => op.row[c])] });
  }
  return out;
}

/** Apply a batch's statements on `client` inside a transaction the caller opened. */
export async function applyPgOps(client: pg.ClientBase, runId: string, ops: readonly RowOp[]): Promise<void> {
  for (const q of batchStatements(runId, ops)) await client.query(q);
}

function selectSql(table: string, raw: boolean): string {
  const cols = Object.entries(COLUMNS[table]!).map(([c, k]) => (k === 'json' ? `${quoteIdent(c)}::text AS ${quoteIdent(c)}` : quoteIdent(c)));
  if (raw) cols.unshift('run_id', ...(table === 'launches' ? ['ord'] : []));
  const order = table === 'launches' ? 'ord' : KEYS.get(table)!.map(quoteIdent).join(', ');
  return `SELECT ${cols.join(', ')} FROM ${quoteIdent(table)} WHERE run_id = $1 ORDER BY ${order}`;
}

/** Read every table of one run. Rows are in the image's shape: documents as compact JSON text, numbers as numbers. */
export async function readRun(client: pg.ClientBase, runId: string, opts: { raw?: boolean } = {}): Promise<Record<string, Row[]>> {
  const out: Record<string, Row[]> = {};
  for (const { name } of TABLES) {
    const res = await client.query({ text: selectSql(name, !!opts.raw), values: [runId] });
    const json = Object.entries(COLUMNS[name]!).filter(([, k]) => k === 'json').map(([c]) => c);
    out[name] = res.rows.map((r: Record<string, unknown>) => {
      const row: Row = { ...(r as Row) };
      // JSONB text comes back normalized ("a": 1); store compact text, as the image writes it.
      if (!opts.raw) for (const c of json) if (typeof row[c] === 'string') row[c] = JSON.stringify(JSON.parse(row[c] as string));
      return row;
    });
  }
  return out;
}

/** Copy one run's rows into an empty image, launches in insertion order. */
export async function loadRunInto(client: pg.ClientBase, runId: string, image: SqliteStore): Promise<void> {
  const tables = await readRun(client, runId);
  const ops: RowOp[] = [];
  for (const { name } of TABLES) for (const row of tables[name]!) ops.push({ op: 'upsert', table: name, row });
  const db = image.database();
  db.exec('BEGIN');
  try {
    // Explicit seq and id values advance SQLite's AUTOINCREMENT counters, so new ids are above every loaded one.
    applyOps(db, ops);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Apply every pending migration, serialized across sessions by a transaction-level advisory lock. */
export async function migrate(client: pg.ClientBase): Promise<number[]> {
  const applied: number[] = [];
  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [MIGRATION_LOCK_KEY]);
    await client.query('CREATE TABLE IF NOT EXISTS orchestrator_migrations (version integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await client.query('SELECT version FROM orchestrator_migrations')).rows.map((r: { version: number }) => r.version));
    for (const m of MIGRATIONS) {
      if (done.has(m.version)) continue;
      await client.query(m.sql);
      await client.query('INSERT INTO orchestrator_migrations (version, name) VALUES ($1, $2)', [m.version, m.name]);
      applied.push(m.version);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  }
  return applied;
}

export interface PgSinkOptions {
  /** A connection string or a `pg` client config. */
  connection: string | pg.ClientConfig;
  runId: string;
}

export class PgSink implements JournalSink {
  private lost: unknown;
  private fencedAt: FencedError | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private readonly lostListeners: Array<(err: unknown) => void> = [];

  private constructor(
    readonly client: pg.Client,
    readonly runId: string,
    /** The server process id of the session that holds the run lock. */
    readonly backendPid: number,
  ) {
    const mark = (err: unknown) => {
      if (this.lost !== undefined) return;
      this.lost = err ?? new Error('connection ended');
      // An intentional close is not a loss.
      if (this.closed) return;
      for (const fn of this.lostListeners.splice(0)) fn(this.lost);
    };
    // Without a listener a server-side termination is an unhandled 'error'.
    client.on('error', mark);
    client.on('end', () => mark(new Error('connection ended')));
  }

  /** Connect, migrate, and take the run lock. Rejects with `RunLockedError` when another session holds it. */
  static async open(opts: PgSinkOptions): Promise<PgSink> {
    const base: pg.ClientConfig = typeof opts.connection === 'string' ? { connectionString: opts.connection } : { ...opts.connection };
    const client = new pg.Client({ application_name: `orchestrator:${opts.runId}`.slice(0, 63), ...base, types: TYPES });
    client.on('error', () => undefined); // until the sink's own listener is attached
    await client.connect();
    try {
      await migrate(client);
      const got = await client.query('SELECT pg_try_advisory_lock($1::bigint) AS ok, pg_backend_pid() AS pid', [runLockKey(opts.runId)]);
      const row = got.rows[0] as { ok: boolean; pid: number };
      if (!row.ok) throw new RunLockedError(opts.runId);
      return new PgSink(client, opts.runId, row.pid);
    } catch (err) {
      await client.end().catch(() => undefined);
      throw err;
    }
  }

  /**
   * Call `fn` once when the session holding the run lock is lost while the sink is open, even with no batch in
   * flight (a terminated backend, a server shutdown). Not called for `close`. Called at once when already lost.
   */
  onLost(fn: (err: unknown) => void): void {
    if (this.closed) return;
    if (this.lost !== undefined) fn(this.lost);
    else this.lostListeners.push(fn);
  }

  /** True once the session holding the run lock is gone (fenced or not yet noticed by a batch); false after `close`. */
  get lockLost(): boolean {
    return !this.closed && (this.lost !== undefined || this.fencedAt !== undefined);
  }

  /** True once the session is gone: every later batch throws `FencedError`. */
  get fenced(): boolean {
    return this.fencedAt !== undefined;
  }

  private fence(cause: unknown): FencedError {
    this.fencedAt ??= Object.assign(new FencedError(`fenced: the session holding run ${this.runId}'s lock was lost`), { cause });
    return this.fencedAt;
  }

  /** One sink operation at a time on the one session. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  applyBatch(ops: readonly RowOp[]): Promise<void> {
    return this.serial(async () => {
      if (this.fencedAt) throw this.fencedAt;
      if (this.lost !== undefined || this.closed) throw this.fence(this.lost ?? new Error('sink closed'));
      const statements = batchStatements(this.runId, ops); // validation errors leave the session untouched
      try {
        await this.client.query('BEGIN');
      } catch (err) {
        throw isConnectionLoss(err) || this.lost !== undefined ? this.fence(err) : err;
      }
      try {
        for (const q of statements) await this.client.query(q);
        await this.client.query('COMMIT');
      } catch (err) {
        if (this.lost !== undefined || isConnectionLoss(err)) throw this.fence(err);
        try {
          await this.client.query('ROLLBACK');
        } catch (rollbackErr) {
          throw this.fence(rollbackErr);
        }
        throw err;
      }
    });
  }

  /** This run's rows, in the image's shape. `raw` adds `run_id` and `launches.ord` and keeps JSONB text as the server prints it. */
  tables(opts: { raw?: boolean } = {}): Promise<Record<string, Row[]>> {
    return this.serial(() => readRun(this.client, this.runId, opts));
  }

  /** Load this run into an empty image. */
  loadInto(image: SqliteStore): Promise<void> {
    return this.serial(() => loadRunInto(this.client, this.runId, image));
  }

  /** A fresh in-memory image holding this run. */
  async loadImage(): Promise<SqliteStore> {
    const image = new SqliteStore(':memory:');
    try {
      await this.loadInto(image);
    } catch (err) {
      image.close();
      throw err;
    }
    return image;
  }

  /** End the session, releasing the run lock. Later batches throw `FencedError`. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.queue;
    await this.client.end().catch(() => undefined);
  }
}
