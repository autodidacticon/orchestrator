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
 *   orchestrator-ctl pause | resume
 *   orchestrator-ctl logs <task> [--launch <n>]
 * The daemon URL comes from --url, ORCH_URL, or the store under --data-dir.
 */
import path from 'node:path';
import { parseArgs } from 'node:util';
import { SqliteStore } from '../state/sqlite.js';

export interface CliResult {
  status: number;
  body: unknown;
}

export async function resolveUrl(opts: { url?: string; dataDir?: string }): Promise<string> {
  if (opts.url) return opts.url;
  if (process.env['ORCH_URL']) return process.env['ORCH_URL'] as string;
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
  const res = await fetch(`${base}${route}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

export async function runCli(argv: string[]): Promise<CliResult> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      url: { type: 'string' },
      'data-dir': { type: 'string' },
      release: { type: 'boolean', default: false },
      reason: { type: 'string' },
      answer: { type: 'string' },
      'accept-candidate': { type: 'boolean', default: false },
      sha: { type: 'string' },
      version: { type: 'string' },
      note: { type: 'string' },
      launch: { type: 'string' },
    },
  });
  const [cmd, a, ...rest] = positionals;
  const base = await resolveUrl({ url: values.url, dataDir: values['data-dir'] });
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
      return call(base, 'POST', '/v1/resume');
    case 'logs':
      return call(base, 'GET', `/v1/tasks/${a}/logs${values.launch ? `?launch=${values.launch}` : ''}`);
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
      const body = r.body as { log?: string } | undefined;
      if (body && typeof body.log === 'string') process.stdout.write(body.log);
      else process.stdout.write(`${JSON.stringify(r.body, null, 2)}\n`);
      process.exit(r.status < 400 ? 0 : 1);
    })
    .catch((err) => {
      process.stderr.write(`${String(err)}\n`);
      process.exit(2);
    });
}
