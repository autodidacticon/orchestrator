/**
 * Container-mode lifecycle against a real daemon process: SIGTERM stops it
 * cleanly with an exit record, `daemon.idleExitMs: 0` keeps it alive, and
 * ORCH_LOG_FORMAT=json makes every stderr line a JSON object. See
 * specs/operator-control "Container mode".
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pidAlive } from '../../src/runner/subprocess.js';
import { daemonCommand, health } from '../../src/runs/lifecycle.js';
import { readDaemonJson, runPaths } from '../../src/runs/runDir.js';
import { SqliteStore } from '../../src/state/sqlite.js';
import { gitIn, makeRepo, scriptedAgent, tsxLoader } from './harness.js';

let dirs: string[] = [];
let children: ChildProcess[] = [];

function fresh(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'orch-container-'));
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

interface Daemon {
  child: ChildProcess;
  home: string;
  repo: string;
  runDir: string;
  stderr: () => string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null; at: number }>;
}

/** Run the daemon in the foreground, the way a container entrypoint does, keeping the process handle. */
function runDaemon(config: string[]): Daemon {
  const home = fresh();
  const repo = realpathSync(makeRepo(fresh()));
  const lines = [`runnerCommand: "node --import ${tsxLoader} ${scriptedAgent} {briefJson}"`, 'tickIntervalMs: 100', 'leaseTtlMs: 8000', 'retryWindowMs: 10000', 'capacity: 1', ...config];
  writeFileSync(path.join(repo, 'orchestrator.yaml'), `${lines.join('\n')}\n`);
  gitIn(repo, 'add', 'orchestrator.yaml');
  gitIn(repo, 'commit', '-q', '-m', 'config');
  const runDir = runPaths(repo, { ...process.env, ORCH_HOME: home }).runDir;
  mkdirSync(runDir, { recursive: true });
  writeFileSync(path.join(runDir, 'graph.yaml'), 'nodes:\n  - { id: T1, deps: [], behavior: commitAndSubmit, description: d, acceptanceCriteria: [a] }\n');
  return spawnDaemon(home, repo);
}

/** Start a daemon on an existing run (a container restart). */
function spawnDaemon(home: string, repo: string): Daemon {
  const env = { ...process.env, ORCH_HOME: home, ORCH_LOG_FORMAT: 'json' };
  const runDir = runPaths(repo, env).runDir;
  const { command, args } = daemonCommand();
  const child = spawn(command, [...args, '--repo', repo], { cwd: repo, env, stdio: ['ignore', 'ignore', 'pipe'] });
  children.push(child);
  let err = '';
  child.stderr?.on('data', (b: Buffer) => (err += b.toString()));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; at: number }>((resolve) => child.on('close', (code, signal) => resolve({ code, signal, at: Date.now() })));
  return { child, home, repo, runDir, stderr: () => err, exited };
}

async function urlOf(d: Daemon): Promise<string> {
  let url = '';
  await waitFor(async () => {
    const info = readDaemonJson(d.runDir);
    if (!info || info.pid !== d.child.pid) return false;
    url = info.url;
    return (await health(url)) !== undefined;
  }, 20_000);
  return url;
}

function expectJsonLines(stderr: string): void {
  const lines = stderr.split('\n').filter((l) => l.length > 0);
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) {
    const rec = JSON.parse(line) as Record<string, unknown>;
    expect(typeof rec['ts']).toBe('string');
    expect(['info', 'warn', 'error']).toContain(rec['level']);
    expect(typeof rec['msg']).toBe('string');
  }
}

afterEach(() => {
  for (const c of children) if (c.pid && pidAlive(c.pid)) c.kill('SIGKILL');
  children = [];
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
  dirs = [];
});

describe('container-mode daemon lifecycle', () => {
  it('SIGTERM during a verifier check finishes the job, closes the server, writes the exit record, and exits 0 within ten seconds', async () => {
    const d = runDaemon(['checkCommand: "sleep 2"']);
    const url = await urlOf(d);
    // Both files are written by the daemon itself, though nothing spawned it.
    expect(readFileSync(path.join(d.runDir, 'daemon.pid'), 'utf8').trim()).toBe(String(d.child.pid));
    const store = new SqliteStore(path.join(d.runDir, 'store.sqlite'));
    try {
      await waitFor(() => store.listJobs({ status: 'checking' }).length > 0, 30_000);
    } finally {
      store.close();
    }
    const sentAt = Date.now();
    d.child.kill('SIGTERM');
    const exit = await d.exited;
    expect(exit.code).toBe(0);
    expect(exit.at - sentAt).toBeLessThan(10_000);
    expect(await health(url, 500)).toBeUndefined();

    const info = readDaemonJson(d.runDir);
    expect(info?.exit).toMatchObject({ reason: 'signal', reap: false });
    // The in-flight job ran to a result: nothing is left mid-check or mid-publish, and the published sha is the integration head.
    const after = new SqliteStore(path.join(d.runDir, 'store.sqlite'));
    try {
      const jobs = after.listJobs();
      expect(jobs).toHaveLength(1);
      expect(['checking', 'verified', 'publishing']).not.toContain(jobs[0]?.status);
      expect(jobs[0]?.status).toBe('published');
      expect(gitIn(d.repo, 'rev-parse', 'main')).toBe(jobs[0]?.publishedSha);
    } finally {
      after.close();
    }
    const verifyDir = path.join(d.runDir, 'verify');
    expect(existsSync(verifyDir) ? readdirSync(verifyDir) : []).toEqual([]);
    const msgs = d.stderr().split('\n').filter(Boolean).map((l) => (JSON.parse(l) as { msg: string }).msg);
    expect(msgs).toContain('shutting down');
    expect(msgs).toContain('stopped');
    expectJsonLines(d.stderr());

    // The recorded result is applied by the first tick after a restart (a new pod), with nothing re-checked or re-published.
    const head = gitIn(d.repo, 'rev-parse', 'main');
    const next = spawnDaemon(d.home, d.repo);
    const nextUrl = await urlOf(next);
    await waitFor(async () => Boolean((await health(nextUrl))?.['finished']), 20_000);
    const final = new SqliteStore(path.join(d.runDir, 'store.sqlite'));
    try {
      expect(final.listJobs().map((j) => [j.status, j.applied])).toEqual([['published', true]]);
      expect(final.getEntry('T1')?.status.kind).toBe('done');
    } finally {
      final.close();
    }
    expect(gitIn(d.repo, 'rev-parse', 'main')).toBe(head);
    next.child.kill('SIGTERM');
    expect((await next.exited).code).toBe(0);
  }, 60_000);

  it('stays alive past a short idle window when daemon.idleExitMs is 0', async () => {
    const d = runDaemon(['checkCommand: "true"', 'daemon: { idleExitMs: 0 }']);
    const url = await urlOf(d);
    await waitFor(async () => Boolean((await health(url))?.['finished']), 30_000);
    // Quiescent and quiet (probes are not activity) for twice the 1500 ms window that makes a daemon exit in test/runs/lifecycle.test.ts.
    await new Promise((r) => setTimeout(r, 3_000));
    const status = await health(url);
    expect(status?.['idle']).toMatchObject({ quiescent: true, exitAfterMs: 0 });
    expect(pidAlive(d.child.pid as number)).toBe(true);
    expect(readDaemonJson(d.runDir)?.exit).toBeUndefined();
    const store = new SqliteStore(path.join(d.runDir, 'store.sqlite'));
    try {
      expect(store.listEvents({ kind: 'daemon.idleExit' })).toEqual([]);
    } finally {
      store.close();
    }
    d.child.kill('SIGTERM');
    expect((await d.exited).code).toBe(0);
    expect(readDaemonJson(d.runDir)?.exit?.reason).toBe('signal');
    expectJsonLines(d.stderr());
  }, 60_000);
});
