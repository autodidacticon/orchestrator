/**
 * Daemon lifecycle a session can drive: idempotent start, stop by route or
 * signal, run listing. See specs/operator-control "Daemon lifecycle and discovery".
 */
import { spawn } from 'node:child_process';
import { existsSync, openSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pidAlive } from '../runner/subprocess.js';
import type { ToolchainRecord } from '../toolchain/detect.js';
import { type ConfigReport, type OverridableKey, type Overrides, overridesSchema, START_ONLY_KEYS } from './resolve.js';
import { DAEMON_PID, ensureRunDir, orchHome, readDaemonJson, readRepoFile, resolveRepoPath, runPaths, type DaemonInfo, type ExitRecord, type RunPaths } from './runDir.js';

export interface DaemonState {
  runDir: string;
  pid?: number;
  url?: string;
  port?: number;
  alive: boolean;
  healthy: boolean;
  /** Why the last daemon exited; absent while alive, and after a crash. See specs/operator-control "Exit record". */
  exit?: ExitRecord;
}

/** A liveness probe; `probe=1` keeps it from counting as activity for the idle exit. */
export async function health(url: string, timeoutMs = 1500): Promise<Record<string, unknown> | undefined> {
  try {
    const res = await fetch(`${url}/v1/status?probe=1`, { signal: AbortSignal.timeout(timeoutMs) });
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
  return { runDir, pid, url, port: info?.port, alive, healthy, ...(!alive && info?.exit ? { exit: info.exit } : {}) };
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
  /** Runner mode for the run: passed to a daemon this call spawns, set through the runner route on one already running. */
  mode?: 'spawn' | 'pull' | 'mixed';
  /** The mode a spawned daemon adopts when neither the store nor orchestrator.yaml chose one; ignored for a running daemon. */
  defaultMode?: 'spawn' | 'pull' | 'mixed';
  /** Configuration arguments: passed as `--set` flags to a daemon this call spawns, applied through `PUT /v1/config` to one already running. See specs/operator-control "Start arguments". */
  overrides?: Overrides;
}

export interface StartResult extends DaemonInfo {
  runDir: string;
  graphPath: string;
  started: boolean;
  /** The runner mode in force after the start. */
  mode?: 'spawn' | 'pull' | 'mixed';
  /** The resolved configuration with value and source per key, read from the daemon once healthy. */
  config?: ConfigReport['config'];
  toolchain?: ToolchainRecord;
  needsConfig?: OverridableKey[];
  /** Override keys applied by this call, and those the daemon refused with its reason. */
  applied?: OverridableKey[];
  rejected?: Array<{ key: OverridableKey; reason: string }>;
}

async function readConfig(url: string): Promise<ConfigReport | undefined> {
  try {
    const res = await fetch(`${url}/v1/config`, { signal: AbortSignal.timeout(3000) });
    return res.ok ? ((await res.json()) as ConfigReport) : undefined;
  } catch {
    return undefined;
  }
}

/** Runtime keys go through the route; start-only keys are refused here, so the rest still lands. */
async function applyOverrides(url: string, overrides: Overrides): Promise<{ applied: OverridableKey[]; rejected: Array<{ key: OverridableKey; reason: string }> }> {
  const rejected: Array<{ key: OverridableKey; reason: string }> = [];
  const runtime: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) continue;
    if ((START_ONLY_KEYS as readonly string[]).includes(k)) rejected.push({ key: k as OverridableKey, reason: `${k} is start-only: it applies when the daemon is spawned, and this daemon is already running` });
    else runtime[k] = v;
  }
  let applied: OverridableKey[] = [];
  if (Object.keys(runtime).length) {
    const res = await fetch(`${url}/v1/config`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(runtime), signal: AbortSignal.timeout(5000) });
    const body = (await res.json().catch(() => ({}))) as { applied?: OverridableKey[]; error?: string };
    if (res.ok) applied = body.applied ?? (Object.keys(runtime) as OverridableKey[]);
    else for (const k of Object.keys(runtime)) rejected.push({ key: k as OverridableKey, reason: body.error ?? `status ${res.status}` });
  }
  return { applied, rejected };
}

function configFields(report: ConfigReport | undefined): Pick<StartResult, 'config' | 'toolchain' | 'needsConfig'> {
  return report ? { config: report.config, toolchain: report.toolchain, needsConfig: report.needsConfig } : {};
}

function modeOf(status: Record<string, unknown> | undefined): 'spawn' | 'pull' | 'mixed' | undefined {
  const m = (status?.['runner'] as { mode?: unknown } | undefined)?.mode;
  return m === 'spawn' || m === 'pull' || m === 'mixed' ? m : undefined;
}

/** Idempotent start: reuse a healthy daemon, otherwise spawn one detached and wait for health. */
export async function startDaemon(opts: StartOptions = {}): Promise<StartResult> {
  const env = opts.env ?? process.env;
  const repo = await resolveRepoPath({ repo: opts.repo, cwd: opts.cwd, env });
  const paths: RunPaths = ensureRunDir(repo, env);
  const checked = overridesSchema.safeParse(opts.overrides ?? {});
  if (!checked.success) {
    const issue = checked.error.issues[0];
    throw new Error(`invalid configuration argument ${String(issue?.path[0] ?? '')}: ${issue?.message ?? 'invalid value'}`);
  }
  const overrides = checked.data;
  const state = await daemonState(paths.runDir);
  if (state.healthy && state.pid && state.url) {
    const info = readDaemonJson(paths.runDir) as DaemonInfo;
    if (opts.mode) {
      await fetch(`${state.url}/v1/runner`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: opts.mode }), signal: AbortSignal.timeout(3000) });
    }
    const outcome = await applyOverrides(state.url, overrides);
    const mode = opts.mode ?? modeOf(await health(state.url));
    return { ...info, runDir: paths.runDir, graphPath: paths.graphPath, started: false, ...(mode ? { mode } : {}), ...configFields(await readConfig(state.url)), applied: outcome.applied, rejected: outcome.rejected };
  }
  const { command, args } = daemonCommand();
  const fd = openSync(paths.daemonLog, 'a');
  const modeArgs = opts.mode ? ['--mode', opts.mode] : opts.defaultMode ? ['--default-mode', opts.defaultMode] : [];
  // Values become `--set` flags the daemon stores before resolving; a null (clear) goes through the route once it is up.
  const setArgs: string[] = [];
  const clears: Record<string, null> = {};
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) continue;
    if (v === null) clears[k] = null;
    else setArgs.push('--set', `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
  }
  const child = spawn(command, [...args, '--repo', repo, ...modeArgs, ...setArgs], {
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
    const status = info && info.pid === child.pid ? await health(info.url) : undefined;
    if (info && status) {
      const mode = modeOf(status) ?? opts.mode;
      const applied = Object.entries(overrides).filter(([, v]) => v !== undefined && v !== null).map(([k]) => k as OverridableKey);
      const cleared = Object.keys(clears).length ? await applyOverrides(info.url, clears as Overrides) : { applied: [] as OverridableKey[], rejected: [] as Array<{ key: OverridableKey; reason: string }> };
      return { ...info, runDir: paths.runDir, graphPath: paths.graphPath, started: true, ...(mode ? { mode } : {}), ...configFields(await readConfig(info.url)), applied: [...applied, ...cleared.applied], rejected: cleared.rejected };
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
  /** For a run whose daemon is not alive: why it exited, or absent after a crash. */
  exit?: ExitRecord;
}

/**
 * Start the daemon again for a run directory that holds a store, when the last
 * exit was idle or a crash; refuse after an explicit stop or signal. Returns
 * undefined when there is nothing to revive (no store, or a daemon already
 * healthy). See specs/operator-control "Revive on demand".
 */
export async function reviveDaemon(opts: StartOptions = {}): Promise<StartResult | undefined> {
  const env = opts.env ?? process.env;
  const repo = await resolveRepoPath({ repo: opts.repo, cwd: opts.cwd, env });
  const paths = runPaths(repo, env);
  if (!existsSync(path.join(paths.runDir, 'store.sqlite'))) return undefined;
  const state = await daemonState(paths.runDir);
  if (state.healthy) return undefined;
  if (state.exit && state.exit.reason !== 'idle') {
    throw new Error(`the daemon for ${repo} was stopped at ${new Date(state.exit.at).toISOString()} (${state.exit.reason}); call start to run it again`);
  }
  return startDaemon(opts);
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
    out.push({ runDir, repo: readRepoFile(runDir), pid: state.pid, url: state.url, alive: state.alive, healthy: state.healthy, digest, ...(state.exit ? { exit: state.exit } : {}) });
  }
  return out;
}
