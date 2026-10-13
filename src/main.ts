#!/usr/bin/env node
/**
 * Daemon entrypoint.
 *   orchestrator [--repo <path>] [--config orchestrator.yaml] [--reap-on-exit] [--mode m] [--default-mode m] [--set key=value]...
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
import { ensureRunDir, readRepoConfigRaw, resolveFileConfig, resolveRepoPath, resolveRunConfig, type ResolveOptions, runIdFor, writeConfigJson, writeDaemonJson, writeExitRecord } from './runs/runDir.js';
import { configSummary, mergeOverrides, type Overrides, parseSetFlags, readOverrides, reportOf, type Resolved } from './runs/resolve.js';
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

  orchestrator [--repo <path>] [--config orchestrator.yaml] [--reap-on-exit] [--mode spawn|pull|mixed] [--default-mode spawn|pull|mixed] [--set key=value]...

With --repo (or inside a repository), run data lives under ORCH_HOME
(~/.orchestrator) keyed by the repository path, and <repo>/orchestrator.yaml is
read when present. With --config, the file's dataDir and graphPath are used.

No file is needed: the check command, the integration branch, and the tools
agents may run are detected from the repository root, and every value records
where it came from (argument, file, pinned, detected, default) in
<runDir>/config.json and in status. --set key=value stores a durable override
for the run before resolving; keys: checkCommand, integrationBranch (start-only),
capacity, allowedTools (a JSON array, or one rule per flag), runnerCommand. An
unknown key or a bad value is a usage error (exit 2). While checkCommand is
unresolved, submitted work is held until it is set (orchestrator-ctl config).

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
      set: { type: 'string', multiple: true },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }
  let flags: Overrides;
  try {
    flags = parseSetFlags(values.set ?? []);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`);
    process.exit(2);
  }
  let runId: string | undefined;
  let fileSetsMode = false;
  let dataDir: string;
  let resolveWith: (opts: ResolveOptions) => Promise<Resolved>;
  if (values.config) {
    const file = values.config;
    dataDir = (await loadConfig(file)).dataDir;
    fileSetsMode = rawRunnerMode(file) !== undefined;
    resolveWith = (opts) => resolveFileConfig(file, opts);
  } else {
    const repo = await resolveRepoPath({ repo: values.repo });
    ensureRunDir(repo);
    dataDir = (await resolveRunConfig(repo, process.env, { detect: false })).config.dataDir;
    runId = runIdFor(repo);
    fileSetsMode = (readRepoConfigRaw(repo)?.['runner'] as { mode?: unknown } | undefined)?.mode !== undefined;
    resolveWith = (opts) => resolveRunConfig(repo, process.env, opts);
  }
  await mkdir(dataDir, { recursive: true });
  const store = new SqliteStore(path.join(dataDir, 'store.sqlite'));
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

  // Arguments are durable overrides: merged over the store's document for resolution and persisted once the start is accepted, so a restart without flags keeps them and a refused start leaves nothing behind. See specs/toolchain-discovery "Resolution order and provenance".
  const overrides = mergeOverrides(readOverrides(store), flags);
  const pinned = store.getKv('integrationBranch') || undefined;
  const resolved = await resolveWith({ overrides, pinned });
  const config = resolved.config;

  // The branch the run first used is pinned; only an explicit layer can name another one, and only on an untouched run. See specs/toolchain-discovery "Integration branch detection and pinning".
  if (pinned && config.integrationBranch !== pinned) {
    const launches = store.listLaunches().length;
    const jobs = store.listJobs().length;
    if (launches || jobs) {
      const msg = `integration branch change refused: this run is pinned to ${pinned} and ${resolved.provenance.integrationBranch === 'file' ? 'orchestrator.yaml' : 'an argument'} names ${config.integrationBranch}; keep ${pinned} for this run (start without --set integrationBranch, or remove the key from orchestrator.yaml), or start from a fresh run directory to use ${config.integrationBranch}`;
      stderrLogger.error(msg, { pinned, requested: config.integrationBranch, source: resolved.provenance.integrationBranch, launches, jobs });
      store.close();
      throw new Error(msg);
    }
    stderrLogger.info('integration branch re-pinned on an untouched run', { from: pinned, to: config.integrationBranch, source: resolved.provenance.integrationBranch });
    store.setKv('integrationBranch', config.integrationBranch);
    store.setKv('baselineHead', await revParse(config.repoPath, config.integrationBranch));
  } else {
    if (!pinned) store.setKv('integrationBranch', config.integrationBranch);
    if (!store.getKv('baselineHead')) store.setKv('baselineHead', await revParse(config.repoPath, config.integrationBranch));
  }
  if (Object.keys(flags).length) store.setKv('config.overrides', JSON.stringify(overrides));
  const report = reportOf(resolved, Date.now());
  writeConfigJson(dataDir, report);
  store.appendEvent({ kind: 'config.resolved', payload: configSummary(report) }, Date.now());
  stderrLogger.info('configuration resolved', configSummary(report));

  // The runner command, its allow list, and the check command are read from the effective configuration at every spawn and at every job start. See specs/toolchain-discovery "Runtime overrides and start-only keys".
  let orch!: Orchestrator;
  const runner = new ClaudeCodeRunner({
    command: () => orch.effective().config.runnerCommand,
    allowedTools: () => orch.effective().allowedTools.value,
    logDir: path.join(config.dataDir, 'logs'),
    retryWindowMs: config.retryWindowMs,
  });
  const workspace = new GitWorkspace(config.repoPath, config.integrationBranch, path.join(config.dataDir, 'worktrees'));
  const verifier = new GitVerifierBackend({
    repo: config.repoPath,
    integrationBranch: config.integrationBranch,
    tempRoot: path.join(config.dataDir, 'verify'),
    checkCommand: () => orch.effective().config.checkCommand,
    checkTimeoutMs: config.checkTimeoutMs,
    baselineSha: store.getKv('baselineHead'),
  });
  orch = new Orchestrator({
    store,
    config,
    resolved,
    graphSource: new FileGraphSource(config.graphPath),
    runner,
    workspace,
    verifier,
    briefValidator: new SlotValidator(config.briefSlots),
    log: stderrLogger,
  });
  orch.onConfigChanged = (r) => {
    try {
      writeConfigJson(dataDir, r);
    } catch (err) {
      stderrLogger.warn('could not write config.json', { err: String(err) });
    }
  };
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
