#!/usr/bin/env node
/**
 * orchestrator-verifier: the verifier loop. Against a daemon with `verifier.mode: remote` it claims one verify job at a
 * time over the daemon's API (`POST /v1/verify/claims`), works it in a cached clone (src/verifier/job.ts), heartbeats
 * the job's lease while it works, posts one of six outcomes, and claims again. With nothing to claim it waits with
 * backoff. It exits 0 after the idle limit, after the job limit, or on SIGTERM or SIGINT, when it kills the check and
 * hands the job back. It opens no store. See specs/verifier-pool.
 */
import { readdir, rm } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import { isEntrypoint } from '../entry.js';
import { type ApiCall, apiClient, type ApiResult, realSleep, TERMINATION_CALL_MS } from '../worker/http.js';
import { Backoff, heartbeatEveryMs, type Schedule } from '../worker/loop.js';
import { POD_TERMINATING } from '../worker/terminate.js';
import { startVerifyHeartbeat } from './heartbeat.js';
import { claimIds, JOB_ID, parseClaim, VERIFY_DIR, type VerifyClaim, type VerifyResultBody, type WorkOptions, workVerifyJob } from './job.js';

export const DEFAULT_VERIFIER_CACHE = '/var/cache/orchestrator';
export const DEFAULT_RETRY_WINDOW_MS = 60_000;
export const DEFAULT_BACKOFF_MS = 1000;
export const DEFAULT_BACKOFF_MAX_MS = 30_000;
/** The release reason of a job the loop could not finish through an error of its own. */
export const VERIFIER_ERROR = 'verifierError';
/** The pause between posts of a result answered 5xx. */
export const RESULT_RETRY_MS = 1000;

export interface VerifierSettings {
  /** The daemon's API (`ORCH_API`). */
  api: string;
  /** `POD_NAME`, else `ORCH_VERIFIER_ID`, else the host name. */
  verifierId: string;
  /** Clones, job worktrees and the check's `child-home` (`ORCH_VERIFIER_CACHE`). */
  cache: string;
  /** Exit 0 after this long with no job granted; 0 never (`ORCH_VERIFIER_IDLE_EXIT_MS`). */
  idleExitMs: number;
  /** Exit 0 after this many granted jobs have ended; 0 no limit (`ORCH_VERIFIER_MAX_JOBS`). */
  maxJobs: number;
  /** The first delay between claims (`ORCH_VERIFIER_BACKOFF_MS`), doubled up to `backoffMaxMs` (`ORCH_VERIFIER_BACKOFF_MAX_MS`). */
  backoffMs: number;
  backoffMaxMs: number;
  /** How long connection failures are retried (`ORCH_RETRY_WINDOW_MS`). */
  retryWindowMs: number;
}

function nonNegative(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${key} must be a non-negative integer; got ${JSON.stringify(raw)}`);
  return n;
}

/** The loop's settings from its environment; throws naming the variable that is missing or malformed. */
export function verifierSettings(env: NodeJS.ProcessEnv, host: () => string = hostname): VerifierSettings {
  const api = (env['ORCH_API'] ?? '').trim();
  if (!api) throw new Error('ORCH_API is required: the URL of the orchestrator daemon');
  const backoffMs = Math.max(1, nonNegative(env, 'ORCH_VERIFIER_BACKOFF_MS', DEFAULT_BACKOFF_MS));
  return {
    api: api.replace(/\/+$/, ''),
    verifierId: env['POD_NAME']?.trim() || env['ORCH_VERIFIER_ID']?.trim() || host(),
    cache: env['ORCH_VERIFIER_CACHE']?.trim() || DEFAULT_VERIFIER_CACHE,
    idleExitMs: nonNegative(env, 'ORCH_VERIFIER_IDLE_EXIT_MS', 0),
    maxJobs: nonNegative(env, 'ORCH_VERIFIER_MAX_JOBS', 0),
    backoffMs,
    backoffMaxMs: Math.max(backoffMs, nonNegative(env, 'ORCH_VERIFIER_BACKOFF_MAX_MS', DEFAULT_BACKOFF_MAX_MS)),
    retryWindowMs: nonNegative(env, 'ORCH_RETRY_WINDOW_MS', DEFAULT_RETRY_WINDOW_MS),
  };
}

export type VerifierWork = (claim: VerifyClaim, o: WorkOptions) => Promise<VerifyResultBody | undefined>;

export interface VerifierDeps {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** One line to stdout per step. */
  out?: (line: string) => void;
  /** Details, and the check's command, exit and output (stderr). */
  err?: (text: string) => void;
  /** The heartbeat timer (default `setTimeout`). */
  schedule?: Schedule;
  /** The termination request; the entry point aborts it on SIGTERM and SIGINT. */
  termination?: AbortSignal;
  /** One job's work (default `workVerifyJob`). */
  work?: VerifierWork;
}

type Ids = { jobId?: string; taskId?: string };
type JobEnd = 'stored' | 'other' | 'terminated';
type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** `p`, or `undefined` once `ms` have passed on a real timer, which is cleared. */
async function withinMs<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let t: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<undefined>((r) => (t = setTimeout(() => r(undefined), ms)))]);
  } finally {
    clearTimeout(t);
  }
}

/** Remove every directory under `<cache>/verify/`: worktrees a killed container left behind. */
async function sweep(cache: string, err: (text: string) => void): Promise<void> {
  const root = path.join(cache, VERIFY_DIR);
  let names: string[];
  try {
    names = await readdir(root);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') err(`sweep ${root}: ${message(e)}\n`);
    return;
  }
  for (const name of names) {
    await rm(path.join(root, name), { recursive: true, force: true }).catch((e: unknown) => err(`sweep ${path.join(root, name)}: ${message(e)}\n`));
  }
}

/** Run the loop until the idle limit, the job limit or the termination (0), or a claim refused with 400 (1). */
export async function runVerifierLoop(s: VerifierSettings, deps: VerifierDeps = {}): Promise<number> {
  const sleep = deps.sleep ?? realSleep;
  const now = deps.now ?? Date.now;
  const out = deps.out ?? ((line: string) => void process.stdout.write(`${line}\n`));
  const err = deps.err ?? ((text: string) => void process.stderr.write(text));
  const work = deps.work ?? workVerifyJob;
  const term = deps.termination;
  const requested = () => term?.aborted === true;
  // The one place the API client is built. In M5 the claim sends no credential and the job routes only the job token.
  // The termination request aborts every call in flight and leaves it, and every later call, at most TERMINATION_CALL_MS.
  const call: ApiCall = apiClient({ api: s.api, retryWindowMs: s.retryWindowMs, fetch: deps.fetch, sleep, now, termination: term });
  const log = (event: string, c?: Ids, detail?: string) => {
    out(`verifier ${s.verifierId} ${event} ${c?.jobId || '-'} ${c?.taskId || '-'}`);
    if (detail) err(`verifier ${s.verifierId} ${event}: ${detail}\n`);
  };
  /** `p`'s settled value, or `{ ok: false }` once the termination is requested. */
  const raceTerm = <T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> =>
    new Promise((resolve, reject) => {
      const onAbort = () => resolve({ ok: false });
      if (term?.aborted) onAbort();
      else term?.addEventListener('abort', onAbort, { once: true });
      p.then(
        (value) => {
          term?.removeEventListener('abort', onAbort);
          resolve({ ok: true, value });
        },
        (e: unknown) => {
          term?.removeEventListener('abort', onAbort);
          reject(e);
        },
      );
    });

  const backoff = new Backoff(s.backoffMs, s.backoffMaxMs);
  let idleSince = now();
  let refusedOnce = false;
  let jobs = 0;
  let current: Ids | undefined;
  let saidTerminating = false;
  const onTerminate = () => {
    if (saidTerminating) return;
    saidTerminating = true;
    log('terminating', current);
  };

  const release = async (c: Ids & { jobId: string; token: string }, reason: string): Promise<void> => {
    try {
      const r = await call('POST', `/v1/verify/${c.jobId}/release`, { reason }, c.token);
      if (r.status === 200) log('released', c, reason);
      else err(`verifier ${s.verifierId} release ${c.jobId}: ${r.status} ${JSON.stringify(r.body).slice(0, 300)}\n`);
    } catch (e) {
      err(`verifier ${s.verifierId} release ${c.jobId}: ${message(e)}\n`);
    }
  };

  /** Post the result: 'stored' on a 200, 'lost' on a 401, else 'refused'. A 5xx is posted again once a second within the retry window. */
  const postResult = async (claim: VerifyClaim, body: VerifyResultBody): Promise<'stored' | 'lost' | 'refused'> => {
    const deadline = now() + s.retryWindowMs;
    for (;;) {
      let r: ApiResult;
      try {
        r = await call('POST', `/v1/verify/${claim.jobId}/result`, { ...body }, claim.token);
      } catch (e) {
        log('result-refused', claim, `no answer: ${message(e)}`);
        return 'refused';
      }
      if (r.status === 200) {
        log(body.outcome, claim, r.body['duplicate'] === true ? 'duplicate' : undefined);
        return 'stored';
      }
      if (r.status === 401) {
        log('lease-lost', claim, 'the result post was answered 401');
        return 'lost';
      }
      const detail = `${r.status} ${JSON.stringify(r.body).slice(0, 300)}`;
      // After the termination request no post starts: the one in flight is the last, even when the signal lands in the pause.
      if (r.status >= 500 && !requested() && now() + RESULT_RETRY_MS <= deadline) {
        err(`verifier ${s.verifierId} result ${claim.jobId}: ${detail}; posting again\n`);
        await sleep(RESULT_RETRY_MS);
        if (!requested()) continue;
      }
      log('result-refused', claim, detail);
      return 'refused';
    }
  };

  /** One granted job, from the claim to its result or its release. */
  const workJob = async (claim: VerifyClaim): Promise<JobEnd> => {
    current = claim;
    log('claimed', claim, claim.repeated ? 'repeated' : undefined);
    const ctl = new AbortController();
    const abortJob = () => ctl.abort();
    term?.addEventListener('abort', abortJob, { once: true });
    if (requested()) ctl.abort();
    let lost = false;
    const ttl = claim.lease?.ttlMs ?? claim.leaseTtlMs;
    const every = heartbeatEveryMs({ lease: { ...(claim.lease?.renewEveryMs !== undefined ? { renewEveryMs: claim.lease.renewEveryMs } : {}), ...(ttl !== undefined ? { ttlMs: ttl } : {}) } });
    const hb =
      every !== undefined
        ? startVerifyHeartbeat({
            call,
            jobId: claim.jobId,
            token: claim.token,
            everyMs: every,
            ...(deps.schedule ? { schedule: deps.schedule } : {}),
            err,
            onLost: () => {
              lost = true;
              ctl.abort();
            },
          })
        : undefined;
    const stopHeartbeat = async () => {
      if (!hb) return;
      if (requested()) await withinMs(hb.stop(), TERMINATION_CALL_MS);
      else await hb.stop();
    };
    try {
      let workP: Promise<Settled<VerifyResultBody | undefined>>;
      try {
        workP = Promise.resolve(work(claim, { cache: s.cache, signal: ctl.signal, log: (event, detail) => log(event, claim, detail), err, sleep })).then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
      } catch (error) {
        workP = Promise.resolve({ ok: false as const, error });
      }
      const first = await raceTerm(workP);
      // Terminating: the job's signal is aborted, which kills the check; the job has TERMINATION_CALL_MS to return.
      const settled = first.ok ? first.value : await withinMs(workP, TERMINATION_CALL_MS);
      if (requested()) {
        await stopHeartbeat();
        await release(claim, POD_TERMINATING);
        return 'terminated';
      }
      if (lost) {
        await stopHeartbeat();
        log('lease-lost', claim, 'a heartbeat was answered 401');
        return 'other';
      }
      if (!settled || !settled.ok || settled.value === undefined) {
        const why = !settled ? 'the job did not return' : !settled.ok ? message(settled.error) : 'the job ended with no result';
        err(`verifier ${s.verifierId} job ${claim.jobId}: ${why}\n`);
        await stopHeartbeat();
        await release(claim, VERIFIER_ERROR);
        return 'other';
      }
      const posted = await postResult(claim, settled.value);
      await stopHeartbeat();
      if (posted === 'stored') return requested() ? 'terminated' : 'stored';
      if (posted === 'lost') return requested() ? 'terminated' : 'other';
      // A post refused after the signal (a 400, a 5xx, no answer) hands the job back, so it does not wait for its lease.
      if (requested()) {
        await release(claim, POD_TERMINATING);
        return 'terminated';
      }
      await release(claim, VERIFIER_ERROR);
      return 'other';
    } finally {
      term?.removeEventListener('abort', abortJob);
      await stopHeartbeat();
      current = undefined;
    }
  };

  /** The wait between claims: the idle exit, else the next delay; answers an exit code, or nothing to claim again. */
  const wait = async (): Promise<number | undefined> => {
    if (s.idleExitMs > 0 && now() - idleSince >= s.idleExitMs) {
      log('idle-exit');
      return 0;
    }
    if (!(await raceTerm(sleep(backoff.delay()))).ok) return 0;
    return undefined;
  };

  log('start');
  if (term) {
    if (term.aborted) onTerminate();
    else term.addEventListener('abort', onTerminate, { once: true });
  }
  await sweep(s.cache, err);
  for (;;) {
    if (requested()) return 0;
    // A claim in flight is aborted and sent again within TERMINATION_CALL_MS: a job it grants is released at once.
    let c: ApiResult | undefined;
    try {
      c = await call('POST', '/v1/verify/claims', { verifierId: s.verifierId });
    } catch (e) {
      if (requested()) return 0;
      err(`verifier ${s.verifierId} claim: no answer: ${message(e)}\n`);
    }
    if (c?.status === 200) {
      const ids = claimIds(c.body);
      const releasable = ids.jobId !== undefined && ids.token !== undefined && JOB_ID.test(ids.jobId) ? { ...ids, jobId: ids.jobId, token: ids.token } : undefined;
      const shown: Ids = { jobId: releasable?.jobId, taskId: ids.taskId };
      if (requested()) {
        log('claimed', shown);
        if (releasable) await release(releasable, POD_TERMINATING);
        return 0;
      }
      refusedOnce = false;
      let end: JobEnd;
      let claim: VerifyClaim | undefined;
      try {
        claim = parseClaim(c.body);
      } catch (e) {
        log('claimed', shown);
        err(`verifier ${s.verifierId} claim: ${message(e)}: ${JSON.stringify({ ...c.body, token: undefined }).slice(0, 300)}\n`);
      }
      if (claim) end = await workJob(claim);
      else {
        if (releasable) await release(releasable, VERIFIER_ERROR);
        end = requested() ? 'terminated' : 'other';
      }
      jobs++;
      idleSince = now();
      if (end === 'terminated' || requested()) return 0;
      if (s.maxJobs > 0 && jobs >= s.maxJobs) {
        log('max-jobs');
        return 0;
      }
      // A stored result claims again at once; any other end waits its next delay, so a failing job cannot make the loop spin.
      if (end === 'stored') {
        backoff.reset();
        continue;
      }
      const code = await wait();
      if (code !== undefined) return code;
      continue;
    }
    if (requested()) return 0;
    if (c?.status === 400) {
      log('claim-refused', undefined, `${c.status} ${JSON.stringify(c.body).slice(0, 300)}`);
      return 1;
    }
    // 404: nothing to verify. Any other answer (409 with no repository URL, a 5xx) is printed once until the next grant.
    if (c && c.status !== 404 && !refusedOnce) {
      refusedOnce = true;
      log('claim-refused', undefined, `${c.status} ${JSON.stringify(c.body).slice(0, 300)}`);
    }
    const code = await wait();
    if (code !== undefined) return code;
  }
}

export const USAGE = `orchestrator-verifier: the verifier loop.

Claims verify jobs from an orchestrator daemon that runs with verifier.mode: remote,
one at a time. For each job it rebases the sealed commit onto the expected head in a
cached clone, runs the check command, pushes the rebased commit to refs/verify/<jobId>
on origin and posts the result; on SIGTERM or SIGINT it kills the check and releases
the job. Environment:
  ORCH_API                      the daemon's URL (required)
  POD_NAME                      the verifier id; else ORCH_VERIFIER_ID; else the host name
  ORCH_VERIFIER_ID              the verifier id when POD_NAME is unset or empty
  ORCH_VERIFIER_CACHE           clones and job worktrees (default ${DEFAULT_VERIFIER_CACHE})
  ORCH_VERIFIER_IDLE_EXIT_MS    exit 0 after this long with no job granted (default 0, never)
  ORCH_VERIFIER_MAX_JOBS        exit 0 after this many jobs have ended (default 0, no limit)
  ORCH_VERIFIER_BACKOFF_MS      first delay between claims with nothing to verify (default ${DEFAULT_BACKOFF_MS})
  ORCH_VERIFIER_BACKOFF_MAX_MS  the longest delay between claims (default ${DEFAULT_BACKOFF_MAX_MS})
  ORCH_RETRY_WINDOW_MS          how long connection failures are retried (default ${DEFAULT_RETRY_WINDOW_MS})
`;

if (isEntrypoint(import.meta.url)) {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write(USAGE);
  } else {
    let settings: VerifierSettings;
    try {
      settings = verifierSettings(process.env);
    } catch (e) {
      process.stderr.write(`orchestrator-verifier: ${message(e)}\n`);
      process.exit(2);
    }
    // Exit once stdout has drained: the last lines are what a reader counts.
    const exit = (code: number) => process.stdout.write('', () => process.exit(code));
    // SIGTERM (the kubelet's) and SIGINT start the termination; a second signal changes nothing.
    const termination = new AbortController();
    const onSignal = () => termination.abort();
    process.on('SIGTERM', onSignal);
    process.on('SIGINT', onSignal);
    runVerifierLoop(settings, { termination: termination.signal }).then(exit, (e) => {
      process.stderr.write(`orchestrator-verifier: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
      exit(1);
    });
  }
}
