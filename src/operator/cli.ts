#!/usr/bin/env node
/**
 * Operator CLI over the daemon's HTTP API.
 *   orchestrator-ctl status
 *   orchestrator-ctl answer <task> <text>
 *   orchestrator-ctl cancel <task> [--release] [--reason <text>]
 *   orchestrator-ctl reopen <task>
 *   orchestrator-ctl unblock <task> [--answer <text>] [--accept-candidate]
 *   orchestrator-ctl accept <milestone> --sha <sha> --version <n>
 *   orchestrator-ctl reject <milestone> --note <text>
 *   orchestrator-ctl pause | resume [--override-budget]
 *   orchestrator-ctl nudge <task> <message>
 *   orchestrator-ctl logs <task> [--launch <n>]
 *   orchestrator-ctl outbox [--after <id>] [--limit <n>]
 *   orchestrator-ctl ack <id> [--result <json>] [--error <text>]
 * The daemon URL comes from --url, ORCH_URL, or the store under --data-dir.
 */
import path from 'node:path';
import { parseArgs } from 'node:util';
import { daemonState, listRuns, startDaemon, stopDaemon } from '../runs/lifecycle.js';
import { resolveRepoPath, runPaths } from '../runs/runDir.js';
import { SqliteStore } from '../state/sqlite.js';

export interface CliResult {
  status: number;
  body: unknown;
}

export async function resolveUrl(opts: { url?: string; dataDir?: string; repo?: string }): Promise<string> {
  if (opts.url) return opts.url;
  if (process.env['ORCH_URL']) return process.env['ORCH_URL'] as string;
  if (!opts.dataDir) {
    try {
      const repo = await resolveRepoPath({ repo: opts.repo });
      const state = await daemonState(runPaths(repo).runDir);
      if (state.healthy && state.url) return state.url;
      if (!process.env['ORCH_DATA_DIR']) throw new Error(`no running daemon for ${repo} (run dir ${state.runDir}); run \`orchestrator-ctl start\``);
    } catch (err) {
      if (!process.env['ORCH_DATA_DIR']) throw err;
    }
  }
  const dataDir = opts.dataDir ?? process.env['ORCH_DATA_DIR'] ?? '.orchestrator-run';
  const store = new SqliteStore(path.join(dataDir, 'store.sqlite'));
  try {
    const url = store.getKv('apiBaseUrl');
    if (!url) throw new Error(`no daemon url recorded in ${dataDir}; pass --url`);
    return url;
  } finally {
    store.close();
  }
}

export async function call(base: string, method: 'GET' | 'POST', route: string, body?: Record<string, unknown>): Promise<CliResult> {
  // Bodies are JSON documents; a result may be any JSON value.
  const res = await fetch(`${base}${route}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

export const USAGE = `orchestrator-ctl: operate a running orchestrator.

  orchestrator-ctl start [--repo <path>]       start the daemon for a repository (idempotent)
  orchestrator-ctl stop [--reap] [--repo <path>]
  orchestrator-ctl runs                         list runs under ORCH_HOME
  orchestrator-ctl status
  orchestrator-ctl answer <task> <text>
  orchestrator-ctl cancel <task> [--release] [--reason <text>]
  orchestrator-ctl reopen <task>
  orchestrator-ctl unblock <task> [--answer <text>] [--accept-candidate]
  orchestrator-ctl accept <milestone> --sha <sha> --version <n>
  orchestrator-ctl reject <milestone> --note <text>
  orchestrator-ctl pause | resume [--override-budget]   resume is refused over the cost ceiling without the flag
  orchestrator-ctl nudge <task> <message>       queue a message for the task's running agent
  orchestrator-ctl logs <task> [--launch <n>]
  orchestrator-ctl outbox [--after <id>] [--limit <n>]   pending tracker effects and the policy
  orchestrator-ctl ack <id> [--result <json>] [--error <text>]   acknowledge (or, with --error, reject) an effect

The daemon is found by --url, ORCH_URL, the run directory of --repo or the
current repository (ORCH_HOME, default ~/.orchestrator), or --data-dir.
`;

export async function runCli(argv: string[]): Promise<CliResult> {
  if (argv.includes('--help') || argv.includes('-h') || argv.length === 0) {
    return { status: 0, body: { usage: USAGE } };
  }
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      url: { type: 'string' },
      'data-dir': { type: 'string' },
      repo: { type: 'string' },
      reap: { type: 'boolean', default: false },
      release: { type: 'boolean', default: false },
      reason: { type: 'string' },
      answer: { type: 'string' },
      'accept-candidate': { type: 'boolean', default: false },
      sha: { type: 'string' },
      version: { type: 'string' },
      note: { type: 'string' },
      launch: { type: 'string' },
      after: { type: 'string' },
      limit: { type: 'string' },
      result: { type: 'string' },
      error: { type: 'string' },
      'override-budget': { type: 'boolean', default: false },
    },
  });
  const [cmd, a, ...rest] = positionals;
  if (cmd === 'start') {
    const r = await startDaemon({ repo: values.repo });
    return { status: 200, body: r };
  }
  if (cmd === 'stop') {
    const r = await stopDaemon({ repo: values.repo, reap: values.reap });
    return { status: r.stopped ? 200 : 409, body: r };
  }
  if (cmd === 'runs') {
    return { status: 200, body: { runs: await listRuns() } };
  }
  const base = await resolveUrl({ url: values.url, dataDir: values['data-dir'], repo: values.repo });
  switch (cmd) {
    case 'status':
      return call(base, 'GET', '/v1/status');
    case 'answer':
      return call(base, 'POST', `/v1/tasks/${a}/answer`, { text: rest.join(' ') });
    case 'cancel':
      return call(base, 'POST', `/v1/tasks/${a}/cancel`, { reason: values.reason ?? 'cancelled by operator', release: values.release });
    case 'reopen':
      return call(base, 'POST', `/v1/tasks/${a}/reopen`);
    case 'unblock':
      return call(base, 'POST', `/v1/tasks/${a}/unblock`, { answer: values.answer, acceptCandidate: values['accept-candidate'] });
    case 'accept':
      return call(base, 'POST', `/v1/milestones/${a}/accept`, { sha: values.sha, version: Number(values.version) });
    case 'reject':
      return call(base, 'POST', `/v1/milestones/${a}/reject`, { note: values.note ?? rest.join(' ') });
    case 'pause':
      return call(base, 'POST', '/v1/pause');
    case 'resume':
      return call(base, 'POST', '/v1/resume', { overrideBudget: values['override-budget'] });
    case 'nudge':
      if (!a) throw new Error('nudge needs a task id and a message');
      return call(base, 'POST', `/v1/tasks/${a}/nudge`, { message: rest.join(' ') });
    case 'logs':
      return call(base, 'GET', `/v1/tasks/${a}/logs${values.launch ? `?launch=${values.launch}` : ''}`);
    case 'outbox': {
      const q = new URLSearchParams();
      if (values.after) q.set('after', values.after);
      if (values.limit) q.set('limit', values.limit);
      const qs = q.toString();
      return call(base, 'GET', `/v1/outbox${qs ? `?${qs}` : ''}`);
    }
    case 'ack': {
      if (!a) throw new Error('ack needs an effect id');
      if (values.error !== undefined) return call(base, 'POST', `/v1/outbox/${a}/nack`, { error: values.error });
      return call(base, 'POST', `/v1/outbox/${a}/ack`, { result: values.result ? (JSON.parse(values.result) as unknown) : {} });
    }
    case 'tick':
      return call(base, 'POST', '/v1/tick');
    default:
      throw new Error(`unknown command ${cmd ?? '(none)'}; see --help in the file header`);
  }
}

const isEntry = process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href;
if (isEntry) {
  runCli(process.argv.slice(2))
    .then((r) => {
      const body = r.body as { log?: string; usage?: string } | undefined;
      if (body && typeof body.usage === 'string') process.stdout.write(body.usage);
      else if (body && typeof body.log === 'string') process.stdout.write(body.log);
      else process.stdout.write(`${JSON.stringify(r.body, null, 2)}\n`);
      process.exit(r.status < 400 ? 0 : 1);
    })
    .catch((err) => {
      process.stderr.write(`${String(err)}\n`);
      process.exit(2);
    });
}
