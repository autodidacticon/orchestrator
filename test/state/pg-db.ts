/**
 * Postgres for the tests: `TEST_DATABASE_URL` when set; otherwise a throwaway cluster started with
 * `initdb` and `pg_ctl` when both are on PATH (listening only on a Unix socket in a temp directory,
 * so parallel test files never contend for a port); otherwise the Postgres suites are skipped.
 * `ORCH_TEST_PG=off` forces the skip. One cluster per test file: call `stopTestPostgres` in `afterAll`.
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { accessSync, constants, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import pg from 'pg';
import { TABLES } from '../../src/state/journal.js';

const run = promisify(execFile);

function onPath(bin: string): boolean {
  for (const dir of (process.env['PATH'] ?? '').split(path.delimiter)) {
    if (!dir) continue;
    try {
      accessSync(path.join(dir, bin), constants.X_OK);
      return true;
    } catch {
      /* next */
    }
  }
  return false;
}

const forcedOff = process.env['ORCH_TEST_PG'] === 'off';
const url = process.env['TEST_DATABASE_URL'];

/** How the Postgres suites get a database, decided when the test file is collected. */
export const pgSource: 'url' | 'cluster' | undefined = forcedOff ? undefined : url ? 'url' : onPath('initdb') && onPath('pg_ctl') ? 'cluster' : undefined;
export const pgAvailable = pgSource !== undefined;

let started: Promise<string | pg.ClientConfig> | undefined;
let clusterDir: string | undefined;

async function startCluster(): Promise<pg.ClientConfig> {
  // A short base keeps the socket path under the 104-byte limit.
  const dir = mkdtempSync(path.join(tmpdir(), 'opg-'));
  clusterDir = dir;
  const data = path.join(dir, 'data');
  await run('initdb', ['-D', data, '-A', 'trust', '-U', 'postgres', '-E', 'UTF8', '--locale=C', '--no-sync'], { timeout: 60_000 });
  await run('pg_ctl', ['-D', data, '-l', path.join(dir, 'log'), '-w', '-t', '60', '-o', `-k ${dir} -c listen_addresses='' -F -c max_connections=200`, 'start'], { timeout: 90_000 });
  return { host: dir, port: 5432, user: 'postgres', database: 'postgres' };
}

/** The connection for this file's database, starting the cluster on first use. */
export function testDatabase(): Promise<string | pg.ClientConfig> {
  if (!pgSource) return Promise.reject(new Error('no Postgres for tests'));
  started ??= pgSource === 'url' ? Promise.resolve(url!) : startCluster();
  return started;
}

/** Stop this file's cluster, if it started one. */
export async function stopTestPostgres(): Promise<void> {
  if (!started || !clusterDir) return;
  const dir = clusterDir;
  started = undefined;
  clusterDir = undefined;
  try {
    await run('pg_ctl', ['-D', path.join(dir, 'data'), '-m', 'immediate', '-w', 'stop'], { timeout: 60_000 });
  } catch {
    /* already gone */
  }
  rmSync(dir, { recursive: true, force: true });
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

/** Delete one run's rows (a shared `TEST_DATABASE_URL` keeps no test leftovers). */
export async function dropRun(runId: string): Promise<void> {
  const c = await adminClient();
  try {
    for (const { name } of TABLES) await c.query(`DELETE FROM ${name} WHERE run_id = $1`, [runId]).catch(() => undefined);
  } finally {
    await c.end();
  }
}
