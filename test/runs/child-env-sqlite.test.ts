/**
 * Withholding follows the store (ORC-115), as real SQLite daemons started with `orchestrator --repo` in the
 * foreground: with no Postgres input, the check command and a spawned agent get the project's database variables
 * back (and never ORCH_RUN_ID or ORCH_URL); with a Postgres input and no store.kind in the file, the daemon keeps
 * withholding and warns once in its log and once as a `config.warning` event. The config report and one startup
 * line say which. Runs without Postgres. See specs/state-backend "Withholding follows the store".
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LIBPQ_VARS } from '../../src/runs/childEnv.js';
import { daemonCommand, health } from '../../src/runs/lifecycle.js';
import { readDaemonJson, runPaths } from '../../src/runs/runDir.js';
import { gitIn, makeRepo, scriptedAgent, tsxLoader } from '../slice/harness.js';

/** Values that occur nowhere else, so a match can only come from the variable. */
const PASSWORD = 'pw-Orc115-Vq8zT';
const URL = `postgresql://app:${PASSWORD}@db-orc115.invalid:5432/app`;
const URL_FILE = '/run/secrets/orc115/uri';
const PGHOST = 'pghost-orc115.invalid';
const PGPASSWORD = 'pgpw-Orc115-Lm3xR';

let dirs: string[] = [];
let children: ChildProcess[] = [];

function fresh(): string {
  const d = realpathSync(mkdtempSync(path.join(tmpdir(), 'orch-c115-')));
  dirs.push(d);
  return d;
}

async function waitFor(pred: () => Promise<boolean> | boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`waitFor timed out: ${what}`);
}

interface Run {
  child: ChildProcess;
  runDir: string;
  checkOut: string;
  agentOut: string;
  stderr: () => string;
  exited: Promise<number | null>;
}

/**
 * Start a SQLite daemon on a fresh repository in spawn mode, whose check command and agent print their environment.
 * `store` lines go into the committed orchestrator.yaml. The daemon's environment is the suite's with every client,
 * store and libpq name blanked unless `env` sets it, so the shell that runs the suite does not change the result.
 */
function start(opts: { store?: string[]; env: Record<string, string> }): Run {
  const root = fresh();
  const home = fresh();
  const repo = realpathSync(makeRepo(root));
  const checkOut = path.join(root, 'check.env');
  const agentOut = path.join(root, 'agent.env');
  const lines = [
    'runner:',
    '  mode: spawn',
    'daemon:',
    '  idleExitMs: 0',
    'tickIntervalMs: 100',
    'leaseTtlMs: 600000',
    'capacity: 1',
    `checkCommand: "env > ${checkOut}"`,
    `runnerCommand: "env > ${agentOut} && node --import ${tsxLoader} ${scriptedAgent} {briefJson}"`,
    ...(opts.store ?? []),
    '',
  ];
  writeFileSync(path.join(repo, 'orchestrator.yaml'), lines.join('\n'));
  gitIn(repo, 'add', 'orchestrator.yaml');
  gitIn(repo, 'commit', '-q', '-m', 'config');
  const blanked = Object.fromEntries(['ORCH_URL', 'ORCH_REPO', 'ORCH_DATA_DIR', 'ORCH_RUN_ID', 'DATABASE_URL', 'DATABASE_URL_FILE', 'APP_DATABASE', 'KEEP_ME', ...LIBPQ_VARS].map((k) => [k, '']));
  const env: NodeJS.ProcessEnv = { ...process.env, ...blanked, ORCH_HOME: home, ORCH_LOG_FORMAT: 'json', ...opts.env };
  const runDir = runPaths(repo, env).runDir;
  mkdirSync(runDir, { recursive: true });
  writeFileSync(path.join(runDir, 'graph.yaml'), 'nodes:\n  - { id: T1, deps: [], behavior: commitAndSubmit, description: d, acceptanceCriteria: [a] }\n');
  const { command, args } = daemonCommand();
  const child = spawn(command, [...args, '--repo', repo], { cwd: repo, env, stdio: ['ignore', 'ignore', 'pipe'] });
  children.push(child);
  let err = '';
  child.stderr?.on('data', (b: Buffer) => (err += b.toString()));
  const exited = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));
  return { child, runDir, checkOut, agentOut, stderr: () => err, exited };
}

/** The project's database variables, under SQLite, as a 0.5.1 user's laptop has them. */
const PROJECT_DB = { DATABASE_URL: URL, APP_DATABASE: URL, DATABASE_URL_FILE: URL_FILE, PGHOST, PGPASSWORD, KEEP_ME: 'yes' };

async function api(url: string, route: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${url}${route}`);
  return (await res.json()) as Record<string, unknown>;
}

/** Wait for the daemon, run T1 to done, and return its URL. */
async function runToDone(r: Run): Promise<string> {
  let url = '';
  await waitFor(async () => {
    const info = readDaemonJson(r.runDir);
    if (!info || info.pid !== r.child.pid) return false;
    url = info.url;
    return (await health(url)) !== undefined;
  }, 30_000, `daemon healthy; stderr: ${r.stderr().slice(-2000)}`);
  await waitFor(async () => ((await api(url, '/v1/status'))['byStatus'] as Record<string, string[]> | undefined)?.['done']?.length === 1, 60_000, `T1 done; stderr: ${r.stderr().slice(-2000)}`);
  expect(existsSync(r.checkOut)).toBe(true);
  expect(existsSync(r.agentOut)).toBe(true);
  return url;
}

function logLines(r: Run): Array<Record<string, unknown>> {
  return r
    .stderr()
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** The one startup line naming the database variables in the daemon's environment. */
function startupLine(r: Run): Record<string, unknown> {
  const lines = r.stderr().split('\n').filter((l) => l.includes('"database variables for children"'));
  expect(lines).toHaveLength(1);
  expect(lines[0]).not.toContain(PASSWORD);
  expect(lines[0]).not.toContain(PGHOST);
  expect(lines[0]).not.toContain(PGPASSWORD);
  return JSON.parse(lines[0]!) as Record<string, unknown>;
}

async function warnings(url: string): Promise<Array<{ code: string; message: string; inputs?: string[] }>> {
  const body = await api(url, '/v1/events?kinds=config.warning&limit=500');
  return (body['events'] as Array<{ payload: { code: string; message: string; inputs?: string[] } }>).map((e) => e.payload);
}

async function stop(r: Run): Promise<void> {
  if (r.child.exitCode === null && r.child.signalCode === null) r.child.kill('SIGTERM');
  await r.exited;
}

function expectPassed(text: string, runDir: string): void {
  expect(text).toMatch(new RegExp(`^DATABASE_URL=${escape(URL)}$`, 'm'));
  expect(text).toMatch(new RegExp(`^APP_DATABASE=${escape(URL)}$`, 'm'));
  expect(text).toMatch(new RegExp(`^DATABASE_URL_FILE=${escape(URL_FILE)}$`, 'm'));
  expect(text).toMatch(new RegExp(`^PGHOST=${escape(PGHOST)}$`, 'm'));
  expect(text).toMatch(new RegExp(`^PGPASSWORD=${escape(PGPASSWORD)}$`, 'm'));
  expect(text).toMatch(/^KEEP_ME=yes$/m);
  expect(text).not.toMatch(/^ORCH_URL=/m);
  expect(text).not.toMatch(/^ORCH_RUN_ID=/m);
  const home = /^ORCH_HOME=(.*)$/m.exec(text)?.[1];
  expect(home?.startsWith(runDir + path.sep)).toBe(true);
}

function expectWithheld(text: string): void {
  for (const k of ['DATABASE_URL', 'APP_DATABASE', 'DATABASE_URL_FILE', 'PGHOST', 'PGPASSWORD', 'ORCH_RUN_ID', 'ORCH_URL']) expect(text, k).not.toMatch(new RegExp(`^${k}=`, 'm'));
  expect(text).not.toContain(PASSWORD);
  expect(text).not.toContain(PGPASSWORD);
  expect(text).not.toContain(PGHOST);
  expect(text).toMatch(/^KEEP_ME=yes$/m);
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

afterEach(async () => {
  for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  children = [];
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  dirs = [];
});

describe('a SQLite daemon passes the database variables to its children (specs/state-backend "Withholding follows the store")', () => {
  it('with no store block and no ORCH_RUN_ID, the check command and the agent see DATABASE_URL, the value-equal variable, DATABASE_URL_FILE and the libpq variables; no warning; the report says it does not withhold', async () => {
    const r = start({ env: { ...PROJECT_DB } });
    const url = await runToDone(r);
    for (const file of [r.checkOut, r.agentOut]) expectPassed(readFileSync(file, 'utf8'), r.runDir);
    expect(await warnings(url)).toEqual([]);
    const report = await api(url, '/v1/config');
    expect((report['store'] as Record<string, unknown>)['withholdsDatabaseVariables']).toBe(false);
    const line = startupLine(r);
    expect(line).toMatchObject({ level: 'info', withholds: false, storeKind: 'sqlite' });
    // Exactly the non-empty names: the helper blanks every other libpq name, and blank ones are not listed.
    expect(line['names']).toEqual(['DATABASE_URL', 'DATABASE_URL_FILE', 'PGHOST', 'PGPASSWORD']);
    expect(logLines(r).filter((l) => l['level'] === 'warn' && l['inputs'] !== undefined)).toEqual([]);
    await stop(r);
  }, 90_000);

  it('with store.kind: sqlite written in the file, ORCH_RUN_ID is no Postgres input: the variables pass, ORCH_RUN_ID does not, and nothing warns', async () => {
    const r = start({ store: ['store:', '  kind: sqlite'], env: { ...PROJECT_DB, ORCH_RUN_ID: 'team-a' } });
    const url = await runToDone(r);
    for (const file of [r.checkOut, r.agentOut]) expectPassed(readFileSync(file, 'utf8'), r.runDir);
    expect(await warnings(url)).toEqual([]);
    expect(((await api(url, '/v1/config'))['store'] as Record<string, unknown>)['withholdsDatabaseVariables']).toBe(false);
    expect(startupLine(r)).toMatchObject({ withholds: false, storeKind: 'sqlite' });
    await stop(r);
  }, 90_000);

  it('with no database variable in its environment (every one blank), the daemon logs no line naming them and its report still carries the field', async () => {
    const r = start({ env: { KEEP_ME: 'yes' } });
    const url = await runToDone(r);
    expect(r.stderr()).not.toContain('"database variables for children"');
    expect(logLines(r).filter((l) => l['msg'] === 'database variables for children')).toEqual([]);
    expect(await warnings(url)).toEqual([]);
    expect(((await api(url, '/v1/config'))['store'] as Record<string, unknown>)['withholdsDatabaseVariables']).toBe(false);
    await stop(r);
  }, 90_000);
});

describe('a SQLite daemon with a Postgres input and no store.kind keeps withholding (specs/state-backend "Withholding follows the store")', () => {
  for (const c of [
    { name: 'ORCH_RUN_ID=team-a', store: undefined, runId: 'team-a', input: 'ORCH_RUN_ID' },
    { name: 'a store block with only flushDeadlineMs', store: ['store:', '  flushDeadlineMs: 120000'], runId: '', input: 'store.flushDeadlineMs' },
  ]) {
    it(`with ${c.name}, the check command and the agent see none of the database variables; one warning in the log and one config.warning event name ${c.input}`, async () => {
      const r = start({ store: c.store, env: { ...PROJECT_DB, ORCH_RUN_ID: c.runId } });
      const url = await runToDone(r);
      for (const file of [r.checkOut, r.agentOut]) expectWithheld(readFileSync(file, 'utf8'));
      const warns = logLines(r).filter((l) => l['level'] === 'warn' && l['inputs'] !== undefined);
      expect(warns).toHaveLength(1);
      expect(warns[0]!['inputs']).toEqual([c.input]);
      expect(String(warns[0]!['msg'])).toContain(c.input);
      expect(String(warns[0]!['msg'])).toContain('store.kind: postgres');
      expect(String(warns[0]!['msg'])).toContain('store.kind: sqlite');
      const events = await warnings(url);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ code: 'postgresInputsUnderSqlite', inputs: [c.input] });
      expect(events[0]!.message).toContain(c.input);
      expect(((await api(url, '/v1/config'))['store'] as Record<string, unknown>)['withholdsDatabaseVariables']).toBe(true);
      const line = startupLine(r);
      expect(line).toMatchObject({ level: 'info', withholds: true, storeKind: 'sqlite' });
      // Exactly the non-empty names: the helper blanks every other libpq name, and blank ones are not listed.
    expect(line['names']).toEqual(['DATABASE_URL', 'DATABASE_URL_FILE', 'PGHOST', 'PGPASSWORD']);
      await stop(r);
    }, 90_000);
  }
});
