/**
 * A reaping shutdown with real agent processes that ignore SIGTERM: every launch gets SIGTERM in one pass, the wait
 * is one kill grace for all of them, and the daemon finishes before its shutdown deadline.
 * See specs/operator-control "Shutdown: launches reaped together" and specs/health-monitoring
 * "Usage accounting: launches reaped together".
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeCodeRunner } from '../../src/runner/claude-code.js';
import { pidAlive } from '../../src/runner/subprocess.js';
import { daemonCommand, health } from '../../src/runs/lifecycle.js';
import { readDaemonJson, runPaths } from '../../src/runs/runDir.js';
import { SqliteStore } from '../../src/state/sqlite.js';
import type { Launch } from '../../src/state/store.js';
import { gitIn, makeRepo, makeSlice, type SliceHarness, tsxLoader } from './harness.js';

const termAgent = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../agents/term-agent.ts');

let dirs: string[] = [];
let children: ChildProcess[] = [];
let slices: SliceHarness[] = [];

function fresh(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'orch-reap-'));
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

function groupGone(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/** The agents' own directories under `dir`: one per launch, with its pid and, after a SIGTERM, its `term` time. */
function agentsIn(dir: string): Array<{ launchId: string; pid?: number; term?: number }> {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const own = path.join(dir, e.name);
      const read = (f: string) => (existsSync(path.join(own, f)) ? Number(readFileSync(path.join(own, f), 'utf8')) : undefined);
      return { launchId: e.name, pid: read('pid'), term: read('term') };
    });
}

/** SIGKILL every agent recorded under `dir` whose command line still names it (never a recycled pid). */
function killAgents(dir: string): void {
  const real = existsSync(dir) ? realpathSync(dir) : dir;
  for (const a of agentsIn(dir)) {
    if (!a.pid || !pidAlive(a.pid)) continue;
    let command = '';
    try {
      command = execFileSync('ps', ['-o', 'command=', '-p', String(a.pid)], { encoding: 'utf8' });
    } catch {
      continue;
    }
    if (command.includes(dir) || command.includes(real)) {
      try {
        process.kill(a.pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
  }
}

const agentDirs: string[] = [];

afterEach(async () => {
  for (const d of agentDirs.splice(0)) killAgents(d);
  for (const c of children) if (c.pid && pidAlive(c.pid)) c.kill('SIGKILL');
  children = [];
  for (const h of slices.splice(0)) await h.cleanup();
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
  dirs = [];
});

const graphOf = (ids: string[]) => `nodes:\n${ids.map((id) => `  - { id: ${id}, deps: [], description: d, acceptanceCriteria: [a] }`).join('\n')}\n`;

describe('reaping shutdown with agents that ignore SIGTERM', () => {
  it('signals three launches in one pass, records the usage each printed after SIGTERM, and ends them reaped', async () => {
    const agents = fresh();
    agentDirs.push(agents);
    const h = await makeSlice({
      graph: graphOf(['T1', 'T2', 'T3']),
      config: { capacity: 3, leaseTtlMs: 60_000, runnerCommand: `node --import ${tsxLoader} ${termAgent} ${agents} {launchId}` },
    });
    slices.push(h);
    const reader = new ClaudeCodeRunner({ command: 'true', logDir: path.join(h.config.dataDir, 'logs'), retryWindowMs: 1000 });
    Object.assign(h.runner, { readUsage: (launch: Launch) => reader.readUsage(launch) });

    await h.waitFor(() => h.store.listLaunches({ status: 'live' }).length === 3);
    const launches = h.store.listLaunches({ status: 'live' });
    await waitFor(() => launches.every((l) => existsSync(path.join(agents, l.launchId, 'ready'))), 20_000);

    await h.orch.stop({ reap: true });

    const terms = launches.map((l) => Number(readFileSync(path.join(agents, l.launchId, 'term'), 'utf8')));
    expect(Math.max(...terms) - Math.min(...terms)).toBeLessThan(500);
    for (const l of launches) {
      expect(groupGone(l.pid!)).toBe(true);
      expect(h.store.getLaunch(l.launchId)).toMatchObject({ status: 'ended', endReason: 'reaped', costUsd: 0.25, usageSource: 'claude-code' });
      expect(h.store.listEvents({ kind: 'launch.usage', launchId: l.launchId })).toHaveLength(1);
    }
  });

  it('a daemon with five live launches gets SIGTERM and exits 0 before its deadline, every launch reaped', async () => {
    const home = fresh();
    const agents = fresh();
    agentDirs.push(agents);
    const repo = realpathSync(makeRepo(fresh()));
    const lines = [`runnerCommand: "node --import ${tsxLoader} ${termAgent} ${agents} {launchId}"`, 'tickIntervalMs: 100', 'leaseTtlMs: 60000', 'retryWindowMs: 10000', 'capacity: 5'];
    writeFileSync(path.join(repo, 'orchestrator.yaml'), `${lines.join('\n')}\n`);
    gitIn(repo, 'add', 'orchestrator.yaml');
    gitIn(repo, 'commit', '-q', '-m', 'config');
    const env = { ...process.env, ORCH_HOME: home, ORCH_LOG_FORMAT: 'json' };
    const runDir = runPaths(repo, env).runDir;
    mkdirSync(runDir, { recursive: true });
    writeFileSync(path.join(runDir, 'graph.yaml'), graphOf(['T1', 'T2', 'T3', 'T4', 'T5']));

    const { command, args } = daemonCommand();
    const child = spawn(command, [...args, '--repo', repo, '--reap-on-exit'], { cwd: repo, env, stdio: ['ignore', 'ignore', 'pipe'] });
    children.push(child);
    let stderr = '';
    child.stderr?.on('data', (b: Buffer) => (stderr += b.toString()));
    const exited = new Promise<{ code: number | null; at: number }>((resolve) => child.on('close', (code) => resolve({ code, at: Date.now() })));

    let url = '';
    await waitFor(async () => {
      const info = readDaemonJson(runDir);
      if (!info || info.pid !== child.pid) return false;
      url = info.url;
      return (await health(url)) !== undefined;
    }, 20_000);
    let live: Launch[] = [];
    const store = new SqliteStore(path.join(runDir, 'store.sqlite'));
    try {
      await waitFor(() => {
        live = store.listLaunches({ status: 'live' });
        return live.length === 5 && live.every((l) => existsSync(path.join(agents, l.launchId, 'ready')));
      }, 40_000);
    } finally {
      store.close();
    }

    const sentAt = Date.now();
    child.kill('SIGTERM');
    const exit = await exited;
    expect(exit.code).toBe(0);
    expect(exit.at - sentAt).toBeLessThan(8000);
    expect(stderr).not.toContain('shutdown grace elapsed');
    expect(readDaemonJson(runDir)?.exit).toMatchObject({ reason: 'signal', reap: true });
    for (const l of live) expect(groupGone(l.pid!)).toBe(true);

    const after = new SqliteStore(path.join(runDir, 'store.sqlite'));
    try {
      const ended = after.listLaunches({ status: 'ended' }).filter((l) => l.endReason === 'reaped');
      expect(ended.map((l) => l.launchId).sort()).toEqual(live.map((l) => l.launchId).sort());
      expect(after.listEvents({ kind: 'launch.usage' })).toHaveLength(5);
    } finally {
      after.close();
    }
  }, 60_000);
});
