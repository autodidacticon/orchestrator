#!/usr/bin/env node
/**
 * orchestrator-worker: the remote worker loop. It claims a remote launch over the daemon's API, prepares its own clone
 * of the repository on the launch branch, writes the brief and the MCP config into `.orchestrator/`, runs the agent
 * (a command template, or the scripted agent), relays a fallback report the agent left, and claims again. With nothing
 * claimable it polls with backoff, and it exits 0 when the run is finished or after the idle limit.
 * See specs/worker-pool.
 */
import { spawn } from 'node:child_process';
import { hostname } from 'node:os';
import { chmod, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isEntrypoint } from '../entry.js';
import { withoutStore } from '../runs/childEnv.js';
import type { Launch } from '../state/store.js';
import { fixedSlots, quoteRules, substitute } from '../runner/command.js';
import { shimCommand, shimEnv } from '../runner/shim-command.js';
import { FALLBACK_FILE, gitOut, ORCH_DIR, prepareClone } from './clone.js';
import { type ApiCall, apiClient, type ApiResult, realSleep } from './http.js';
import { runScriptedAgent } from './scripted.js';

export const DEFAULT_WORKER_CACHE = '/var/cache/orchestrator';
export const DEFAULT_RETRY_WINDOW_MS = 60_000;
export const DEFAULT_BACKOFF_MS = 1000;
export const DEFAULT_BACKOFF_MAX_MS = 30_000;

export type WorkerAgent = 'scripted' | 'command';

export interface WorkerSettings {
  /** The daemon's API (`ORCH_API`). */
  api: string;
  /** `POD_NAME`, else `ORCH_WORKER_ID`, else the host name. */
  workerId: string;
  /** The clone cache (`ORCH_WORKER_CACHE`). */
  cache: string;
  agent: WorkerAgent;
  /** The agent command template (`ORCH_WORKER_COMMAND`); required for the `command` agent. */
  command?: string;
  /** Exit 0 after this long with nothing claimable; 0 never (`ORCH_WORKER_IDLE_EXIT_MS`). */
  idleExitMs: number;
  /** How long connection failures are retried (`ORCH_RETRY_WINDOW_MS`). */
  retryWindowMs: number;
  /** The first delay after a 404 (`ORCH_WORKER_BACKOFF_MS`), doubled up to `backoffMaxMs` (`ORCH_WORKER_BACKOFF_MAX_MS`). */
  backoffMs: number;
  backoffMaxMs: number;
}

function nonNegative(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${key} must be a non-negative integer of milliseconds; got ${JSON.stringify(raw)}`);
  return n;
}

/** The loop's settings from its environment; throws naming the variable that is missing or malformed. */
export function workerSettings(env: NodeJS.ProcessEnv, host: () => string = hostname): WorkerSettings {
  const api = (env['ORCH_API'] ?? '').trim();
  if (!api) throw new Error('ORCH_API is required: the URL of the orchestrator daemon');
  const agentRaw = (env['ORCH_WORKER_AGENT'] ?? '').trim() || 'command';
  if (agentRaw !== 'scripted' && agentRaw !== 'command') throw new Error(`ORCH_WORKER_AGENT must be scripted or command; got ${JSON.stringify(agentRaw)}`);
  const command = env['ORCH_WORKER_COMMAND']?.trim() || undefined;
  if (agentRaw === 'command' && !command) throw new Error('ORCH_WORKER_COMMAND is required when ORCH_WORKER_AGENT is command (the default): the agent command template');
  const workerId = env['POD_NAME']?.trim() || env['ORCH_WORKER_ID']?.trim() || host();
  const backoffMs = nonNegative(env, 'ORCH_WORKER_BACKOFF_MS', DEFAULT_BACKOFF_MS);
  return {
    api: api.replace(/\/+$/, ''),
    workerId,
    cache: env['ORCH_WORKER_CACHE']?.trim() || DEFAULT_WORKER_CACHE,
    agent: agentRaw,
    ...(command ? { command } : {}),
    idleExitMs: nonNegative(env, 'ORCH_WORKER_IDLE_EXIT_MS', 0),
    retryWindowMs: nonNegative(env, 'ORCH_RETRY_WINDOW_MS', DEFAULT_RETRY_WINDOW_MS),
    backoffMs: Math.max(1, backoffMs),
    backoffMaxMs: Math.max(Math.max(1, backoffMs), nonNegative(env, 'ORCH_WORKER_BACKOFF_MAX_MS', DEFAULT_BACKOFF_MAX_MS)),
  };
}

/** The delays between claims while nothing is claimable: `first`, doubling, capped at `max`; reset after a claim. */
export class Backoff {
  private next: number;
  constructor(
    private readonly first: number,
    private readonly max: number,
  ) {
    this.next = first;
  }
  delay(): number {
    const d = this.next;
    this.next = Math.min(this.next * 2, this.max);
    return d;
  }
  reset(): void {
    this.next = this.first;
  }
}

/** The fields of a remote claim response the loop uses. See specs/pull-runner "Claim". */
export interface RemoteClaim {
  launchId: string;
  taskId: string;
  token: string;
  branch: string;
  baseSha: string;
  repoUrl?: string;
  model?: string;
  effort?: string;
  brief?: Record<string, unknown>;
  briefMarkdown?: string;
  carry?: { interrupted?: { headSha?: string } };
}

function claimOf(body: Record<string, unknown>): RemoteClaim {
  const str = (k: string) => (typeof body[k] === 'string' ? (body[k] as string) : undefined);
  return {
    launchId: str('launchId') ?? '',
    taskId: str('taskId') ?? '',
    token: str('token') ?? '',
    branch: str('branch') ?? '',
    baseSha: str('baseSha') ?? '',
    repoUrl: str('repoUrl'),
    model: str('model'),
    effort: str('effort'),
    brief: body['brief'] && typeof body['brief'] === 'object' ? (body['brief'] as Record<string, unknown>) : undefined,
    briefMarkdown: str('briefMarkdown'),
    carry: body['carry'] && typeof body['carry'] === 'object' ? (body['carry'] as RemoteClaim['carry']) : undefined,
  };
}

/** The commit a launch's branch starts at: the kept head of an interrupted attempt, else the base. */
export function startOf(claim: Pick<RemoteClaim, 'baseSha' | 'carry'>): string {
  const head = claim.carry?.interrupted?.headSha;
  return typeof head === 'string' && head ? head : claim.baseSha;
}

/**
 * The agent command for a launch: the template with its slots filled by the same substitution every runner uses
 * (`substitute` and `fixedSlots` in src/runner/command.ts), with the clone as the worktree and the brief's allow list
 * in `{allowedTools}`. See specs/worker-pool "Agent command".
 */
export function composeAgentCommand(template: string, claim: Pick<RemoteClaim, 'launchId' | 'taskId' | 'model' | 'effort' | 'brief'>, clone: string): string {
  const rules = Array.isArray(claim.brief?.['allowedTools']) ? (claim.brief!['allowedTools'] as unknown[]).map(String) : [];
  return substitute(template, {
    ...fixedSlots({ worktree: clone, launchId: claim.launchId, taskId: claim.taskId, model: claim.model, effort: claim.effort as Launch['effort'] }),
    allowedTools: quoteRules(rules),
  });
}

export interface WorkerDeps {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** One line to stdout per step. */
  out?: (line: string) => void;
  /** Details and the agent's output (stderr). */
  err?: (text: string) => void;
}

/** Where the daemon has a launch after its agent exited: reported (submitted or done), still held by this worker, or ended. */
export function launchState(status: Record<string, unknown>, workerId: string, claim: Pick<RemoteClaim, 'launchId' | 'taskId'>): 'reported' | 'held' | 'ended' {
  const by = (status['byStatus'] ?? {}) as Record<string, unknown>;
  const has = (k: string) => Array.isArray(by[k]) && (by[k] as unknown[]).includes(claim.taskId);
  if (has('submitted') || has('done')) return 'reported';
  const workers = Array.isArray(status['workers']) ? (status['workers'] as Array<Record<string, unknown>>) : [];
  const holds = workers.some((w) => w['id'] === workerId && w['launchId'] === claim.launchId);
  return holds && (has('running') || has('waiting')) ? 'held' : 'ended';
}

/** Run the loop until the run is finished or the idle limit passes (0), or a fatal claim refusal (1). */
export async function runWorkerLoop(s: WorkerSettings, deps: WorkerDeps = {}): Promise<number> {
  const sleep = deps.sleep ?? realSleep;
  const now = deps.now ?? Date.now;
  const out = deps.out ?? ((line: string) => void process.stdout.write(`${line}\n`));
  const err = deps.err ?? ((text: string) => void process.stderr.write(text));
  const call = apiClient({ api: s.api, retryWindowMs: s.retryWindowMs, fetch: deps.fetch, sleep, now });
  const log = (event: string, c?: Pick<RemoteClaim, 'launchId' | 'taskId'>, detail?: string) => {
    out(`worker ${s.workerId} ${event} ${c?.launchId || '-'} ${c?.taskId || '-'}`);
    if (detail) err(`worker ${s.workerId} ${event}: ${detail}\n`);
  };
  const backoff = new Backoff(s.backoffMs, s.backoffMaxMs);
  let idleSince = now();
  let refusedOnce = false;
  log('start');
  for (;;) {
    const c = await call('POST', '/v1/claims', { workerId: s.workerId, access: 'remote' });
    if (c.status === 200) {
      backoff.reset();
      refusedOnce = false;
      await workLaunch(s, call, claimOf(c.body), { log, err, sleep });
      idleSince = now();
      continue;
    }
    if (c.status === 400) {
      log('claim-refused', undefined, `${c.status} ${JSON.stringify(c.body).slice(0, 300)}`);
      return 1;
    }
    // 404: nothing claimable (or paused); 409: the graph is not loaded, or the run's access is not remote. Both wait.
    if (c.status !== 404 && !refusedOnce) {
      refusedOnce = true;
      log('claim-refused', undefined, `${c.status} ${JSON.stringify(c.body).slice(0, 300)}`);
    }
    const st = await call('GET', '/v1/status');
    if (st.status === 200 && st.body['finished'] === true) {
      log('finished');
      return 0;
    }
    if (s.idleExitMs > 0 && now() - idleSince >= s.idleExitMs) {
      log('idle-exit');
      return 0;
    }
    await sleep(backoff.delay());
  }
}

interface LaunchTools {
  log: (event: string, c?: Pick<RemoteClaim, 'launchId' | 'taskId'>, detail?: string) => void;
  err: (text: string) => void;
  sleep: (ms: number) => Promise<void>;
}

/** One claimed launch, from the clone to the daemon's verdict. Never throws: a failure is logged and the loop claims again. */
async function workLaunch(s: WorkerSettings, call: ApiCall, claim: RemoteClaim, t: LaunchTools): Promise<void> {
  const { log } = t;
  log('claimed', claim);
  let accepted = false;
  let clone: string | undefined;
  try {
    if (!claim.repoUrl) throw new Error('the claim carries no repoUrl (set git.workerOriginUrl or git.originUrl on the daemon)');
    clone = await prepareClone({ cache: s.cache, repoUrl: claim.repoUrl, branch: claim.branch, start: startOf(claim) });
  } catch (e) {
    log('checkout-failed', claim, e instanceof Error ? e.message : String(e));
    await release(call, s, claim, `the worker could not prepare its clone: ${e instanceof Error ? e.message : String(e)}`, t);
    return;
  }
  log('checkout', claim, `${clone} on ${claim.branch} at ${startOf(claim)}`);
  try {
    await writeLaunchFiles(s, claim, clone);
    log('agent-start', claim);
    if (s.agent === 'scripted') {
      const res = await runScriptedAgent({
        call,
        clone,
        workerId: s.workerId,
        sleep: t.sleep,
        launch: { launchId: claim.launchId, taskId: claim.taskId, token: claim.token, branch: claim.branch, acceptanceCriteria: criteriaOf(claim) },
      });
      accepted = isAccepted(res);
      if (res && !accepted) t.err(`worker ${s.workerId} submit ${claim.taskId}: ${res.status} ${JSON.stringify(res.body).slice(0, 300)}\n`);
    } else {
      const code = await runCommand(composeAgentCommand(s.command!, claim, clone), clone, agentEnv(s, claim, clone), t.err);
      t.err(`worker ${s.workerId} agent ${claim.taskId} exited with ${code}\n`);
    }
    log('agent-exit', claim);
  } catch (e) {
    log('agent-error', claim, e instanceof Error ? e.message : String(e));
  }
  const relayed = await relayFallback(s, call, claim, clone, t);
  accepted ||= relayed;
  let state: 'reported' | 'held' | 'ended' = 'ended';
  try {
    const st = await call('GET', '/v1/status');
    if (st.status === 200) state = launchState(st.body, s.workerId, claim);
  } catch (e) {
    t.err(`worker ${s.workerId} status: ${e instanceof Error ? e.message : String(e)}\n`);
  }
  if (accepted || state === 'reported') {
    log('report accepted', claim);
    return;
  }
  if (state === 'held') {
    await release(call, s, claim, 'the agent exited without a report', t);
    return;
  }
  log('ended', claim);
}

const isAccepted = (r: ApiResult | undefined): boolean => r !== undefined && r.status === 200 && r.body['accepted'] === true;

function criteriaOf(claim: RemoteClaim): string[] {
  const c = claim.brief?.['acceptanceCriteria'];
  return Array.isArray(c) ? c.map(String) : [];
}

/** The agent's environment: the loop's own, the launch's identity for the API, and the clone as the worktree; never the store's connection. */
function agentEnv(s: WorkerSettings, claim: RemoteClaim, clone: string): Record<string, string | undefined> {
  return withoutStore({
    ...process.env,
    ORCH_API: s.api,
    ORCH_LAUNCH_ID: claim.launchId,
    ORCH_TOKEN: claim.token,
    ORCH_RETRY_WINDOW_MS: String(s.retryWindowMs),
    ORCH_TASK_ID: claim.taskId,
    ORCH_WORKTREE: clone,
  });
}

/**
 * `.orchestrator/brief.md` (the claim's `briefMarkdown`), `brief.json` (the claim's `brief`, its `worktree` the clone)
 * and `mcp.json` (the MCP shim with the launch token, mode 0600), as the Claude Code runner writes them for a local launch.
 */
async function writeLaunchFiles(s: WorkerSettings, claim: RemoteClaim, clone: string): Promise<void> {
  const dir = path.join(clone, ORCH_DIR);
  await writeFile(path.join(dir, 'brief.md'), claim.briefMarkdown ?? '', 'utf8');
  await writeFile(path.join(dir, 'brief.json'), `${JSON.stringify({ ...(claim.brief ?? {}), worktree: clone }, null, 2)}\n`, 'utf8');
  const shim = shimCommand();
  const mcp = { mcpServers: { orchestrator: { command: shim.command, args: shim.args, env: shimEnv(claim, { ORCH_API: s.api }, s.retryWindowMs) } } };
  const mcpPath = path.join(dir, 'mcp.json');
  await writeFile(mcpPath, JSON.stringify(mcp, null, 2), { encoding: 'utf8', mode: 0o600 });
  await chmod(mcpPath, 0o600);
}

/** Run the agent command in the clone through `/bin/sh -c`, its output to `err`; answers the exit code (signal: 128+). */
function runCommand(cmd: string, cwd: string, env: Record<string, string | undefined>, err: (text: string) => void): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', cmd], { cwd, env: env as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d: Buffer) => err(d.toString()));
    child.stderr.on('data', (d: Buffer) => err(d.toString()));
    child.on('error', (e) => {
      err(`agent spawn failed: ${e.message}\n`);
      resolve(127);
    });
    child.on('close', (code, signal) => resolve(code ?? (signal ? 128 : 1)));
  });
}

/**
 * Post the fallback report an agent left in `.orchestrator/report.json` to the launch's report route (a `block` to the
 * block route) with the launch token, then delete the file. A submit without `sealedSha` gets the clone's HEAD, pushed
 * to the launch branch first. Answers whether the daemon accepted a submission. See specs/worker-pool "Fallback relay".
 */
async function relayFallback(s: WorkerSettings, call: ApiCall, claim: RemoteClaim, clone: string | undefined, t: LaunchTools): Promise<boolean> {
  if (!clone) return false;
  const file = path.join(clone, ORCH_DIR, FALLBACK_FILE);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return false;
  }
  try {
    return await postFallback(s, call, claim, clone, text, t);
  } finally {
    // Deleted after the post, whatever the answer: a report the daemon refused is not relayed again by the next launch.
    await rm(file, { force: true });
  }
}

async function postFallback(s: WorkerSettings, call: ApiCall, claim: RemoteClaim, clone: string, text: string, t: LaunchTools): Promise<boolean> {
  let parsed: { seq?: unknown; kind?: unknown; body?: unknown };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch (e) {
    t.log('relay-failed', claim, `the fallback report is not JSON: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
  const kind = parsed.kind === 'submit' || parsed.kind === 'fail' || parsed.kind === 'block' ? parsed.kind : undefined;
  if (!kind) {
    t.log('relay-failed', claim, `the fallback report has no kind submit, fail or block: ${text.slice(0, 200)}`);
    return false;
  }
  const body: Record<string, unknown> = { ...(parsed.body && typeof parsed.body === 'object' ? (parsed.body as Record<string, unknown>) : {}), seq: Number(parsed.seq ?? 0) };
  if (kind === 'submit' && typeof body['sealedSha'] !== 'string') {
    try {
      await gitOut(clone, ['push', '-q', 'origin', `HEAD:refs/heads/${claim.branch}`]);
    } catch (e) {
      t.err(`worker ${s.workerId} relay push ${claim.taskId}: ${e instanceof Error ? e.message : String(e)}\n`);
    }
    body['sealedSha'] = await gitOut(clone, ['rev-parse', 'HEAD']).catch(() => undefined);
  }
  let res: ApiResult;
  try {
    res = kind === 'block' ? await call('POST', `/v1/launches/${claim.launchId}/block`, body, claim.token) : await call('POST', `/v1/launches/${claim.launchId}/report`, { ...body, kind }, claim.token);
  } catch (e) {
    t.log('relay-failed', claim, e instanceof Error ? e.message : String(e));
    return false;
  }
  t.log('relayed', claim, `${kind} -> ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
  return kind === 'submit' && isAccepted(res);
}

async function release(call: ApiCall, s: WorkerSettings, claim: RemoteClaim, reason: string, t: LaunchTools): Promise<void> {
  try {
    const r = await call('POST', `/v1/launches/${claim.launchId}/release`, { workerId: s.workerId, reason });
    t.log('released', claim, `${reason} -> ${r.status} ${String(r.body['outcome'] ?? r.body['reason'] ?? '')}`);
  } catch (e) {
    t.log('release-failed', claim, e instanceof Error ? e.message : String(e));
  }
}

export const USAGE = `orchestrator-worker: the remote worker loop.

Claims remote launches from the orchestrator daemon, works each in a cached clone
of the repository on the launch branch, and claims again; exits 0 when the run is
finished. Environment:
  ORCH_API                   the daemon's URL (required)
  POD_NAME                   the worker id; else ORCH_WORKER_ID; else the host name
  ORCH_WORKER_CACHE          clone cache directory (default ${DEFAULT_WORKER_CACHE})
  ORCH_WORKER_AGENT          scripted | command (default command)
  ORCH_WORKER_COMMAND        the agent command template for command; {brief}, {briefJson},
                             {worktree}, {launchId}, {taskId}, {mcpConfig}, {allowedTools},
                             {model} and {effort} are substituted
  ORCH_WORKER_IDLE_EXIT_MS   exit 0 after this long with nothing claimable (default 0, never)
  ORCH_RETRY_WINDOW_MS       how long connection failures are retried (default ${DEFAULT_RETRY_WINDOW_MS})
  ORCH_WORKER_BACKOFF_MS     first poll delay with nothing claimable (default ${DEFAULT_BACKOFF_MS})
  ORCH_WORKER_BACKOFF_MAX_MS the longest poll delay (default ${DEFAULT_BACKOFF_MAX_MS})
`;

if (isEntrypoint(import.meta.url)) {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write(USAGE);
  } else {
    let settings: WorkerSettings;
    try {
      settings = workerSettings(process.env);
    } catch (e) {
      process.stderr.write(`orchestrator-worker: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(2);
    }
    // Exit once stdout has drained: the last lines (`finished`, `report accepted`) are what a reader counts.
    const exit = (code: number) => process.stdout.write('', () => process.exit(code));
    runWorkerLoop(settings).then(exit, (e) => {
      process.stderr.write(`orchestrator-worker: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
      exit(1);
    });
  }
}
