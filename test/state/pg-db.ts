/**
 * Postgres for the tests. Where it comes from is decided once per run by the global setup
 * (test/setup/postgres.ts): `TEST_DATABASE_URL`, else one throwaway cluster shared by every test file
 * of the run, else none (the Postgres suites are skipped and the run says so in one line;
 * `ORCH_TEST_PG=required` fails the run instead, `ORCH_TEST_PG=off` forces the skip).
 *
 * On the run's cluster each test file gets its own database, created on first use and dropped by
 * `stopTestPostgres` (call it in `afterAll`); the cluster itself is stopped by the global setup.
 */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { inject } from 'vitest';
import { TABLES } from '../../src/state/journal.js';
import { DEFAULT_STORE_SCHEMA } from '../../src/state/pg/schema.js';
import type { TestPostgres } from '../setup/postgres.js';

const provided: TestPostgres = inject('testPostgres') ?? { source: 'none', reason: 'the global setup test/setup/postgres.ts did not run' };

/**
 * How the Postgres suites get a database: a URL, or the cluster this run started (only then are its
 * server processes this run's own, to stop or signal).
 */
export const pgSource: 'url' | 'cluster' | undefined = provided.source === 'none' ? undefined : provided.source;
export const pgAvailable = pgSource !== undefined;
/** Why there is no Postgres, when there is none. */
export const pgSkipReason: string | undefined = provided.source === 'none' ? provided.reason : undefined;

let started: Promise<string | pg.ClientConfig> | undefined;
let fileDatabase: string | undefined;

async function onCluster(base: pg.ClientConfig, sql: string): Promise<void> {
  const c = new pg.Client(base);
  c.on('error', () => undefined);
  await c.connect();
  try {
    await c.query(sql);
  } finally {
    await c.end().catch(() => undefined);
  }
}

async function createFileDatabase(base: pg.ClientConfig): Promise<pg.ClientConfig> {
  const name = `t_${randomBytes(6).toString('hex')}`;
  // template0: no other session can be connected to it, so concurrent creates never collide.
  await onCluster(base, `CREATE DATABASE ${name} TEMPLATE template0`);
  fileDatabase = name;
  return { ...base, database: name };
}

/** The connection for this file's database, creating it on the run's cluster on first use. */
export function testDatabase(): Promise<string | pg.ClientConfig> {
  if (provided.source === 'none') return Promise.reject(new Error(`no Postgres for tests: ${provided.reason}`));
  started ??= provided.source === 'url' ? Promise.resolve(provided.conn) : createFileDatabase(provided.conn);
  return started;
}

/** Drop this file's database on the run's cluster, if it made one. The cluster stays up for other files. */
export async function stopTestPostgres(): Promise<void> {
  if (provided.source !== 'cluster' || !started) return;
  const name = fileDatabase;
  started = undefined;
  fileDatabase = undefined;
  if (name) await onCluster(provided.conn, `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => undefined);
}

/** A run id no other test uses, even against a shared `TEST_DATABASE_URL`. */
export function freshRunId(label = 'run'): string {
  return `${label}-${randomBytes(6).toString('hex')}`;
}

/** A plain client on the test database (not a sink): for assertions and server-side actions. */
export async function adminClient(): Promise<pg.Client> {
  const conn = await testDatabase();
  const client = new pg.Client(typeof conn === 'string' ? { connectionString: conn } : conn);
  client.on('error', () => undefined);
  await client.connect();
  return client;
}

/** The schema the suites' sinks use (none names another unless the test says so): raw SQL names it in each statement. */
export const TEST_SCHEMA = DEFAULT_STORE_SCHEMA;

/** Values `store.schema` refuses and accepts: the vectors shared by the configuration check and `PgSink.open`'s check. */
export const REFUSED_SCHEMAS: readonly string[] = ['Orchestrator', 'pg_x', 'information_schema', 'a-b', '1a', '', 'a'.repeat(64)];
export const ACCEPTED_SCHEMAS: readonly string[] = ['orchestrator', 'public', '_x1', 'user', 'a'.repeat(63)];

/** A schema name no other test uses (schemas are shared by every file on a shared `TEST_DATABASE_URL`). */
export function freshSchema(label = 's'): string {
  return `${label}_${randomBytes(6).toString('hex')}`;
}

/** Delete one run's rows in the suites' schema (a shared `TEST_DATABASE_URL` keeps no test leftovers). */
export async function dropRun(runId: string, schema: string = TEST_SCHEMA): Promise<void> {
  const c = await adminClient();
  try {
    for (const { name } of TABLES) await c.query(`DELETE FROM ${schema}.${name} WHERE run_id = $1`, [runId]).catch(() => undefined);
  } finally {
    await c.end();
  }
}
