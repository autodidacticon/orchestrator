/**
 * Crash-injection harness: runs the real daemon as a subprocess, kills it at a
 * named crash point via ORCH_CRASH_AT, restarts it, and checks convergence.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CRASH_EXIT_CODE } from '../../src/crash.js';
import { parseGraph } from '../../src/graph/load.js';
import { pidAlive } from '../../src/runner/subprocess.js';
import { SqliteStore } from '../../src/state/sqlite.js';
import type { Entry } from '../../src/state/status.js';
import { commitTrailers } from '../../src/workspace/git.js';
import { freePort, gitIn, makeRepo, scriptedAgent, tsxLoader } from '../slice/harness.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const mainTs = path.resolve(here, '../../src/main.ts');

export const crashGraph = `nodes:
  - { id: T1, title: Schema migration, description: "add the schema migration", acceptanceCriteria: [migrates], deps: [],   behavior: commitAndSubmit, url: "https://tracker.example/T1" }
  - { id: T2, title: Feature A API,    description: "build feature A API",      acceptanceCriteria: [serves A], deps: [T1], behavior: commitAndSubmit, url: "https://tracker.example/T2" }
  - { id: T3, title: Feature B API,    description: "build feature B API",      acceptanceCriteria: [serves B], deps: [T1], behavior: commitAndSubmit, url: "https://tracker.example/T3" }
  - { id: T4, title: Feature A UI,     description: "build feature A UI",       acceptanceCriteria: [renders A], deps: [T2], behavior: commitAndSubmit, url: "https://tracker.example/T4" }
  - { id: T5, title: Changelog,        description: "write the changelog",      acceptanceCriteria: [lists changes], deps: [],   behavior: commitAndSubmit, url: "https://tracker.example/T5" }
  - { id: MVP, kind: milestone, gated: true, deps: [T3, T4], url: "https://tracker.example/MVP" }
`;

export interface CrashRun {
  dir: string;
  repo: string;
  configPath: string;
  dataDir: string;
  pidlog: string;
  baseline: string;
  daemonLog: string;
  start(env?: Record<string, string>): ChildProcess;
  waitExit(child: ChildProcess, timeoutMs?: number): Promise<number | null>;
  stop(child: ChildProcess): Promise<void>;
  entries(): Map<string, Entry>;
  terminal(): boolean;
  waitTerminal(timeoutMs?: number): Promise<void>;
  cleanup(): void;
}

export async function setupCrashRun(): Promise<CrashRun> {
  const dir = mkdtempSync(path.join(tmpdir(), 'orch-crash-'));
  const repo = makeRepo(dir);
  const dataDir = path.join(dir, 'run');
  mkdirSync(dataDir);
  const graphPath = path.join(dir, 'graph.yaml');
  writeFileSync(graphPath, crashGraph);
  const pidlog = path.join(dir, 'pids.log');
  const port = await freePort();
  const configPath = path.join(dir, 'orchestrator.yaml');
  writeFileSync(
    configPath,
    [
      `repoPath: ${repo}`,
      `graphPath: ${graphPath}`,
      `dataDir: ${dataDir}`,
      'integrationBranch: main',
      `apiPort: ${port}`,
      'capacity: 3',
      'tickIntervalMs: 150',
      'leaseTtlMs: 8000',
      'retryWindowMs: 2500',
      'checkCommand: "true"',
      `runnerCommand: "node --import ${tsxLoader} ${scriptedAgent} {briefJson}"`,
      'tracker:',
      '  enabled: always',
    ].join('\n'),
  );
  const baseline = gitIn(repo, 'rev-parse', 'main');
  const daemonLog = path.join(dir, 'daemon.log');
  const graph = parseGraph(crashGraph);

  const run: CrashRun = {
    dir,
    repo,
    configPath,
    dataDir,
    pidlog,
    baseline,
    daemonLog,
    start: (env = {}) => {
      const fd = openSync(daemonLog, 'a');
      const extra = (env['ORCH_ARGS'] ?? '').split(' ').filter(Boolean);
      const child = spawn('node', ['--import', tsxLoader, mainTs, '--config', configPath, ...extra], {
        env: { ...process.env, ORCH_PIDLOG: pidlog, ...env },
        stdio: ['ignore', fd, fd],
      });
      return child;
    },
    waitExit: (child, timeoutMs = 60_000) =>
      new Promise((resolve) => {
        const t = setTimeout(() => resolve(null), timeoutMs);
        child.once('exit', (code) => {
          clearTimeout(t);
          resolve(code);
        });
      }),
    stop: async (child) => {
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      const code = await run.waitExit(child, 10_000);
      if (code === null) child.kill('SIGKILL');
    },
    entries: () => {
      const store = new SqliteStore(path.join(dataDir, 'store.sqlite'));
      try {
        return store.allEntries();
      } finally {
        store.close();
      }
    },
    terminal: () => {
      if (!existsSync(path.join(dataDir, 'store.sqlite'))) return false;
      const e = run.entries();
      for (const node of graph.nodes.values()) {
        const s = e.get(node.id)?.status.kind;
        if (node.kind === 'task' && s !== 'done') return false;
        if (node.kind === 'milestone' && s !== 'submitted' && s !== 'done') return false;
      }
      return true;
    },
    waitTerminal: async (timeoutMs = 60_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (run.terminal()) return;
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new Error(`terminal state not reached; daemon log:\n${readFileSync(daemonLog, 'utf8').slice(-4000)}`);
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
  return run;
}

export { CRASH_EXIT_CODE };

export interface InvariantReport {
  trailerCommitsPerTask: Record<string, number>;
  foreign: string[];
  worktrees: string[];
  tempDirs: string[];
  liveLaunches: number;
  pidOverlaps: string[];
  alivePids: number[];
  byStatus: Record<string, string[]>;
  /** Outbox rows per issue in id order: a state name or `comment`. */
  outboxSummary: Record<string, string[]>;
  /** Outbox rows whose source event is not a transition in the event log. */
  outboxOrphans: number[];
}

export async function checkInvariants(run: CrashRun): Promise<InvariantReport> {
  const commits = gitIn(run.repo, 'rev-list', '--first-parent', `${run.baseline}..main`).split('\n').filter(Boolean);
  const perTask: Record<string, number> = {};
  const foreign: string[] = [];
  for (const sha of commits) {
    const t = await commitTrailers(run.repo, sha);
    const task = t['Orchestrator-Task'];
    if (!task || !t['Orchestrator-Launch']) foreign.push(sha);
    else perTask[task] = (perTask[task] ?? 0) + 1;
  }
  const worktrees = gitIn(run.repo, 'worktree', 'list', '--porcelain')
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice(9))
    .filter((p) => realpathSync(p) !== realpathSync(run.repo));
  const verifyDir = path.join(run.dataDir, 'verify');
  const tempDirs = existsSync(verifyDir) ? readdirSafe(verifyDir) : [];

  const store = new SqliteStore(path.join(run.dataDir, 'store.sqlite'));
  let liveLaunches = 0;
  const byStatus: Record<string, string[]> = {};
  const outboxSummary: Record<string, string[]> = {};
  const outboxOrphans: number[] = [];
  try {
    liveLaunches = store.listLaunches({ status: ['preparing', 'launching', 'live'] }).length;
    for (const [id, e] of store.allEntries()) (byStatus[e.status.kind] ??= []).push(id);
    const transitionSeqs = new Set(store.listEvents({ kind: 'transition' }).map((e) => e.seq));
    for (const row of store.listOutbox()) {
      (outboxSummary[row.taskId] ??= []).push(row.kind === 'setState' ? String(row.payload['state']) : 'comment');
      if (!transitionSeqs.has(row.sourceSeq)) outboxOrphans.push(row.id);
    }
  } finally {
    store.close();
  }
  for (const k of Object.keys(byStatus)) byStatus[k]!.sort();

  // Pid log: per task, process intervals must not overlap; every pid must be dead now.
  const lines = existsSync(run.pidlog) ? readFileSync(run.pidlog, 'utf8').trim().split('\n').filter(Boolean) : [];
  const procs = new Map<string, { pid: number; task: string; start: number; end?: number }>();
  for (const line of lines) {
    const [pid, launchId, task, event, ts] = line.split(' ');
    if (!pid || !launchId || !task || !event) continue;
    const key = `${pid}:${launchId}`;
    const p = procs.get(key) ?? { pid: Number(pid), task, start: Number(ts) };
    if (event === 'start') p.start = Number(ts);
    if (event === 'exit' || event.startsWith('error') || event === 'got401') p.end = Math.min(p.end ?? Infinity, Number(ts));
    procs.set(key, p);
  }
  const alivePids = [...procs.values()].map((p) => p.pid).filter((pid) => pidAlive(pid));
  const pidOverlaps: string[] = [];
  const byTask = new Map<string, Array<{ start: number; end?: number; pid: number }>>();
  for (const p of procs.values()) (byTask.get(p.task) ?? byTask.set(p.task, []).get(p.task)!).push(p);
  for (const [task, list] of byTask) {
    list.sort((a, b) => a.start - b.start);
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1]!;
      const cur = list[i]!;
      // A process without an exit record was killed by recovery; it must be dead now, and overlap is unknowable.
      if (prev.end !== undefined && prev.end > cur.start) pidOverlaps.push(`${task}: pid ${prev.pid} ended ${prev.end} after pid ${cur.pid} started ${cur.start}`);
    }
  }
  return { trailerCommitsPerTask: perTask, foreign, worktrees, tempDirs, liveLaunches, pidOverlaps, alivePids, byStatus, outboxSummary, outboxOrphans };
}

function readdirSafe(p: string): string[] {
  try {
    return require('node:fs').readdirSync(p) as string[];
  } catch {
    return [];
  }
}
