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
import { treeFingerprint } from '../workspace/fingerprint.js';
import { FALLBACK_FILE, gitOut, ORCH_DIR, prepareClone } from './clone.js';
import { type ApiCall, apiClient, type ApiResult, realSleep } from './http.js';
import { runScriptedAgent } from './scripted.js';
import { type AgentHandle, DEFAULT_AGENT_STOP_MS, handBack, handBackExitCode, POD_TERMINATING, pushHead, stopAgent, TERMINATION_CALL_MS, TERMINATION_PUSH_MS, withLimit } from './terminate.js';

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
  /** Claim only this task id (`ORCH_WORKER_TASK`); unset claims any. */
  task?: string;
  /** Exit 0 after this many launches (`ORCH_WORKER_MAX_LAUNCHES`); unset or 0 never. */
  maxLaunches?: number;
  /** On termination, how long the agent's process group has after SIGTERM before SIGKILL (`ORCH_WORKER_AGENT_STOP_MS`); unset is 10000. */
  agentStopMs?: number;
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
  const task = env['ORCH_WORKER_TASK']?.trim() || undefined;
  const maxRaw = env['ORCH_WORKER_MAX_LAUNCHES'];
  let maxLaunches: number | undefined;
  if (maxRaw !== undefined && maxRaw.trim() !== '') {
    maxLaunches = Number(maxRaw);
    if (!Number.isSafeInteger(maxLaunches) || maxLaunches < 0) throw new Error(`ORCH_WORKER_MAX_LAUNCHES must be a non-negative integer; got ${JSON.stringify(maxRaw)}`);
  }
  const stopRaw = env['ORCH_WORKER_AGENT_STOP_MS'];
  const agentStopMs = stopRaw !== undefined && stopRaw.trim() !== '' ? nonNegative(env, 'ORCH_WORKER_AGENT_STOP_MS', DEFAULT_AGENT_STOP_MS) : undefined;
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
    ...(task ? { task } : {}),
    ...(maxLaunches ? { maxLaunches } : {}),
    ...(agentStopMs !== undefined ? { agentStopMs } : {}),
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
  /** The lease facts of the claim (`lease.ttlMs`, `lease.renewEveryMs`). */
  lease?: { ttlMs?: number; renewEveryMs?: number };
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
    lease: body['lease'] && typeof body['lease'] === 'object' ? (body['lease'] as RemoteClaim['lease']) : undefined,
  };
}

/** How often the loop heartbeats a launch: the claim's `lease.renewEveryMs`, else a third of `lease.ttlMs`; undefined without either. */
export function heartbeatEveryMs(claim: Pick<RemoteClaim, 'lease'>): number | undefined {
  const every = claim.lease?.renewEveryMs;
  if (typeof every === 'number' && Number.isFinite(every) && every > 0) return every;
  const ttl = claim.lease?.ttlMs;
  if (typeof ttl === 'number' && Number.isFinite(ttl) && ttl > 0) return Math.max(1, Math.floor(ttl / 3));
  return undefined;
}

/** The clone's fingerprint as a loop heartbeat carries it: the one function `GitWorkspace.fingerprint` uses. */
export const cloneFingerprint: (dir: string) => Promise<string> = treeFingerprint;

/** Run `fn` once after `ms`; answers a cancel. */
export type Schedule = (fn: () => void, ms: number) => () => void;

const realSchedule: Schedule = (fn, ms) => {
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
};

export interface LoopHeartbeat {
  /** Cancel the next heartbeat and wait for one in flight; none is sent after this resolves. */
  stop(): Promise<void>;
  /** Heartbeats sent so far. */
  sent(): number;
  /** Whether a heartbeat was answered 401: the launch was revoked, and none follows. */
  revoked(): boolean;
}

/**
 * The loop's heartbeat for one launch: every `everyMs` from the claim until `stop`, `POST /v1/launches/:id/heartbeat`
 * with the launch token, carrying the clone's fingerprint once the clone exists (`clone()`). It carries no text, so
 * the daemon renews the lease and counts only a changed fingerprint as progress. A 401 ends the heartbeats for the
 * launch. The next heartbeat is scheduled after the previous one is answered, so two never overlap.
 * See specs/worker-pool "Loop heartbeat".
 */
export function startLoopHeartbeat(o: { call: ApiCall; claim: Pick<RemoteClaim, 'launchId' | 'token'>; everyMs: number; clone: () => string | undefined; schedule?: Schedule; err?: (text: string) => void; fingerprint?: (dir: string) => Promise<string> }): LoopHeartbeat {
  const schedule = o.schedule ?? realSchedule;
  const fingerprintOf = o.fingerprint ?? cloneFingerprint;
  let stopped = false;
  let revoked = false;
  let sent = 0;
  let cancel: (() => void) | undefined;
  let inFlight: Promise<void> | undefined;
  const beat = async () => {
    const body: Record<string, unknown> = {};
    const dir = o.clone();
    if (dir) {
      try {
        body['fingerprint'] = await fingerprintOf(dir);
      } catch (e) {
        o.err?.(`heartbeat ${o.claim.launchId}: no fingerprint: ${e instanceof Error ? e.message : String(e)}\n`);
      }
    }
    if (stopped) return;
    sent++;
    try {
      const r = await o.call('POST', `/v1/launches/${o.claim.launchId}/heartbeat`, body, o.claim.token);
      if (r.status === 401) revoked = true;
      else if (r.status !== 200) o.err?.(`heartbeat ${o.claim.launchId}: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}\n`);
    } catch (e) {
      o.err?.(`heartbeat ${o.claim.launchId}: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  };
  const arm = () => {
    if (stopped || revoked) return;
    cancel = schedule(() => {
      cancel = undefined;
      inFlight = beat().finally(() => {
        inFlight = undefined;
        arm();
      });
    }, o.everyMs);
  };
  arm();
  return {
    stop: async () => {
      stopped = true;
      cancel?.();
      cancel = undefined;
      await inFlight;
    },
    sent: () => sent,
    revoked: () => revoked,
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
  /** The heartbeat timer (default `setTimeout`). */
  schedule?: Schedule;
  /** The scripted agent's silent step before it works, in ms (tests of the heartbeat). */
  scriptedIdleMs?: number;
  /**
   * The termination request: once aborted the loop stops the agent, hands a held launch back and claims no more. The
   * entry point aborts it on SIGTERM and SIGINT. See specs/worker-pool "Pod termination".
   */
  termination?: AbortSignal;
}

/** The termination request as the loop reads it: whether it was made, and a race against it. */
interface Termination {
  requested(): boolean;
  /** Resolves when the termination is requested; never without a request. */
  wait: Promise<void>;
  /** `p`'s value, or `{ ok: false }` when the termination is requested first (a later rejection of `p` is dropped). */
  race<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false }>;
}

function terminationOf(signal: AbortSignal | undefined): Termination {
  const wait = new Promise<void>((resolve) => {
    if (!signal) return;
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });
  return {
    requested: () => signal?.aborted === true,
    wait,
    race: <T>(p: Promise<T>) =>
      new Promise<{ ok: true; value: T } | { ok: false }>((resolve, reject) => {
        // One listener per race, removed when `p` settles, so an idle loop's rounds leave nothing behind.
        const onAbort = () => resolve({ ok: false });
        if (signal?.aborted) onAbort();
        else signal?.addEventListener('abort', onAbort, { once: true });
        p.then(
          (value) => {
            signal?.removeEventListener('abort', onAbort);
            resolve({ ok: true, value });
          },
          (e: unknown) => {
            signal?.removeEventListener('abort', onAbort);
            reject(e);
          },
        );
      }),
  };
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
  const longCall = apiClient({ api: s.api, retryWindowMs: s.retryWindowMs, fetch: deps.fetch, sleep, now });
  // After the termination request every call gets a short retry window, so the hand-back fits the grace period.
  const shortCall = apiClient({ api: s.api, retryWindowMs: Math.min(s.retryWindowMs, TERMINATION_CALL_MS), fetch: deps.fetch, sleep, now });
  const term = terminationOf(deps.termination);
  const call: ApiCall = (...a) => (term.requested() ? shortCall : longCall)(...a);
  const log = (event: string, c?: Pick<RemoteClaim, 'launchId' | 'taskId'>, detail?: string) => {
    out(`worker ${s.workerId} ${event} ${c?.launchId || '-'} ${c?.taskId || '-'}`);
    if (detail) err(`worker ${s.workerId} ${event}: ${detail}\n`);
  };
  const backoff = new Backoff(s.backoffMs, s.backoffMaxMs);
  let idleSince = now();
  let refusedOnce = false;
  let launches = 0;
  let current: Pick<RemoteClaim, 'launchId' | 'taskId'> | undefined;
  log('start');
  void term.wait.then(() => log('terminating', current));
  for (;;) {
    if (term.requested()) return 0;
    // A claim in flight is awaited: a launch it answers is released at once, without keep.
    const c = await call('POST', '/v1/claims', { workerId: s.workerId, access: 'remote', ...(s.task ? { taskId: s.task } : {}) });
    if (c.status === 200) {
      const claim = claimOf(c.body);
      const tools: LaunchTools = { log, err, sleep, schedule: deps.schedule, scriptedIdleMs: deps.scriptedIdleMs, term };
      if (term.requested()) {
        log('claimed', claim);
        return releaseUnstarted(call, s, claim, tools);
      }
      backoff.reset();
      refusedOnce = false;
      current = claim;
      const exit = await workLaunch(s, call, claim, tools);
      current = undefined;
      if (exit !== undefined) return exit;
      if (term.requested()) return 0;
      idleSince = now();
      if (s.maxLaunches && ++launches >= s.maxLaunches) {
        log('max-launches');
        return 0;
      }
      continue;
    }
    if (term.requested()) return 0;
    if (c.status === 400) {
      log('claim-refused', undefined, `${c.status} ${JSON.stringify(c.body).slice(0, 300)}`);
      return 1;
    }
    // 404: nothing claimable (or paused); 409: the graph is not loaded, or the run's access is not remote. Both wait.
    if (c.status !== 404 && !refusedOnce) {
      refusedOnce = true;
      log('claim-refused', undefined, `${c.status} ${JSON.stringify(c.body).slice(0, 300)}`);
    }
    const read = await term.race(call('GET', '/v1/status'));
    if (!read.ok) return 0;
    const st = read.value;
    if (st.status === 200 && st.body['finished'] === true) {
      log('finished');
      return 0;
    }
    if (s.idleExitMs > 0 && now() - idleSince >= s.idleExitMs) {
      log('idle-exit');
      return 0;
    }
    if (!(await term.race(sleep(backoff.delay()))).ok) return 0;
  }
}

interface LaunchTools {
  log: (event: string, c?: Pick<RemoteClaim, 'launchId' | 'taskId'>, detail?: string) => void;
  err: (text: string) => void;
  sleep: (ms: number) => Promise<void>;
  schedule?: Schedule;
  scriptedIdleMs?: number;
  term: Termination;
}

/**
 * One claimed launch, from the clone to the daemon's verdict. Never throws: a failure is logged and the loop claims
 * again. Answers the loop's exit code when the termination was requested during the launch, else nothing.
 */
async function workLaunch(s: WorkerSettings, call: ApiCall, claim: RemoteClaim, t: LaunchTools): Promise<number | undefined> {
  const { log } = t;
  log('claimed', claim);
  let clone: string | undefined;
  // Heartbeats run from the claim until the agent exits, whether or not the agent calls the API itself.
  const every = heartbeatEveryMs(claim);
  const heartbeat = every !== undefined ? startLoopHeartbeat({ call, claim, everyMs: every, clone: () => clone, schedule: t.schedule, err: t.err }) : undefined;
  // On termination a heartbeat in flight is awaited for at most TERMINATION_CALL_MS.
  const stopHeartbeat = async () => {
    if (!heartbeat) return;
    if (t.term.requested()) await withLimit(heartbeat.stop(), TERMINATION_CALL_MS);
    else await heartbeat.stop();
  };
  try {
    return await workClaimed(s, call, claim, t, (dir) => (clone = dir), stopHeartbeat);
  } finally {
    await stopHeartbeat();
  }
}

/**
 * The launch's work after the claim: clone, agent, relay, verdict. Stops the heartbeat once the agent has exited.
 * Answers the loop's exit code when the termination was requested, else nothing.
 */
async function workClaimed(s: WorkerSettings, call: ApiCall, claim: RemoteClaim, t: LaunchTools, setClone: (dir: string) => void, stopHeartbeat: () => Promise<void>): Promise<number | undefined> {
  const { log, term } = t;
  const ending = () => (term.requested() ? 0 : undefined);
  let accepted = false;
  let clone: string | undefined;
  try {
    if (!claim.repoUrl) throw new Error('the claim carries no repoUrl (set git.workerOriginUrl or git.originUrl on the daemon)');
    // The clone is not awaited past a termination request: the launch is released at once, and the container's end removes git.
    const prepared = await term.race(prepareClone({ cache: s.cache, repoUrl: claim.repoUrl, branch: claim.branch, start: startOf(claim) }));
    if (!prepared.ok) {
      await stopHeartbeat();
      return releaseUnstarted(call, s, claim, t);
    }
    clone = prepared.value;
    setClone(clone);
  } catch (e) {
    log('checkout-failed', claim, e instanceof Error ? e.message : String(e));
    await stopHeartbeat();
    await release(call, s, claim, `the worker could not prepare its clone: ${e instanceof Error ? e.message : String(e)}`, t);
    return ending();
  }
  log('checkout', claim, `${clone} on ${claim.branch} at ${startOf(claim)}`);
  try {
    await writeLaunchFiles(s, claim, clone);
    if (term.requested()) {
      await stopHeartbeat();
      return releaseUnstarted(call, s, claim, t);
    }
    log('agent-start', claim);
    if (s.agent === 'scripted') {
      const res = await runScriptedAgent({
        call,
        clone,
        workerId: s.workerId,
        sleep: t.sleep,
        ...(t.scriptedIdleMs ? { idleMs: t.scriptedIdleMs } : {}),
        launch: { launchId: claim.launchId, taskId: claim.taskId, token: claim.token, branch: claim.branch, acceptanceCriteria: criteriaOf(claim) },
      });
      accepted = isAccepted(res);
      if (res && !accepted) t.err(`worker ${s.workerId} submit ${claim.taskId}: ${res.status} ${JSON.stringify(res.body).slice(0, 300)}\n`);
    } else {
      const agent = runCommand(composeAgentCommand(s.command!, claim, clone), clone, agentEnv(s, claim, clone), t.err);
      const finished = await term.race(agent.closed);
      let code: number;
      if (finished.ok) code = finished.value;
      else {
        // Terminating: SIGTERM to the agent's group, SIGKILL after the limit. After a SIGKILL only the exit is awaited, not the
        // pipes, which a child in a group of its own may still hold.
        const stopped = await stopAgent(agent, s.agentStopMs ?? DEFAULT_AGENT_STOP_MS);
        code = stopped.killed ? stopped.code : await agent.closed;
      }
      t.err(`worker ${s.workerId} agent ${claim.taskId} exited with ${code}\n`);
    }
    log('agent-exit', claim);
  } catch (e) {
    log('agent-error', claim, e instanceof Error ? e.message : String(e));
  }
  await stopHeartbeat();
  const relayed = await relayFallback(s, call, claim, clone, t);
  accepted ||= relayed;
  let state: 'reported' | 'held' | 'ended' = 'ended';
  let read = false;
  try {
    const st = await call('GET', '/v1/status');
    if (st.status === 200) {
      state = launchState(st.body, s.workerId, claim);
      read = true;
    } else t.err(`worker ${s.workerId} status: ${st.status} ${JSON.stringify(st.body).slice(0, 200)}\n`);
  } catch (e) {
    t.err(`worker ${s.workerId} status: ${e instanceof Error ? e.message : String(e)}\n`);
  }
  if (accepted || state === 'reported') {
    log('report accepted', claim);
    return ending();
  }
  // Terminating, a status that could not be read counts as held: the work is pushed, and the release tried.
  if (term.requested() && (state === 'held' || !read)) return handBackLaunch(s, call, claim, clone, t);
  if (state === 'held') {
    await release(call, s, claim, 'the agent exited without a report', t);
    return ending();
  }
  log('ended', claim);
  return ending();
}

/** Hand a held launch back on termination (see src/worker/terminate.ts) and answer the loop's exit code. */
async function handBackLaunch(s: WorkerSettings, call: ApiCall, claim: RemoteClaim, clone: string, t: LaunchTools): Promise<number> {
  const o = await handBack({ clone, branch: claim.branch, launchId: claim.launchId, workerId: s.workerId, call });
  if (o.wipError) t.err(`worker ${s.workerId} wip-commit ${claim.taskId}: ${o.wipError}\n`);
  if (!o.pushed) {
    t.log('push-failed', claim, o.pushError);
    return 1;
  }
  const r = o.release!;
  if (r.status === 200) t.log('released', claim, `${POD_TERMINATING} keep -> ${r.status} ${String(r.body['outcome'] ?? '')} kept ${String(r.body['kept'] ?? '')}${r.body['keepError'] ? ` (${String(r.body['keepError'])})` : ''}`);
  else if (r.status === undefined) t.log('release-failed', claim, r.error);
  else t.log('release-failed', claim, `${r.status} ${String(r.body['error'] ?? r.body['reason'] ?? JSON.stringify(r.body).slice(0, 200))}`);
  return handBackExitCode(o);
}

/** Release a launch whose agent has not started, without keep, with reason `podTerminating`; 0 when answered 200. */
async function releaseUnstarted(call: ApiCall, s: WorkerSettings, claim: RemoteClaim, t: LaunchTools): Promise<number> {
  try {
    const r = await call('POST', `/v1/launches/${claim.launchId}/release`, { workerId: s.workerId, reason: POD_TERMINATING });
    if (r.status === 200) {
      t.log('released', claim, `${POD_TERMINATING} -> ${r.status} ${String(r.body['outcome'] ?? '')}`);
      return 0;
    }
    t.log('release-failed', claim, `${r.status} ${String(r.body['error'] ?? r.body['reason'] ?? JSON.stringify(r.body).slice(0, 200))}`);
  } catch (e) {
    t.log('release-failed', claim, e instanceof Error ? e.message : String(e));
  }
  return 1;
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

/**
 * Run the agent command in the clone through `/bin/sh -c`, in a process group of its own (so the loop can signal the
 * whole group), its output to `err`. The handle answers the exit code (signal: 128+) at the exit and once the pipes close.
 */
function runCommand(cmd: string, cwd: string, env: Record<string, string | undefined>, err: (text: string) => void): AgentHandle {
  const child = spawn('/bin/sh', ['-c', cmd], { cwd, env: env as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  child.stdout.on('data', (d: Buffer) => err(d.toString()));
  child.stderr.on('data', (d: Buffer) => err(d.toString()));
  const codeOf = (code: number | null, signal: NodeJS.Signals | null) => code ?? (signal ? 128 : 1);
  let failed: ((code: number) => void)[] = [];
  child.on('error', (e) => {
    err(`agent spawn failed: ${e.message}\n`);
    for (const f of failed) f(127);
    failed = [];
  });
  const exited = new Promise<number>((resolve) => {
    failed.push(resolve);
    child.on('exit', (code, signal) => resolve(codeOf(code, signal)));
  });
  const closed = new Promise<number>((resolve) => {
    failed.push(resolve);
    child.on('close', (code, signal) => resolve(codeOf(code, signal)));
  });
  return { pid: child.pid, exited, closed };
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
    if (t.term.requested()) {
      // After the termination request the push is bounded as the hand-back's is; it stays unforced.
      const pushed = await pushHead(clone, claim.branch, { timeoutMs: TERMINATION_PUSH_MS });
      if (!pushed.ok) t.err(`worker ${s.workerId} relay push ${claim.taskId}: ${pushed.error}\n`);
    } else {
      try {
        await gitOut(clone, ['push', '-q', 'origin', `HEAD:refs/heads/${claim.branch}`]);
      } catch (e) {
        t.err(`worker ${s.workerId} relay push ${claim.taskId}: ${e instanceof Error ? e.message : String(e)}\n`);
      }
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
  ORCH_WORKER_TASK           claim only this task id (default: any task)
  ORCH_WORKER_MAX_LAUNCHES   exit 0 after this many launches (default 0, never)
  ORCH_RETRY_WINDOW_MS       how long connection failures are retried (default ${DEFAULT_RETRY_WINDOW_MS})
  ORCH_WORKER_BACKOFF_MS     first poll delay with nothing claimable (default ${DEFAULT_BACKOFF_MS})
  ORCH_WORKER_BACKOFF_MAX_MS the longest poll delay (default ${DEFAULT_BACKOFF_MAX_MS})
  ORCH_WORKER_AGENT_STOP_MS  on SIGTERM or SIGINT, how long the agent has to exit before SIGKILL
                             (default ${DEFAULT_AGENT_STOP_MS}); the launch is then committed, pushed and
                             released with keep and reason podTerminating
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
    // SIGTERM (the kubelet's, on eviction, rollout or scale-down) and SIGINT start the termination; a second signal changes nothing.
    const termination = new AbortController();
    const onSignal = () => termination.abort();
    process.on('SIGTERM', onSignal);
    process.on('SIGINT', onSignal);
    runWorkerLoop(settings, { termination: termination.signal }).then(exit, (e) => {
      process.stderr.write(`orchestrator-worker: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
      exit(1);
    });
  }
}
