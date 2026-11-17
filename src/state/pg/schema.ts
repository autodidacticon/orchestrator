/**
 * The Postgres copy of the store's tables (see `SCHEMA` in ../sqlite.ts), as migrations applied at
 * startup. Differences from SQLite:
 *  - every table has `run_id`, leading every primary key and unique index, so many runs share one database;
 *  - documents are JSONB;
 *  - `events.seq` and `outbox.id` are plain `bigint` columns written explicitly (the image assigns them);
 *  - `launches.ord` is the insertion order, set on first insert and kept on update, because
 *    `listLaunches` breaks `created_at` ties by SQLite `rowid`.
 * Timestamps, sequence numbers and ids are `bigint`. See specs/state-backend.
 *
 * Every table lives in one schema, `store.schema` (`DEFAULT_STORE_SCHEMA` when unset). The migrations' statements are
 * unqualified: `migrate()` runs them under a transaction-local `search_path` holding that schema alone.
 * This file imports nothing, so the configuration can use the name rule without loading the driver.
 */

/** The schema that holds the store's tables when `store.schema` is unset. See specs/state-backend "Store schema key". */
export const DEFAULT_STORE_SCHEMA = 'orchestrator';

/** The rule a schema name must follow, as printed in a refusal. */
export const STORE_SCHEMA_RULE =
  'a schema name is 1 to 63 characters of a-z, 0-9 and _, starts with a letter or _, does not start with pg_, and is not information_schema';

/**
 * Why `name` cannot be the store's schema, or undefined when it can. The one name rule: the configuration check and
 * `PgSink.open` both call it. See specs/state-backend "Store schema key".
 */
export function storeSchemaError(name: string): string | undefined {
  const ok = /^[a-z_][a-z0-9_]{0,62}$/.test(name) && !name.startsWith('pg_') && name !== 'information_schema';
  return ok ? undefined : `store.schema ${JSON.stringify(name)} is refused: ${STORE_SCHEMA_RULE}`;
}

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'journal-tables',
    sql: `
CREATE TABLE overlay (run_id text NOT NULL, id text NOT NULL, entry jsonb NOT NULL, PRIMARY KEY (run_id, id));
CREATE TABLE events (run_id text NOT NULL, seq bigint NOT NULL, ts bigint NOT NULL, kind text NOT NULL, task_id text, launch_id text, payload jsonb, PRIMARY KEY (run_id, seq));
CREATE INDEX events_task ON events (run_id, task_id);
CREATE TABLE dedup (run_id text NOT NULL, launch_id text NOT NULL, seq bigint NOT NULL, response jsonb NOT NULL, PRIMARY KEY (run_id, launch_id, seq));
CREATE TABLE launches (run_id text NOT NULL, launch_id text NOT NULL, task_id text NOT NULL, status text NOT NULL, token text NOT NULL, created_at bigint NOT NULL, doc jsonb NOT NULL, ord bigint NOT NULL,
  PRIMARY KEY (run_id, launch_id), UNIQUE (run_id, token), UNIQUE (run_id, ord));
CREATE INDEX launches_task ON launches (run_id, task_id);
CREATE INDEX launches_status ON launches (run_id, status);
CREATE TABLE verifier_jobs (run_id text NOT NULL, job_id text NOT NULL, task_id text NOT NULL, status text NOT NULL, applied integer NOT NULL, created_at bigint NOT NULL, doc jsonb NOT NULL, PRIMARY KEY (run_id, job_id));
CREATE TABLE reports (run_id text NOT NULL, launch_id text NOT NULL, task_id text NOT NULL, kind text NOT NULL, created_at bigint NOT NULL, doc jsonb NOT NULL, PRIMARY KEY (run_id, launch_id));
CREATE TABLE payload_overlays (run_id text NOT NULL, task_id text NOT NULL, graph_rev text NOT NULL, payload jsonb NOT NULL, PRIMARY KEY (run_id, task_id, graph_rev));
CREATE TABLE graph_snapshot (run_id text NOT NULL, id integer NOT NULL CHECK (id = 1), rev text NOT NULL, content text NOT NULL, PRIMARY KEY (run_id, id));
CREATE TABLE kv (run_id text NOT NULL, key text NOT NULL, value text NOT NULL, PRIMARY KEY (run_id, key));
CREATE TABLE proposals (run_id text NOT NULL, id text NOT NULL, task_id text NOT NULL, launch_id text NOT NULL, status text NOT NULL, created_at bigint NOT NULL, doc jsonb NOT NULL, PRIMARY KEY (run_id, id));
CREATE INDEX proposals_status ON proposals (run_id, status);
CREATE TABLE outbox (run_id text NOT NULL, id bigint NOT NULL, source_seq bigint NOT NULL, task_id text NOT NULL, kind text NOT NULL, payload jsonb NOT NULL, status text NOT NULL, attempts integer NOT NULL DEFAULT 0,
  result jsonb, error text, created_at bigint NOT NULL, applied_at bigint, PRIMARY KEY (run_id, id), UNIQUE (run_id, source_seq, task_id, kind));
CREATE INDEX outbox_status ON outbox (run_id, status);
`,
  },
];

export type ColumnKind = 'text' | 'json' | 'int';

/** Every journaled table's columns (without `run_id` and `ord`), with how each travels. */
export const COLUMNS: Readonly<Record<string, Readonly<Record<string, ColumnKind>>>> = {
  overlay: { id: 'text', entry: 'json' },
  events: { seq: 'int', ts: 'int', kind: 'text', task_id: 'text', launch_id: 'text', payload: 'json' },
  dedup: { launch_id: 'text', seq: 'int', response: 'json' },
  launches: { launch_id: 'text', task_id: 'text', status: 'text', token: 'text', created_at: 'int', doc: 'json' },
  verifier_jobs: { job_id: 'text', task_id: 'text', status: 'text', applied: 'int', created_at: 'int', doc: 'json' },
  reports: { launch_id: 'text', task_id: 'text', kind: 'text', created_at: 'int', doc: 'json' },
  payload_overlays: { task_id: 'text', graph_rev: 'text', payload: 'json' },
  graph_snapshot: { id: 'int', rev: 'text', content: 'text' },
  kv: { key: 'text', value: 'text' },
  proposals: { id: 'text', task_id: 'text', launch_id: 'text', status: 'text', created_at: 'int', doc: 'json' },
  outbox: {
    id: 'int',
    source_seq: 'int',
    task_id: 'text',
    kind: 'text',
    payload: 'json',
    status: 'text',
    attempts: 'int',
    result: 'json',
    error: 'text',
    created_at: 'int',
    applied_at: 'int',
  },
};

/** The JSONB columns per table. */
export const JSON_COLUMNS: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  Object.entries(COLUMNS).map(([t, cols]) => [t, Object.keys(cols).filter((c) => cols[c] === 'json')]),
);
