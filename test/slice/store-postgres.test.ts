/**
 * A daemon on `store.kind: postgres` (ORC-20), as real processes against the test database: a restart on an empty
 * data directory serves the same state, a rejected graph stays rejected across a restart, the database password is
 * never printed, the lease-versus-deadline check refuses a start, and the two fatal paths exit non-zero.
 * Skipped without Postgres (see test/state/pg-db.ts). See specs/state-backend and specs/graph-import.
 */
import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { daemonCommand, health, startDaemon, stopDaemon } from '../../src/runs/lifecycle.js';
import { readDaemonJson, runPaths } from '../../src/runs/runDir.js';
import { adminClient, dropRun, pgAvailable, pgSource, stopTestPostgres, testDatabase } from '../state/pg-db.js';
import { gitIn, makeRepo, tsxLoader } from './harness.js';

const execFileP = promisify(execFile);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const PASSWORD = 'pw-Zq9-s3cret';

let dirs: string[] = [];
let children: ChildProcess[] = [];
let runIds: string[] = [];

function fresh(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'orch-pgd-'));
  dirs.push(d);
  return d;
}

async function waitFor(pred: () => Promise<boolean> | boolean, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('waitFor timed out');
}

/** The test database as a URL with a password (trust authentication ignores it). */
async function databaseUrl(): Promise<string> {
  const conn = await testDatabase();
  if (typeof conn === 'string') {
    const u = new URL(conn);
    if (!u.password) u.password = PASSWORD;
    return u.toString();
  }
  return `postgresql://${conn.user}:${PASSWORD}@${encodeURIComponent(String(conn.host))}:${conn.port}/${conn.database}`;
}

function secretOf(url: string): string {
  return decodeURIComponent(new URL(url).password);
}

interface Run {
  repo: string;
  home: () => string;
  env: () => NodeJS.ProcessEnv;
  /** A new, empty ORCH_HOME: the next start has no data directory. */
  wipe(): void;
}

async function makeRun(lines: string[]): Promise<Run> {
  const repo = realpathSync(makeRepo(fresh()));
  const yaml = ['runner:', '  mode: pull', 'daemon:', '  idleExitMs: 0', 'tickIntervalMs: 100', 'checkCommand: "true"', ...lines];
  writeFileSync(path.join(repo, 'orchestrator.yaml'), `${yaml.join('\n')}\n`);
  gitIn(repo, 'add', 'orchestrator.yaml');
  gitIn(repo, 'commit', '-q', '-m', 'config');
  const url = await databaseUrl();
  let home = fresh();
  const run: Run = {
    repo,
    home: () => home,
    env: () => ({ ...process.env, ORCH_HOME: home, DATABASE_URL: url, ORCH_LOG_FORMAT: 'json', ORCH_URL: '' }),
    wipe: () => {
      rmSync(home, { recursive: true, force: true });
      home = fresh();
    },
  };
  return run;
}

const STORE = (deadline = 120_000) => ['store:', '  kind: postgres', `  flushDeadlineMs: ${deadline}`];

interface Fg {
  child: ChildProcess;
  stderr: () => string;
  exited: Promise<{ code: number | null; at: number }>;
}

/** The daemon in the foreground, keeping its stderr. */
function foreground(run: Run): Fg {
  const { command, args } = daemonCommand();
  const child = spawn(command, [...args, '--repo', run.repo], { cwd: run.repo, env: run.env(), stdio: ['ignore', 'ignore', 'pipe'] });
  children.push(child);
  let err = '';
  child.stderr?.on('data', (b: Buffer) => (err += b.toString()));
  const exited = new Promise<{ code: number | null; at: number }>((resolve) => child.on('close', (code) => resolve({ code, at: Date.now() })));
  return { child, stderr: () => err, exited };
}

async function urlOfFg(run: Run, d: Fg): Promise<string> {
  let url = '';
  await waitFor(async () => {
    const info = readDaemonJson(runPaths(run.repo, run.env()).runDir);
    if (!info || info.pid !== d.child.pid) return false;
    url = info.url;
    return (await health(url)) !== undefined;
  }, 30_000);
  return url;
}

async function api(url: string, method: string, route: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${url}${route}`, { method, headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const GRAPH = [
  { id: 'T1', deps: [], description: 'first', acceptanceCriteria: ['a'], url: 'https://tracker.example/T1', trackerState: 'open' },
  { id: 'T2', deps: ['T1'], description: 'second', acceptanceCriteria: ['b'], url: 'https://tracker.example/T2', trackerState: 'open' },
];

/** What a client sees of the run's state: tasks, launches, events and the outbox. */
async function served(url: string, upToSeq?: number) {
  const status = (await api(url, 'GET', '/v1/status')).body;
  const events = (await api(url, 'GET', '/v1/events?after=0&limit=500')).body['events'] as Array<Record<string, unknown>>;
  const outbox = (await api(url, 'GET', '/v1/outbox?limit=500')).body['effects'];
  return {
    graphRev: status['graphRev'],
    byStatus: status['byStatus'],
    claimable: status['claimable'] as string[],
    launches: await Promise.all(['T1', 'T2'].map(async (t) => {
      const r = await api(url, 'GET', `/v1/tasks/${t}/logs`);
      return r.status === 200 ? { taskId: t, launchId: r.body['launchId'], launchNo: r.body['launchNo'] } : { taskId: t, none: true };
    })),
    events: events.filter((e) => upToSeq === undefined || Number(e['seq']) <= upToSeq),
    outbox,
    latestSeq: Math.max(0, ...events.map((e) => Number(e['seq']))),
  };
}

afterEach(async () => {
  for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  children = [];
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  dirs = [];
  if (pgAvailable) for (const r of runIds.splice(0)) await dropRun(r).catch(() => undefined);
});

afterAll(async () => {
  await stopTestPostgres();
});

/** The run id a repository's run is keyed by in Postgres. */
function runIdOfRepo(run: Run): string {
  return path.basename(runPaths(run.repo, run.env()).runDir);
}

describe.skipIf(!pgAvailable)('daemon on store.kind postgres', () => {
  it('restarted on an empty data directory it serves the same tasks, launches, events and outbox; an incompatible graph stays rejected across the restart; the password is never printed', async () => {
    const run = await makeRun([...STORE(), 'leaseTtlMs: 600000', 'tracker:', '  enabled: always']);
    runIds.push(runIdOfRepo(run));
    const secret = secretOf(String(run.env()['DATABASE_URL']));

    // Start: the start output shows the store with the password removed.
    const started = await startDaemon({ repo: run.repo, env: run.env() });
    const startOut = JSON.stringify(started);
    expect(started.store).toMatchObject({ kind: 'postgres', urlSource: 'environment', flushDeadlineMs: 120_000 });
    expect(started.store?.url).toMatch(/^postgresql:\/\/postgres@/);
    expect(startOut).not.toContain(secret);
    const url = started.url;

    // The graph goes to the store's proposed slot; no file is written.
    const put = await api(url, 'PUT', '/v1/graph', { nodes: GRAPH, tracker: { kind: 'linear', workspace: 'acme' } });
    expect(put.body).toMatchObject({ accepted: true, slot: 'proposed' });
    expect(existsSync(started.graphPath)).toBe(false);
    await api(url, 'POST', '/v1/tick');
    await waitFor(async () => ((await api(url, 'GET', '/v1/status')).body['claimable'] as unknown[]).length === 1);
    await waitFor(async () => ((await api(url, 'GET', '/v1/outbox')).body['effects'] as unknown[]).length > 0);
    const acceptedRev = (await api(url, 'GET', '/v1/status')).body['graphRev'];

    // An incompatible graph (T1 is running and the new graph drops it) is rejected and the accepted one stays.
    const bad = await api(url, 'PUT', '/v1/graph', { nodes: [{ id: 'T9', deps: [], description: 'x', acceptanceCriteria: ['y'] }] });
    expect(bad.body).toMatchObject({ accepted: false, active: acceptedRev });
    expect((bad.body['reasons'] as string[]).length).toBeGreaterThan(0);

    // Every surface that prints resolved config: the route, the CLI, config.json.
    const cfg = await api(url, 'GET', '/v1/config');
    expect(cfg.body['store']).toMatchObject({ kind: 'postgres', flushDeadlineMs: 120_000 });
    expect(JSON.stringify(cfg.body)).not.toContain(secret);
    const ctl = await execFileP('node', ['--import', tsxLoader, path.join(root, 'src/operator/cli.ts'), '--url', url, 'config'], { cwd: root, env: run.env() });
    expect(ctl.stdout).toContain('"kind": "postgres"');
    expect(ctl.stdout).not.toContain(secret);
    const runDir = started.runDir;
    expect(readFileSync(path.join(runDir, 'config.json'), 'utf8')).not.toContain(secret);
    // A Postgres run keeps no store file.
    expect(existsSync(path.join(runDir, 'store.sqlite'))).toBe(false);

    const before = await served(url);
    expect(before.byStatus).toMatchObject({ running: ['T1'], unstarted: ['T2'] });
    expect(before.claimable).toHaveLength(1);
    expect((before.outbox as unknown[]).length).toBeGreaterThan(0);
    await stopDaemon({ repo: run.repo, env: run.env() });
    const logBefore = readFileSync(path.join(runDir, 'daemon.log'), 'utf8');
    expect(logBefore).toContain('"msg":"store opened"');
    expect(logBefore).not.toContain(secret);

    // An empty data directory: a fresh run directory, no worktrees, no store file.
    await waitFor(async () => (await health(url)) === undefined, 15_000);
    run.wipe();
    const again = await startDaemon({ repo: run.repo, env: run.env() });
    const after = await served(again.url, before.latestSeq);
    expect(after.graphRev).toBe(acceptedRev);
    expect(after.events).toEqual(before.events);
    expect(after.outbox).toEqual(before.outbox);
    expect(after.claimable).toEqual(before.claimable);
    expect(after.launches).toEqual(before.launches);
    expect(after.byStatus).toEqual(before.byStatus);
    // The rejected proposal is still the proposed one and still reported rejected, without being evaluated again
    // (specs/graph-import "Rejected proposal stays rejected"); the accepted graph is unchanged.
    const st = (await api(again.url, 'GET', '/v1/status')).body;
    expect(st['graphRev']).toBe(acceptedRev);
    expect(st['graphRejected']).toMatchObject({ reasons: expect.any(Array) });
    // The claimable launch's worktree was prepared again for the same launch.
    const reprepared = async () => ((await api(again.url, 'GET', `/v1/events?after=${before.latestSeq}&limit=500`)).body['events'] as Array<Record<string, unknown>>).filter((e) => e['kind'] === 'launch.reprepared');
    await waitFor(async () => (await reprepared()).length > 0, 15_000);
    expect((await reprepared()).map((e) => e['launchId'])).toEqual([before.launches[0]!.launchId]);
    expect(before.launches[0]!.launchId).toEqual(expect.any(String));
    await stopDaemon({ repo: run.repo, env: run.env() });
    const logAfter = readFileSync(path.join(again.runDir, 'daemon.log'), 'utf8');
    expect(logAfter).not.toContain(secret);
  }, 120_000);

  it('a lease TTL below store.flushDeadlineMs fails the start, naming both values', async () => {
    const run = await makeRun([...STORE(120_000), 'leaseTtlMs: 60000']);
    const d = foreground(run);
    const { code } = await d.exited;
    expect(code).not.toBe(0);
    expect(d.stderr()).toContain('leaseTtlMs (60000)');
    expect(d.stderr()).toContain('store.flushDeadlineMs (120000)');
    expect(d.stderr()).not.toContain(secretOf(String(run.env()['DATABASE_URL'])));
  }, 30_000);

  it.skipIf(pgSource !== 'cluster')('with its Postgres session stopped the daemon exits non-zero after flushDeadlineMs and logs the unflushed batch count', async () => {
    const deadline = 1_500;
    const run = await makeRun([...STORE(deadline), `leaseTtlMs: ${3 * deadline}`]);
    runIds.push(runIdOfRepo(run));
    const d = foreground(run);
    const url = await urlOfFg(run, d);
    const opened = d
      .stderr()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((l) => l['msg'] === 'store opened');
    const pid = Number(opened?.['backendPid']);
    expect(pid).toBeGreaterThan(0);
    process.kill(pid, 'SIGSTOP');
    try {
      const t0 = Date.now();
      // A write whose batch can never land; the response waits for durability, so it is not awaited.
      void fetch(`${url}/v1/pause`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => undefined);
      const { code, at } = await d.exited;
      expect(code).not.toBe(0);
      expect(at - t0).toBeGreaterThanOrEqual(deadline - 100);
      const fatal = d
        .stderr()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .find((l) => l['msg'] === 'store fatal: exiting');
      expect(fatal).toMatchObject({ reason: 'deadline', unflushedBatches: expect.any(Number) });
      expect(Number(fatal!['unflushedBatches'])).toBeGreaterThanOrEqual(1);
    } finally {
      process.kill(pid, 'SIGCONT');
    }
  }, 60_000);

  it.skipIf(pgSource !== 'cluster')('SIGTERM while its Postgres session is stopped exits non-zero and logs the unflushed batch count, not fenced', async () => {
    const deadline = 60_000;
    const run = await makeRun([...STORE(deadline), `leaseTtlMs: ${3 * deadline}`]);
    runIds.push(runIdOfRepo(run));
    const d = foreground(run);
    const url = await urlOfFg(run, d);
    const lines = () =>
      d
        .stderr()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    const pid = Number(lines().find((l) => l['msg'] === 'store opened')?.['backendPid']);
    expect(pid).toBeGreaterThan(0);
    process.kill(pid, 'SIGSTOP');
    try {
      void fetch(`${url}/v1/pause`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 300));
      d.child.kill('SIGTERM');
      const { code } = await d.exited;
      expect(code).toBe(1);
      const lost = lines().find((l) => typeof l['msg'] === 'string' && (l['msg'] as string).includes('unflushed batches'));
      expect(lost).toMatchObject({ unflushedBatches: expect.any(Number) });
      expect(Number(lost!['unflushedBatches'])).toBeGreaterThanOrEqual(1);
      expect(lines().find((l) => l['msg'] === 'store fatal: exiting')).toBeUndefined();
    } finally {
      process.kill(pid, 'SIGCONT');
    }
  }, 60_000);

  it('when its lock-holding session is terminated the daemon exits at once', async () => {
    const run = await makeRun([...STORE(600_000), 'leaseTtlMs: 1800000']);
    runIds.push(runIdOfRepo(run));
    const d = foreground(run);
    await urlOfFg(run, d);
    const line = d
      .stderr()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((l) => l['msg'] === 'store opened');
    const admin = await adminClient();
    const t0 = Date.now();
    try {
      await admin.query('SELECT pg_terminate_backend($1)', [Number(line?.['backendPid'])]);
    } finally {
      await admin.end();
    }
    const { code, at } = await d.exited;
    expect(code).not.toBe(0);
    expect(at - t0).toBeLessThan(5_000);
    expect(d.stderr()).toContain('"reason":"fenced"');
    expect(d.stderr()).toContain('"unflushedBatches":0');
  }, 60_000);

  it('the CLI and revival answer for a Postgres run without a store file: remote, reached by --url or ORCH_URL', async () => {
    const run = await makeRun([...STORE(), 'leaseTtlMs: 600000']);
    runIds.push(runIdOfRepo(run));
    const started = await startDaemon({ repo: run.repo, env: run.env() });
    const runDir = started.runDir;
    await stopDaemon({ repo: run.repo, env: run.env() });
    await waitFor(async () => (await health(started.url)) === undefined, 15_000);
    // The last exit was a stop; drop the exit record as a crash would, so revival is asked.
    for (const f of readdirSync(runDir)) if (f === 'daemon.json') rmSync(path.join(runDir, f));
    const viaDataDir = await execFileP('node', ['--import', tsxLoader, path.join(root, 'src/operator/cli.ts'), '--data-dir', runDir, 'status'], { cwd: root, env: run.env() }).catch((e: { stderr: string; code: number }) => e);
    expect((viaDataDir as { code: number }).code).not.toBe(0);
    expect((viaDataDir as { stderr: string }).stderr).toContain('keeps its state in Postgres and is remote');
    const viaRepo = await execFileP('node', ['--import', tsxLoader, path.join(root, 'src/operator/cli.ts'), '--repo', run.repo, 'status'], { cwd: root, env: run.env() }).catch((e: { stderr: string; code: number }) => e);
    expect((viaRepo as { stderr: string }).stderr).toContain('keeps its state in Postgres and is remote');
  }, 60_000);
});
