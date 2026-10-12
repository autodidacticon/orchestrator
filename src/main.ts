#!/usr/bin/env node
/**
 * Daemon entrypoint.
 *   orchestrator --config orchestrator.yaml [--reap-on-exit]
 * SIGTERM/SIGINT: graceful stop (agents keep running for adoption) unless --reap-on-exit.
 */
import { mkdir } from 'node:fs/promises';
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
import { revParse } from './workspace/git.js';
import { GitWorkspace } from './workspace/git-workspace.js';

export const stderrLogger: Logger = {
  info: (msg, data) => process.stderr.write(`${new Date().toISOString()} INFO ${msg}${data ? ` ${JSON.stringify(data)}` : ''}\n`),
  warn: (msg, data) => process.stderr.write(`${new Date().toISOString()} WARN ${msg}${data ? ` ${JSON.stringify(data)}` : ''}\n`),
  error: (msg, data) => process.stderr.write(`${new Date().toISOString()} ERROR ${msg}${data ? ` ${JSON.stringify(data)}` : ''}\n`),
};

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: 'string', short: 'c', default: 'orchestrator.yaml' },
      'reap-on-exit': { type: 'boolean', default: false },
    },
  });
  const config = await loadConfig(values.config as string);
  await mkdir(config.dataDir, { recursive: true });
  const store = new SqliteStore(path.join(config.dataDir, 'store.sqlite'));
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
  const url = await server.listen(config.apiPort);
  store.setKv('apiBaseUrl', url);
  stderrLogger.info('listening', { url, pid: process.pid });

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    stderrLogger.info('shutting down', { signal, reap: values['reap-on-exit'] });
    await orch.stop({ reap: Boolean(values['reap-on-exit']) });
    await server.close();
    store.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await orch.start();
}

const isEntry = process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href;
if (isEntry) {
  main().catch((err) => {
    stderrLogger.error('fatal', { err: String(err instanceof Error ? err.stack : err) });
    process.exit(1);
  });
}
