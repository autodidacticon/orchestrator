/**
 * Per-user run directories keyed by the repository's real path.
 * See specs/operator-control "Run directory".
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { type Config, configSchema, defaultConfig, loadConfig } from '../config.js';
import { parse as parseYaml } from 'yaml';
import { detectIntegrationBranch } from '../toolchain/branch.js';
import { detectToolchain, type ToolchainRecord } from '../toolchain/detect.js';
import { type ConfigReport, type Overrides, type Resolved, resolveLayers } from './resolve.js';

const execFileP = promisify(execFile);

export const REPO_FILE = 'repo';
export const DAEMON_JSON = 'daemon.json';
export const DAEMON_PID = 'daemon.pid';
export const DAEMON_LOG = 'daemon.log';
export const GRAPH_FILE = 'graph.yaml';
export const CONFIG_FILE = 'orchestrator.yaml';
/** The resolved configuration with provenance, written beside daemon.json. See specs/toolchain-discovery "Resolved configuration record". */
export const CONFIG_JSON = 'config.json';

export function orchHome(env: NodeJS.ProcessEnv = process.env): string {
  return env['ORCH_HOME'] ?? path.join(homedir(), '.orchestrator');
}

export function runIdFor(realRepoPath: string): string {
  return createHash('sha256').update(realRepoPath, 'utf8').digest('hex').slice(0, 16);
}

export function runDirFor(realRepoPath: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(orchHome(env), 'runs', runIdFor(realRepoPath));
}

/** Resolve the repository: explicit path, ORCH_REPO, or the git top level of cwd. Always a real path. */
export async function resolveRepoPath(opts: { repo?: string; cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  const env = opts.env ?? process.env;
  const explicit = opts.repo ?? env['ORCH_REPO'];
  if (explicit) return realpathSync(path.resolve(explicit));
  const cwd = opts.cwd ?? process.cwd();
  try {
    const { stdout } = await execFileP('git', ['rev-parse', '--show-toplevel'], { cwd });
    return realpathSync(stdout.trim());
  } catch {
    throw new Error(`not inside a git repository: ${cwd}; pass --repo or set ORCH_REPO`);
  }
}

export interface RunPaths {
  repo: string;
  runDir: string;
  graphPath: string;
  daemonJson: string;
  daemonPid: string;
  daemonLog: string;
}

export function runPaths(realRepoPath: string, env: NodeJS.ProcessEnv = process.env): RunPaths {
  const runDir = runDirFor(realRepoPath, env);
  return {
    repo: realRepoPath,
    runDir,
    graphPath: path.join(runDir, GRAPH_FILE),
    daemonJson: path.join(runDir, DAEMON_JSON),
    daemonPid: path.join(runDir, DAEMON_PID),
    daemonLog: path.join(runDir, DAEMON_LOG),
  };
}

/** Create the run directory and record the repository path inside it. Idempotent. */
export function ensureRunDir(realRepoPath: string, env: NodeJS.ProcessEnv = process.env): RunPaths {
  const p = runPaths(realRepoPath, env);
  mkdirSync(p.runDir, { recursive: true });
  const repoFile = path.join(p.runDir, REPO_FILE);
  if (!existsSync(repoFile) || readFileSync(repoFile, 'utf8').trim() !== realRepoPath) writeFileSync(repoFile, `${realRepoPath}\n`, 'utf8');
  return p;
}

export function readRepoFile(runDir: string): string | undefined {
  try {
    return readFileSync(path.join(runDir, REPO_FILE), 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Why a daemon last exited; absent after a crash. See specs/operator-control "Exit record". */
/** Who asked for a `stop`: the operator MCP server's attachment id when present, the remote address, the user agent. See specs/operator-control "Shutdown". */
export interface ShutdownCaller {
  attachment?: string;
  remote?: string;
  userAgent?: string;
}

export interface ExitRecord {
  at: number;
  reason: 'idle' | 'stop' | 'signal';
  reap: boolean;
  digest: Record<string, unknown>;
  /** Present for a `stop`: the caller the shutdown route recorded. */
  by?: ShutdownCaller;
}

export interface DaemonInfo {
  pid: number;
  url: string;
  port: number;
  startedAt: number;
  repo: string;
  exit?: ExitRecord;
}

export function readDaemonJson(runDir: string): DaemonInfo | undefined {
  try {
    return JSON.parse(readFileSync(path.join(runDir, DAEMON_JSON), 'utf8')) as DaemonInfo;
  } catch {
    return undefined;
  }
}

export function writeDaemonJson(runDir: string, info: DaemonInfo): void {
  writeFileSync(path.join(runDir, DAEMON_JSON), `${JSON.stringify(info, null, 2)}\n`, 'utf8');
}

/** Merge the exit record into the existing daemon.json (written after a graceful stop, before the process ends). */
export function writeExitRecord(runDir: string, exit: ExitRecord): void {
  const info = readDaemonJson(runDir);
  if (!info) return;
  writeDaemonJson(runDir, { ...info, exit });
}

/** The repository's orchestrator.yaml as parsed, without defaults; undefined when absent or unparseable. */
export function readRepoConfigRaw(realRepoPath: string): Record<string, unknown> | undefined {
  const file = path.join(realRepoPath, CONFIG_FILE);
  if (!existsSync(file)) return undefined;
  try {
    const raw = parseYaml(readFileSync(file, 'utf8')) as unknown;
    return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** The file layer and defaults for a run: <repo>/orchestrator.yaml when present. dataDir and graphPath default to the run directory unless the file sets them. */
function baseRunConfig(realRepoPath: string, env: NodeJS.ProcessEnv): { config: Config; fileRaw: Record<string, unknown> | undefined } {
  const p = runPaths(realRepoPath, env);
  const file = path.join(realRepoPath, CONFIG_FILE);
  if (!existsSync(file)) {
    return { config: defaultConfig({ repoPath: realRepoPath, dataDir: p.runDir, graphPath: p.graphPath, runDir: p.runDir }), fileRaw: undefined };
  }
  const raw = (parseYaml(readFileSync(file, 'utf8')) ?? {}) as Record<string, unknown>;
  const cfg = configSchema.parse(raw);
  const abs = (v: string) => (path.isAbsolute(v) ? v : path.resolve(realRepoPath, v));
  return {
    config: {
      ...cfg,
      repoPath: raw['repoPath'] ? abs(String(raw['repoPath'])) : realRepoPath,
      dataDir: raw['dataDir'] ? abs(String(raw['dataDir'])) : p.runDir,
      graphPath: raw['graphPath'] ? abs(String(raw['graphPath'])) : p.graphPath,
      runDir: p.runDir,
    },
    fileRaw: raw,
  };
}

export interface ResolveOptions {
  /** The durable override document (the argument layer). */
  overrides?: Overrides;
  /** The integration branch pinned in the store for the run. */
  pinned?: string;
  /** false: skip detection (no git or filesystem probes); the detected layer is then empty. */
  detect?: boolean;
}

/** Detection from the repository: the toolchain table and the integration branch. See specs/toolchain-discovery. */
export async function detectRepo(repo: string): Promise<{ toolchain: ToolchainRecord; integrationBranch: string | undefined }> {
  const [toolchain, integrationBranch] = await Promise.all([detectToolchain(repo), detectIntegrationBranch(repo)]);
  return { toolchain, integrationBranch };
}

/**
 * The resolved configuration for a run: arguments over <repo>/orchestrator.yaml
 * over the pinned branch over detection over defaults, with provenance.
 * Callers that only need the values read `.config`.
 */
export async function resolveRunConfig(realRepoPath: string, env: NodeJS.ProcessEnv = process.env, opts: ResolveOptions = {}): Promise<Resolved> {
  const { config, fileRaw } = baseRunConfig(realRepoPath, env);
  const detected = opts.detect === false ? undefined : await detectRepo(config.repoPath);
  return resolveLayers({ base: config, fileRaw, detected, pinned: opts.pinned }, opts.overrides ?? {});
}

/** The same resolution over an explicit config file (`orchestrator --config`). */
export async function resolveFileConfig(file: string, opts: ResolveOptions = {}): Promise<Resolved> {
  const config = await loadConfig(file);
  let fileRaw: Record<string, unknown> = {};
  try {
    const raw = parseYaml(readFileSync(file, 'utf8')) as unknown;
    if (raw && typeof raw === 'object') fileRaw = raw as Record<string, unknown>;
  } catch {
    /* loadConfig already parsed it */
  }
  const detected = opts.detect === false ? undefined : await detectRepo(config.repoPath);
  return resolveLayers({ base: config, fileRaw, detected, pinned: opts.pinned }, opts.overrides ?? {});
}

/** Atomic write of the resolved configuration record (temp file and rename). */
export function writeConfigJson(runDir: string, record: ConfigReport): void {
  const target = path.join(runDir, CONFIG_JSON);
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  renameSync(tmp, target);
}

export function readConfigJson(runDir: string): ConfigReport | undefined {
  try {
    return JSON.parse(readFileSync(path.join(runDir, CONFIG_JSON), 'utf8')) as ConfigReport;
  } catch {
    return undefined;
  }
}
