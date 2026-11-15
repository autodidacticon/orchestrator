/**
 * Per-user run directories keyed by the repository's real path.
 * See specs/operator-control "Run directory".
 */
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { type Config, configSchema, defaultConfig, loadConfig, withStoreEnv } from '../config.js';
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

/** The repository path hash: the run id of every SQLite run, and of a Postgres run that names no deployment. */
export function runIdFor(realRepoPath: string): string {
  return createHash('sha256').update(realRepoPath, 'utf8').digest('hex').slice(0, 16);
}

/** What an explicit run id may be: 1 to 64 characters of letters, digits, `_` and `-`. See specs/state-backend "Run id per deployment". */
export const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Where a run id came from, in order of precedence. `origin` is the clone's origin remote, read when git.pushIntegration is on and git.originUrl is unset. */
export type RunIdSource = 'store.runId' | 'ORCH_RUN_ID' | 'git.originUrl' | 'origin' | 'repository';

export interface RunIdChoice {
  runId: string;
  source: RunIdSource;
}

/** The inputs of the run id: the store block (file and environment only) and the origin. */
export interface RunIdInput {
  kind: 'sqlite' | 'postgres';
  /** `store.runId` from the config file. */
  storeRunId?: unknown;
  env?: NodeJS.ProcessEnv;
  originUrl?: string;
  pushIntegration?: boolean;
  /** The repository's real path. */
  repo: string;
}

/** An origin URL without its user information, so a rotated credential keeps the id. */
export function originIdentity(url: string): string {
  const u = url.trim();
  try {
    const parsed = new URL(u);
    if (parsed.username || parsed.password) {
      parsed.username = '';
      parsed.password = '';
    }
    return parsed.toString();
  } catch {
    return u; // scp-like `git@host:path` or a local path
  }
}

/** The run id derived from an origin URL. */
export function runIdForOrigin(url: string): string {
  return createHash('sha256').update(`origin\0${originIdentity(url)}`, 'utf8').digest('hex').slice(0, 16);
}

function explicitRunId(value: unknown, source: 'store.runId' | 'ORCH_RUN_ID'): string {
  if (typeof value !== 'string' || !RUN_ID_PATTERN.test(value)) {
    throw new Error(`invalid run id ${JSON.stringify(value)} from ${source}: a run id is 1 to 64 characters of A-Z, a-z, 0-9, _ and -`);
  }
  return value;
}

/** The URL of the clone's `origin` remote, or undefined. */
function cloneOriginUrl(repo: string): string | undefined {
  try {
    return execFileSync('git', ['config', '--get', 'remote.origin.url'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The run id. SQLite: the repository path hash, as always. Postgres: `store.runId`, else `ORCH_RUN_ID`, else a hash
 * of git.originUrl, else (git.pushIntegration on) a hash of the clone's origin remote, else the path hash.
 * An explicit id that does not match RUN_ID_PATTERN throws, naming it. See specs/state-backend "Run id per deployment".
 */
export function chooseRunId(input: RunIdInput): RunIdChoice {
  const pathHash: RunIdChoice = { runId: runIdFor(input.repo), source: 'repository' };
  if (input.kind !== 'postgres') return pathHash;
  if (input.storeRunId !== undefined && input.storeRunId !== null) return { runId: explicitRunId(input.storeRunId, 'store.runId'), source: 'store.runId' };
  const fromEnv = (input.env ?? process.env)['ORCH_RUN_ID'];
  if (fromEnv !== undefined && fromEnv !== '') return { runId: explicitRunId(fromEnv, 'ORCH_RUN_ID'), source: 'ORCH_RUN_ID' };
  if (input.originUrl) return { runId: runIdForOrigin(input.originUrl), source: 'git.originUrl' };
  if (input.pushIntegration) {
    const origin = cloneOriginUrl(input.repo);
    if (origin) return { runId: runIdForOrigin(origin), source: 'origin' };
  }
  return pathHash;
}

/** The warning for a Postgres run on the path hash: every deployment with the same repository path shares it. */
export function runIdWarning(kind: 'sqlite' | 'postgres', choice: RunIdChoice): string | undefined {
  if (kind !== 'postgres' || choice.source !== 'repository') return undefined;
  return 'the run id is the repository path hash: every deployment with this repository path on this database shares the run and its lock; set store.runId, ORCH_RUN_ID or git.originUrl';
}

/** The run id input of a parsed config: its store block and git block. */
export function runIdInputOf(cfg: Pick<Config, 'store' | 'git'>, repo: string, env: NodeJS.ProcessEnv = process.env): RunIdInput {
  return { kind: cfg.store.kind, storeRunId: cfg.store.runId, env, originUrl: cfg.git.originUrl, pushIntegration: cfg.git.pushIntegration, repo };
}

/** The run id of a repository run (`orchestrator --repo`), from <repo>/orchestrator.yaml and the environment. */
export function repoRunId(realRepoPath: string, env: NodeJS.ProcessEnv = process.env): RunIdChoice {
  const raw = readRepoConfigRaw(realRepoPath);
  const store = (raw?.['store'] ?? {}) as { kind?: unknown; runId?: unknown };
  const git = (raw?.['git'] ?? {}) as { originUrl?: unknown; pushIntegration?: unknown };
  return chooseRunId({
    kind: store.kind === 'postgres' ? 'postgres' : 'sqlite',
    storeRunId: store.runId,
    env,
    originUrl: typeof git.originUrl === 'string' && git.originUrl ? git.originUrl : undefined,
    pushIntegration: git.pushIntegration === true,
    repo: realRepoPath,
  });
}

/** Whether `file` is tracked by git in `repo`: a tracked file is checked out into every worktree. */
export function trackedInRepo(repo: string, file: string): boolean {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', '--', path.resolve(file)], { cwd: repo, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** The run directory: `<ORCH_HOME>/runs/<run id>`. See specs/operator-control "Run directory". */
export function runDirFor(realRepoPath: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(orchHome(env), 'runs', repoRunId(realRepoPath, env).runId);
}

/** Resolve the repository: explicit path, ORCH_REPO, or the git top level of cwd. Always a real path. */
export async function resolveRepoPath(opts: { repo?: string; cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  const env = opts.env ?? process.env;
  const explicit = opts.repo ?? env['ORCH_REPO'];
  if (explicit) return realpathSync(path.resolve(explicit));
  const cwd = opts.cwd ?? process.cwd();
  try {
    return await gitTopLevel(cwd);
  } catch {
    throw new Error(`not inside a git repository: ${cwd}; pass --repo or set ORCH_REPO`);
  }
}

/** The real path of the git top level containing dir; throws when dir is not inside a git repository. */
export async function gitTopLevel(dir: string): Promise<string> {
  const { stdout } = await execFileP('git', ['rev-parse', '--show-toplevel'], { cwd: dir });
  return realpathSync(stdout.trim());
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
  /**
   * Present when the exit lost committed records: the batches that never reached the store. Zero with `storeClosed`
   * false means the grace period ended before the store closed, with nothing known to be lost.
   */
  unflushedBatches?: number;
  /** False when the daemon exited before its store closed (the shutdown grace elapsed). Absent on a clean exit. */
  storeClosed?: false;
  /** The cause a batch was refused for at shutdown, when the sink rejected one. */
  rejected?: { error: string; sqlstate?: string; table?: string; key?: Record<string, unknown> };
}

/** Whether an exit record describes a clean stop: the store closed with nothing unflushed. See specs/operator-control "Exit record". */
export function cleanExit(exit: ExitRecord): boolean {
  return !exit.unflushedBatches && exit.storeClosed !== false && !exit.rejected;
}

/**
 * The exit record's store fields for how the store's close ended: nothing for a close with nothing unflushed, else
 * the lost batches (and the rejection's cause). `closed` false is a grace exit before the close returned.
 */
export function exitStoreFields(outcome: { closed: boolean; unflushedBatches: number; rejected?: ExitRecord['rejected'] }): Pick<ExitRecord, 'unflushedBatches' | 'storeClosed' | 'rejected'> {
  return {
    ...(outcome.unflushedBatches > 0 || !outcome.closed ? { unflushedBatches: outcome.unflushedBatches } : {}),
    ...(!outcome.closed ? { storeClosed: false as const } : {}),
    ...(outcome.rejected ? { rejected: outcome.rejected } : {}),
  };
}

/** How an exit record reads in a message: the reason, plus what the exit lost when it was not clean. */
export function describeExit(exit: ExitRecord): string {
  if (cleanExit(exit)) return exit.reason;
  const lost = exit.unflushedBatches ? `, losing ${exit.unflushedBatches} unflushed batches` : '';
  const open = exit.storeClosed === false ? ', before the store closed' : '';
  const why = exit.rejected ? `, a batch rejected: ${exit.rejected.error}` : '';
  return `${exit.reason}${lost}${open}${why}`;
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
    return { config: withStoreEnv(defaultConfig({ repoPath: realRepoPath, dataDir: p.runDir, graphPath: p.graphPath, runDir: p.runDir }), env), fileRaw: undefined };
  }
  const raw = (parseYaml(readFileSync(file, 'utf8')) ?? {}) as Record<string, unknown>;
  const cfg = withStoreEnv(configSchema.parse(raw), env);
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

/**
 * The store kind a run directory belongs to: config.json's record, else the repository's orchestrator.yaml, else sqlite.
 * A Postgres run keeps no store file locally. See specs/state-backend "Store selection".
 */
export function runStoreKind(runDir: string, realRepoPath?: string): 'sqlite' | 'postgres' {
  const recorded = (readConfigJson(runDir) as { store?: { kind?: unknown } } | undefined)?.store?.kind;
  if (recorded === 'postgres' || recorded === 'sqlite') return recorded;
  const raw = realRepoPath ? (readRepoConfigRaw(realRepoPath)?.['store'] as { kind?: unknown } | undefined) : undefined;
  return raw?.kind === 'postgres' ? 'postgres' : 'sqlite';
}

/** The answer for a Postgres run that has no local store: its daemon is found by URL only. */
export function remoteRunError(where: string): Error {
  return new Error(`the run ${where} keeps its state in Postgres and is remote: no store file is kept locally, so pass --url or set ORCH_URL to reach its daemon`);
}
