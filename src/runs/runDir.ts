/**
 * Per-user run directories keyed by the repository's real path.
 * See specs/operator-control "Run directory".
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { type Config, configSchema, defaultConfig } from '../config.js';
import { parse as parseYaml } from 'yaml';

const execFileP = promisify(execFile);

export const REPO_FILE = 'repo';
export const DAEMON_JSON = 'daemon.json';
export const DAEMON_PID = 'daemon.pid';
export const DAEMON_LOG = 'daemon.log';
export const GRAPH_FILE = 'graph.yaml';
export const CONFIG_FILE = 'orchestrator.yaml';

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

export interface DaemonInfo {
  pid: number;
  url: string;
  port: number;
  startedAt: number;
  repo: string;
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

/**
 * Config for a run: <repo>/orchestrator.yaml when present, else defaults.
 * dataDir and graphPath default to the run directory unless the file sets them.
 */
export async function resolveRunConfig(realRepoPath: string, env: NodeJS.ProcessEnv = process.env): Promise<Config> {
  const p = runPaths(realRepoPath, env);
  const file = path.join(realRepoPath, CONFIG_FILE);
  if (!existsSync(file)) {
    return defaultConfig({ repoPath: realRepoPath, dataDir: p.runDir, graphPath: p.graphPath, runDir: p.runDir });
  }
  const raw = (parseYaml(readFileSync(file, 'utf8')) ?? {}) as Record<string, unknown>;
  const cfg = configSchema.parse(raw);
  const abs = (v: string) => (path.isAbsolute(v) ? v : path.resolve(realRepoPath, v));
  return {
    ...cfg,
    repoPath: raw['repoPath'] ? abs(String(raw['repoPath'])) : realRepoPath,
    dataDir: raw['dataDir'] ? abs(String(raw['dataDir'])) : p.runDir,
    graphPath: raw['graphPath'] ? abs(String(raw['graphPath'])) : p.graphPath,
    runDir: p.runDir,
  };
}
