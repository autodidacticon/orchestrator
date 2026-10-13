#!/usr/bin/env node
/**
 * Daemon entrypoint.
 *   orchestrator --config orchestrator.yaml [--reap-on-exit]
 * SIGTERM/SIGINT: graceful stop (agents keep running for adoption) unless --reap-on-exit.
 */
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { ApiServer } from './agent/server.js';
import { SlotValidator } from './brief/template.js';
import { loadConfig } from './config.js';
import { FileGraphSource } from './graph/source.js';
import type { Logger } from './loop/core.js';
import { Orchestrator } from './loop/orchestrator.js';
import { registerOperatorRoutes } from './operator/routes.js';
import { ClaudeCodeRunner } from './runner/claude-code.js';
import { SqliteStore } from './state/sqlite.js';
import { GitVerifierBackend } from './verify/verifier.js';
import { ensureRunDir, readRepoConfigRaw, resolveRepoPath, resolveRunConfig, runIdFor, writeDaemonJson, writeExitRecord } from './runs/runDir.js';
import { digestOf } from './operator/routes.js';
import { runIdOf, setRunId } from './state/store.js';
import { randomUUID } from 'node:crypto';
import { revParse } from './workspace/git.js';
import { GitWorkspace } from './workspace/git-workspace.js';
import { isEntrypoint } from './entry.js';

export const stderrLogger: Logger = {
  info: (msg, data) => process.stderr.write(`${new Date().toISOString()} INFO ${msg}${data ? ` ${JSON.stringify(data)}` : ''}\n`),
  warn: (msg, data) => process.stderr.write(`${new Date().toISOString()} WARN ${msg}${data ? ` ${JSON.stringify(data)}` : ''}\n`),
  error: (msg, data) => process.stderr.write(`${new Date().toISOString()} ERROR ${msg}${data ? ` ${JSON.stringify(data)}` : ''}\n`),
};

export const USAGE = `orchestrator: the daemon.

  orchestrator [--repo <path>] [--config orchestrator.yaml] [--reap-on-exit] [--mode spawn|pull|mixed] [--default-mode spawn|pull|mixed]

With --repo (or inside a repository), run data lives under ORCH_HOME
(~/.orchestrator) keyed by the repository path, and <repo>/orchestrator.yaml is
read when present. With --config, the file's dataDir and graphPath are used.

Runs one orchestration for one repository: loads the graph file, launches
agents up to capacity, verifies and publishes their work, and serves the agent
and operator APIs on loopback. SIGTERM stops it gracefully; agents keep running
and are adopted on the next start unless --reap-on-exit is set. --mode sets the
run's runner mode; --default-mode applies only when neither the store nor
orchestrator.yaml chose one. The daemon exits on its own after daemon.idleExitMs
of quiet and records why in daemon.json; start revives it.
`;

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: 'string', short: 'c' },
      repo: { type: 'string' },
      'reap-on-exit': { type: 'boolean', default: false },
      mode: { type: 'string' },
      'default-mode': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }
  let config;
  let runId: string | undefined;
  let fileSetsMode = false;
  if (values.config) {
    config = await loadConfig(values.config);
    fileSetsMode = rawRunnerMode(values.config) !== undefined;
  } else {
    const repo = await resolveRepoPath({ repo: values.repo });
    ensureRunDir(repo);
    config = await resolveRunConfig(repo);
    runId = runIdFor(repo);
    fileSetsMode = (readRepoConfigRaw(repo)?.['runner'] as { mode?: unknown } | undefined)?.mode !== undefined;
  }
  await mkdir(config.dataDir, { recursive: true });
  const store = new SqliteStore(path.join(config.dataDir, 'store.sqlite'));
  // The run id names this run in tracker comments; by repository under a run directory, otherwise once per store.
  if (runId) setRunId(store, runId);
  else if (!runIdOf(store)) setRunId(store, randomUUID().slice(0, 16));
  if (values.mode) {
    if (!['spawn', 'pull', 'mixed'].includes(values.mode)) throw new Error(`--mode must be spawn, pull, or mixed, not ${values.mode}`);
    store.setKv('runner.mode', values.mode);
  } else if (values['default-mode']) {
    // The plugin's default: adopted only when nothing chose a mode before. See specs/operator-control "Daemon lifecycle and discovery".
    const mode = values['default-mode'];
    if (!['spawn', 'pull', 'mixed'].includes(mode)) throw new Error(`--default-mode must be spawn, pull, or mixed, not ${mode}`);
    if (!store.getKv('runner.mode') && !fileSetsMode) store.setKv('runner.mode', mode);
  }
  if (!store.getKv('baselineHead')) store.setKv('baselineHead', await revParse(config.repoPath, config.integrationBranch));

  const runner = new ClaudeCodeRunner({ command: config.runnerCommand, logDir: path.join(config.dataDir, 'logs'), retryWindowMs: config.retryWindowMs });
  const workspace = new GitWorkspace(config.repoPath, config.integrationBranch, path.join(config.dataDir, 'worktrees'));
  const verifier = new GitVerifierBackend({
    repo: config.repoPath,
    integrationBranch: config.integrationBranch,
    tempRoot: path.join(config.dataDir, 'verify'),
    checkCommand: config.checkCommand,
    checkTimeoutMs: config.checkTimeoutMs,
    baselineSha: store.getKv('baselineHead'),
  });
  const orch = new Orchestrator({
    store,
    config,
    graphSource: new FileGraphSource(config.graphPath),
    runner,
    workspace,
    verifier,
    briefValidator: new SlotValidator(config.briefSlots),
    log: stderrLogger,
  });
  const server = new ApiServer(orch);
  registerOperatorRoutes(server, orch);
  // Reuse the recorded port when the config does not pin one, so agents launched before a restart reconnect.
  const recorded = Number(store.getKv('apiPort') ?? 0);
  let url: string;
  try {
    url = await server.listen(config.apiPort || recorded);
  } catch (err) {
    if (config.apiPort) throw err;
    stderrLogger.warn('recorded port unavailable, picking a new one', { recorded, err: String(err) });
    url = await server.listen(0);
  }
  store.setKv('apiBaseUrl', url);
  store.setKv('apiPort', String(server.port));
  writeDaemonJson(config.dataDir, { pid: process.pid, url, port: server.port, startedAt: Date.now(), repo: config.repoPath });
  stderrLogger.info('listening', { url, pid: process.pid, dataDir: config.dataDir });

  let stopping = false;
  const shutdown = async (cause: 'SIGTERM' | 'SIGINT' | 'route' | 'idle') => {
    if (stopping) return;
    stopping = true;
    const reap = Boolean(values['reap-on-exit']);
    stderrLogger.info('shutting down', { cause, reap });
    await orch.stop({ reap });
    await server.close();
    // The exit record says why the daemon is gone; a dead pid without one is a crash. See specs/operator-control "Exit record".
    const reason = cause === 'idle' ? 'idle' : cause === 'route' ? 'stop' : 'signal';
    try {
      writeExitRecord(config.dataDir, { at: Date.now(), reason, reap, digest: digestOf(orch) });
    } catch (err) {
      stderrLogger.warn('could not write the exit record', { err: String(err) });
    }
    store.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  orch.requestShutdown = (reason, reap) => {
    values['reap-on-exit'] = Boolean(reap) || Boolean(values['reap-on-exit']);
    void shutdown(reason === 'idle' ? 'idle' : 'route');
  };

  await orch.start();
}

/** `runner.mode` as written in a config file, without defaults. */
function rawRunnerMode(file: string): unknown {
  try {
    const raw = parseYaml(readFileSync(file, 'utf8')) as { runner?: { mode?: unknown } } | null;
    return raw?.runner?.mode;
  } catch {
    return undefined;
  }
}

const isEntry = isEntrypoint(import.meta.url);
if (isEntry) {
  main().catch((err) => {
    stderrLogger.error('fatal', { err: String(err instanceof Error ? err.stack : err) });
    process.exit(1);
  });
}
