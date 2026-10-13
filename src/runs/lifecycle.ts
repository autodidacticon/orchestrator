/**
 * Daemon lifecycle a session can drive: idempotent start, stop by route or
 * signal, run listing. See specs/operator-control "Daemon lifecycle and discovery".
 */
import { spawn } from 'node:child_process';
import { existsSync, openSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pidAlive } from '../runner/subprocess.js';
import { DAEMON_PID, ensureRunDir, orchHome, readDaemonJson, readRepoFile, resolveRepoPath, runPaths, type DaemonInfo, type RunPaths } from './runDir.js';

export interface DaemonState {
  runDir: string;
  pid?: number;
  url?: string;
  port?: number;
  alive: boolean;
  healthy: boolean;
}

export async function health(url: string, timeoutMs = 1500): Promise<Record<string, unknown> | undefined> {
  try {
    const res = await fetch(`${url}/v1/status`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return undefined;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export async function daemonState(runDir: string): Promise<DaemonState> {
  let pid: number | undefined;
  try {
    const n = Number(readFileSync(path.join(runDir, DAEMON_PID), 'utf8').trim());
    if (Number.isInteger(n) && n > 0) pid = n;
  } catch {
    /* no pid file */
  }
  const info = readDaemonJson(runDir);
  const alive = pid !== undefined && pidAlive(pid);
  const url = info?.url;
  const healthy = alive && url !== undefined && info?.pid === pid && (await health(url)) !== undefined;
  return { runDir, pid, url, port: info?.port, alive, healthy };
}

/** The daemon entrypoint: built .js next to this file's tree, else the .ts via tsx. */
export function daemonCommand(): { command: string; args: string[] } {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const js = path.resolve(here, '../main.js');
  if (existsSync(js)) return { command: process.execPath, args: [js] };
  const ts = path.resolve(here, '../main.ts');
  const loader = path.resolve(here, '../../node_modules/tsx/dist/loader.mjs');
  return { command: process.execPath, args: ['--import', loader, ts] };
}

export interface StartOptions {
  repo?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Extra environment for the daemon (and therefore its agents). */
  extraEnv?: Record<string, string>;
  timeoutMs?: number;
}

export interface StartResult extends DaemonInfo {
  runDir: string;
  graphPath: string;
  started: boolean;
}

/** Idempotent start: reuse a healthy daemon, otherwise spawn one detached and wait for health. */
export async function startDaemon(opts: StartOptions = {}): Promise<StartResult> {
  const env = opts.env ?? process.env;
  const repo = await resolveRepoPath({ repo: opts.repo, cwd: opts.cwd, env });
  const paths: RunPaths = ensureRunDir(repo, env);
  const state = await daemonState(paths.runDir);
  if (state.healthy && state.pid && state.url) {
    const info = readDaemonJson(paths.runDir) as DaemonInfo;
    return { ...info, runDir: paths.runDir, graphPath: paths.graphPath, started: false };
  }
  const { command, args } = daemonCommand();
  const fd = openSync(paths.daemonLog, 'a');
  const child = spawn(command, [...args, '--repo', repo], {
    cwd: repo,
    env: { ...env, ...opts.extraEnv },
    detached: true,
    stdio: ['ignore', fd, fd],
  });
  child.unref();
  if (!child.pid) throw new Error('daemon spawn returned no pid');
  writeFileSync(paths.daemonPid, `${child.pid}\n`, 'utf8');
  const deadline = Date.now() + (opts.timeoutMs ?? 20_000);
  while (Date.now() < deadline) {
    const info = readDaemonJson(paths.runDir);
    if (info && info.pid === child.pid && (await health(info.url))) {
      return { ...info, runDir: paths.runDir, graphPath: paths.graphPath, started: true };
    }
    if (!pidAlive(child.pid)) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  let tail = '';
  try {
    tail = readFileSync(paths.daemonLog, 'utf8').slice(-2000);
  } catch {
    /* ignore */
  }
  throw new Error(`daemon did not become healthy (pid ${child.pid}); log tail:\n${tail}`);
}

export interface StopOptions {
  repo?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  reap?: boolean;
  timeoutMs?: number;
}

/** Stop via the shutdown route, falling back to SIGTERM. Resolves when the process is gone. */
export async function stopDaemon(opts: StopOptions = {}): Promise<{ stopped: boolean; pid?: number }> {
  const env = opts.env ?? process.env;
  const repo = await resolveRepoPath({ repo: opts.repo, cwd: opts.cwd, env });
  const paths = runPaths(repo, env);
  const state = await daemonState(paths.runDir);
  if (!state.alive || !state.pid) return { stopped: false, pid: state.pid };
  if (state.healthy && state.url) {
    try {
      await fetch(`${state.url}/v1/shutdown`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reap: Boolean(opts.reap) }),
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      /* fall through to signal */
    }
  }
  const deadline = Date.now() + (opts.timeoutMs ?? 15_000);
  let signalled = false;
  while (Date.now() < deadline) {
    if (!pidAlive(state.pid)) return { stopped: true, pid: state.pid };
    if (!signalled && Date.now() > deadline - 10_000) {
      try {
        process.kill(state.pid, 'SIGTERM');
      } catch {
        /* gone */
      }
      signalled = true;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return { stopped: !pidAlive(state.pid), pid: state.pid };
}

export interface RunListing {
  runDir: string;
  repo: string | undefined;
  pid?: number;
  url?: string;
  alive: boolean;
  healthy: boolean;
  digest?: Record<string, unknown>;
}

export async function listRuns(env: NodeJS.ProcessEnv = process.env): Promise<RunListing[]> {
  const root = path.join(orchHome(env), 'runs');
  let dirs: string[] = [];
  try {
    dirs = readdirSync(root);
  } catch {
    return [];
  }
  const out: RunListing[] = [];
  for (const d of dirs.sort()) {
    const runDir = path.join(root, d);
    const state = await daemonState(runDir);
    let digest: Record<string, unknown> | undefined;
    if (state.healthy && state.url) {
      const s = await health(state.url);
      if (s) digest = { finished: s['finished'], stalled: s['stalled'], paused: s['paused'], running: (s['byStatus'] as Record<string, string[]> | undefined)?.['running'] };
    }
    out.push({ runDir, repo: readRepoFile(runDir), pid: state.pid, url: state.url, alive: state.alive, healthy: state.healthy, digest });
  }
  return out;
}
