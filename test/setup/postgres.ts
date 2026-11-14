/**
 * Vitest global setup: decides once per run where the Postgres suites get their database, and hands
 * the answer to every test file through `provide('testPostgres')` (read by test/state/pg-db.ts).
 *
 * - `ORCH_TEST_PG=off`: no Postgres; the Postgres suites are skipped.
 * - `TEST_DATABASE_URL` set: that server (checked with one connection).
 * - otherwise, `initdb` and `pg_ctl` on PATH: one throwaway cluster for the whole run, on a Unix socket
 *   in a temp directory. It is started here, in the main process, so a killed test fork cannot leave
 *   it behind; teardown stops it, and a detached watchdog stops it if the main process itself dies.
 * - otherwise: no Postgres.
 *
 * With no Postgres the run prints one line saying the Postgres suites are skipped and why.
 * `ORCH_TEST_PG=required` turns that into a failed run instead.
 */
import { execFile, execFileSync, spawn } from 'node:child_process';
import { accessSync, constants, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import pg from 'pg';
import type { TestProject } from 'vitest/node';

const run = promisify(execFile);

/** What the test files receive. `conn` is a URL (`url`) or a client config on the run's cluster (`cluster`). */
export type TestPostgres = { source: 'url'; conn: string } | { source: 'cluster'; conn: pg.ClientConfig } | { source: 'none'; reason: string };

declare module 'vitest' {
  export interface ProvidedContext {
    testPostgres: TestPostgres;
  }
}

const MODES = ['auto', 'off', 'required'] as const;
type Mode = (typeof MODES)[number];

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

/** Stops the cluster in `dir` and removes the directory once stdin closes (the main process ended it, or died). */
const WATCHDOG = `
const { execFileSync } = require('node:child_process');
const { rmSync } = require('node:fs');
const path = require('node:path');
const dir = process.argv[1];
const stop = () => {
  try { execFileSync('pg_ctl', ['-D', path.join(dir, 'data'), '-m', 'immediate', '-w', 'stop'], { stdio: 'ignore', timeout: 60000 }); } catch {}
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  process.exit(0);
};
process.stdin.on('end', stop);
process.stdin.on('error', stop);
process.stdin.on('close', stop);
process.stdin.resume();
`;

async function startCluster(): Promise<{ conn: pg.ClientConfig; stop: () => Promise<void> }> {
  // A short base keeps the socket path under the 104-byte limit.
  const dir = mkdtempSync(path.join(tmpdir(), 'opg-'));
  const data = path.join(dir, 'data');
  // The watchdog is up before the postmaster starts, so even a setup killed halfway leaves nothing behind.
  const watchdog = spawn(process.execPath, ['-e', WATCHDOG, dir], { detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
  watchdog.unref();
  (watchdog.stdin as unknown as { unref?: () => void }).unref?.();
  const stop = async (): Promise<void> => {
    if (watchdog.exitCode !== null || watchdog.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => watchdog.once('exit', () => resolve()));
    watchdog.stdin!.end();
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([exited, new Promise((r) => (timer = setTimeout(r, 70_000)))]);
    clearTimeout(timer);
  };
  // The synchronous fallback for a main process that exits without teardown (an uncaught error).
  process.once('exit', () => {
    if (watchdog.exitCode !== null) return;
    try {
      execFileSync('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop'], { stdio: 'ignore', timeout: 30_000 });
    } catch {
      /* not running */
    }
    rmSync(dir, { recursive: true, force: true });
  });
  try {
    await run('initdb', ['-D', data, '-A', 'trust', '-U', 'postgres', '-E', 'UTF8', '--locale=C', '--no-sync'], { timeout: 120_000 });
    await run('pg_ctl', ['-D', data, '-l', path.join(dir, 'log'), '-w', '-t', '120', '-o', `-k ${dir} -c listen_addresses='' -F -c max_connections=400`, 'start'], { timeout: 150_000 });
  } catch (e) {
    await stop();
    throw e;
  }
  return { conn: { host: dir, port: 5432, user: 'postgres', database: 'postgres' }, stop };
}

async function checkUrl(url: string): Promise<void> {
  const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10_000 });
  c.on('error', () => undefined);
  try {
    await c.connect();
    await c.query('SELECT 1');
  } finally {
    await c.end().catch(() => undefined);
  }
}

export default async function setup(project: TestProject): Promise<(() => Promise<void>) | undefined> {
  const raw = process.env['ORCH_TEST_PG'] || 'auto';
  if (!(MODES as readonly string[]).includes(raw)) throw new Error(`ORCH_TEST_PG=${raw}: expected one of ${MODES.join(', ')}`);
  const mode = raw as Mode;
  const url = process.env['TEST_DATABASE_URL'];

  const none = (reason: string): undefined => {
    if (mode === 'required') throw new Error(`ORCH_TEST_PG=required, but there is no Postgres for the tests: ${reason}`);
    project.provide('testPostgres', { source: 'none', reason });
    console.log(`postgres: the Postgres suites are skipped (${reason})`);
    return undefined;
  };

  if (mode === 'off') return none('ORCH_TEST_PG=off');
  if (url) {
    try {
      await checkUrl(url);
    } catch (e) {
      // A URL that was set but does not answer is a broken setup, not a machine without Postgres.
      throw new Error(`TEST_DATABASE_URL does not accept a connection: ${(e as Error).message}`);
    }
    project.provide('testPostgres', { source: 'url', conn: url });
    return undefined;
  }
  if (!onPath('initdb') || !onPath('pg_ctl')) return none('no TEST_DATABASE_URL, and initdb and pg_ctl are not both on PATH');
  const cluster = await startCluster();
  project.provide('testPostgres', { source: 'cluster', conn: cluster.conn });
  return cluster.stop;
}
