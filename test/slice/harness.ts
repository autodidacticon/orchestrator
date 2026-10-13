import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { ApiServer } from '../../src/agent/server.js';
import { defaultConfig, type Config } from '../../src/config.js';
import { FileGraphSource, StaticGraphSource } from '../../src/graph/source.js';
import { Orchestrator } from '../../src/loop/orchestrator.js';
import { registerOperatorRoutes } from '../../src/operator/routes.js';
import { SubprocessRunner } from '../../src/runner/subprocess.js';
import { SqliteStore } from '../../src/state/sqlite.js';
import type { Launch, VerifierJob } from '../../src/state/store.js';
import type { VerifierBackend, VerifierContext, VerifierOutcome } from '../../src/verify/job.js';
import { GitVerifierBackend } from '../../src/verify/verifier.js';
import { GitWorkspace } from '../../src/workspace/git-workspace.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const scriptedAgent = path.resolve(here, '../agents/scripted.ts');
/** Absolute loader path: the agent runs with the worktree as cwd, where `tsx` cannot be resolved. */
export const tsxLoader = path.resolve(here, '../../node_modules/tsx/dist/loader.mjs');

/** Publishes the sealed sha without touching git; the real verifier is group 4. */
export class PassthroughVerifier implements VerifierBackend {
  async run(job: VerifierJob, ctx: VerifierContext): Promise<VerifierOutcome> {
    ctx.progress({ status: 'checking', expectedHead: job.baseSha });
    return { kind: 'published', publishedSha: job.sealedSha, verifiedSha: job.sealedSha };
  }
}

export function gitIn(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' } }).trim();
}

export function makeRepo(dir: string): string {
  const repo = path.join(dir, 'repo');
  mkdirSync(repo);
  gitIn(repo, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(repo, 'README.md'), '# toy\n');
  writeFileSync(path.join(repo, 'shared.txt'), 'base\n');
  gitIn(repo, 'add', '.');
  gitIn(repo, 'commit', '-q', '-m', 'initial');
  return repo;
}

export interface SliceHarness {
  dir: string;
  repo: string;
  store: SqliteStore;
  orch: Orchestrator;
  server: ApiServer;
  runner: SubprocessRunner;
  workspace: GitWorkspace;
  source: StaticGraphSource;
  config: Config;
  graphPath: string;
  pidlog: string;
  /** Reopen the same store/repo with a fresh orchestrator (simulates a daemon restart). */
  restart(): Promise<void>;
  waitFor(pred: () => boolean, timeoutMs?: number): Promise<void>;
  launchOf(taskId: string): Launch;
  pidEvents(): string[];
  cleanup(): Promise<void>;
}

export async function makeSlice(opts: { graph: string; config?: Partial<Config>; verifier?: VerifierBackend; realVerifier?: boolean; fileGraph?: boolean; dir?: string; repo?: string; unobserved?: boolean }): Promise<SliceHarness> {
  const dir = opts.dir ?? mkdtempSync(path.join(tmpdir(), 'orch-slice-'));
  const repo = opts.repo ?? makeRepo(dir);
  const dataDir = path.join(dir, 'run');
  mkdirSync(dataDir, { recursive: true });
  const pidlog = path.join(dir, 'pids.log');
  const config = defaultConfig({
    repoPath: repo,
    dataDir,
    integrationBranch: 'main',
    capacity: 4,
    maxWaiting: 4,
    leaseTtlMs: 5000,
    maxWaitMs: 60_000,
    retryWindowMs: 3000,
    checkCommand: 'true',
    runnerCommand: `node --import ${tsxLoader} ${scriptedAgent} {briefJson}`,
    graphPath: path.join(dataDir, 'graph.yaml'),
    ...opts.config,
  });
  const store = new SqliteStore(path.join(dataDir, 'store.sqlite'));
  const graphPath = path.join(dataDir, 'graph.yaml');
  if (opts.fileGraph) writeFileSync(graphPath, opts.graph);
  const source = opts.fileGraph ? new FileGraphSource(graphPath) : new StaticGraphSource(opts.graph);
  const runner = new SubprocessRunner({ command: config.runnerCommand, logDir: path.join(dataDir, 'logs'), graceMs: 500, extraEnv: { ORCH_PIDLOG: pidlog } });
  // A runner that cannot observe its processes: the lease TTL is the only bound on silence.
  if (opts.unobserved) runner.liveness = async () => 'unknown';
  const workspace = new GitWorkspace(repo, config.integrationBranch, path.join(dataDir, 'worktrees'));
  const verifier =
    opts.verifier ??
    (opts.realVerifier
      ? new GitVerifierBackend({
          repo,
          integrationBranch: config.integrationBranch,
          tempRoot: path.join(dataDir, 'verify'),
          checkCommand: config.checkCommand,
          checkTimeoutMs: config.checkTimeoutMs,
          baselineSha: gitIn(repo, 'rev-parse', config.integrationBranch),
        })
      : new PassthroughVerifier());

  const port = config.apiPort || (await freePort());
  let orch!: Orchestrator;
  let server!: ApiServer;
  const boot = async () => {
    orch = new Orchestrator({ store, config, graphSource: source, runner, workspace, verifier });
    server = new ApiServer(orch);
    registerOperatorRoutes(server, orch);
    await server.listen(port);
    await orch.loadGraph();
  };
  await boot();

  const h: SliceHarness = {
    dir,
    repo,
    get store() {
      return store;
    },
    get orch() {
      return orch;
    },
    get server() {
      return server;
    },
    runner,
    workspace,
    source: source as StaticGraphSource,
    config,
    graphPath,
    pidlog,
    restart: async () => {
      await server.close();
      await boot();
      const { recover } = await import('../../src/launch/recovery.js');
      await recover(orch);
    },
    waitFor: async (pred, timeoutMs = 15_000) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        await orch.tick();
        if (pred()) return;
        if (Date.now() > deadline) throw new Error('waitFor timed out');
        await new Promise((r) => setTimeout(r, 60));
      }
    },
    launchOf: (taskId) => {
      const [l] = store.listLaunches({ taskId, status: 'live' });
      if (!l) throw new Error(`no live launch for ${taskId}`);
      return l;
    },
    pidEvents: () => {
      try {
        return readFileSync(pidlog, 'utf8').trim().split('\n').filter(Boolean);
      } catch {
        return [];
      }
    },
    cleanup: async () => {
      await orch.stop({ reap: true }).catch(() => undefined);
      await server.close().catch(() => undefined);
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return h;
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

export const single = (behavior: string, extra = '') => `nodes:\n  - { id: T1, deps: [], behavior: "${behavior}"${extra} }`;
