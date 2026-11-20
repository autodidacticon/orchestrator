/**
 * The daemon side of the verify-job claim protocol: a verifier outside the daemon claims an offered `checking` job
 * under a lease with a per-job bearer token, heartbeats, posts its result or hands the claim back. This module never
 * offers a job and never acts on a stored result: the remote backend does both. See specs/verifier-pool.
 *
 * `Orchestrator` is imported as a type only: src/loop/orchestrator.ts imports `renewVerifyLeases` from here.
 */
import { randomBytes } from 'node:crypto';
import { renewEveryMsOf } from '../brief/compose.js';
import { optionalFullSha } from '../agent/seal.js';
import type { ApiResponse, Orchestrator } from '../loop/orchestrator.js';
import { assertStorableId } from '../state/storable.js';
import type { VerifierJob } from '../state/store.js';
import { VERIFIER_ERROR } from '../verifier/loop.js';
import { NO_CLAIM } from './job.js';

export type VerifyResult = NonNullable<VerifierJob['result']>;
export type VerifyOutcome = VerifyResult['outcome'];

export const VERIFY_OUTCOMES: readonly VerifyOutcome[] = ['verified', 'checkFailed', 'checkTimeout', 'conflict', 'rebaseFailed', 'originFailed'];

/** The last characters of a check's output that a result keeps, as the in-process backend keeps them. */
export const VERIFY_OUTPUT_LIMIT = 65536;

/** The characters of a release's `reason` that are stored. See specs/verifier-pool "Verify release: limits". */
export const VERIFY_REASON_LIMIT = 4096;

/** The entries of a result's `conflictFiles` that are stored. See specs/verifier-pool "Verify result: limits". */
export const VERIFY_CONFLICT_FILES_LIMIT = 200;

/** The characters of each `conflictFiles` entry that are stored. See specs/verifier-pool "Verify result: body: limits". */
export const VERIFY_CONFLICT_FILE_LIMIT = 4096;

/** The longest `verifierId` a claim accepts: the longest pod name. See specs/verifier-pool "Verify claim: refusals". */
export const VERIFIER_ID_LIMIT = 253;

/** The lease expiries and `verifierError` releases after which a job ends `failed` with `verifierLost`. */
export const VERIFIER_LOSS_LIMIT = 3;


const UNAUTHORIZED: ApiResponse = { status: 401, body: { error: 'unauthorized' } };

// ---- waiters (memory only, per orchestrator) ----

interface Waiters {
  byJob: Map<string, Set<() => void>>;
}

const waiters = new WeakMap<Orchestrator, Waiters>();

function waitersOf(o: Orchestrator): Waiters {
  let w = waiters.get(o);
  if (!w) {
    w = { byJob: new Map() };
    waiters.set(o, w);
  }
  return w;
}

/**
 * Resolves at the job's next grant, repeated claim, result, release or lease expiry, at the end of every
 * `expireVerifyLeases` call, and on `wakeVerifyWaiters`. See specs/verifier-pool "Verify claim".
 */
export function verifyJobChanged(o: Orchestrator, jobId: string): Promise<void> {
  const w = waitersOf(o);
  return new Promise<void>((resolve) => {
    let set = w.byJob.get(jobId);
    if (!set) {
      set = new Set();
      w.byJob.set(jobId, set);
    }
    set.add(resolve);
  });
}

/** Resolve every pending `verifyJobChanged` promise of this orchestrator. */
export function wakeVerifyWaiters(o: Orchestrator): void {
  const w = waiters.get(o);
  if (!w) return;
  const all = [...w.byJob.values()];
  w.byJob.clear();
  for (const set of all) for (const resolve of set) resolve();
}

function notifyJob(o: Orchestrator, jobId: string): void {
  const w = waiters.get(o);
  const set = w?.byJob.get(jobId);
  if (!set) return;
  w!.byJob.delete(jobId);
  for (const resolve of set) resolve();
}

// ---- helpers ----

const unapplied = (o: Orchestrator): VerifierJob[] => o.store.listJobs({ status: 'checking', applied: false });

/** A job is claimable when it is unapplied and `checking`, has an offer, holds no verifier and no result, and its launch row exists. */
function claimable(o: Orchestrator, job: VerifierJob): boolean {
  return !job.applied && job.status === 'checking' && job.offer !== undefined && job.verifier === undefined && job.result === undefined && o.store.getLaunch(job.launchId) !== undefined;
}

/** The job a verifier holds: unapplied, `checking`, claimed by this id and without a result. An expired lease the tick has not ended still counts. */
function heldBy(o: Orchestrator, verifierId: string): VerifierJob | undefined {
  return unapplied(o).find((j) => j.verifier?.id === verifierId && j.result === undefined);
}

function oldestClaimable(o: Orchestrator): VerifierJob | undefined {
  return unapplied(o).find((j) => claimable(o, j));
}

function leaseOf(o: Orchestrator, job: VerifierJob): { ttlMs: number; expiresAt: number; renewEveryMs: number } {
  const ttlMs = o.config.leaseTtlMs;
  return { ttlMs, expiresAt: job.verifier!.expiresAt, renewEveryMs: renewEveryMsOf(ttlMs) };
}

function claimAnswer(o: Orchestrator, job: VerifierJob, repeated: boolean, repoUrl: string): ApiResponse {
  const launch = o.store.getLaunch(job.launchId);
  const report = o.store.getReport(job.launchId);
  const lease = leaseOf(o, job);
  return {
    status: 200,
    body: {
      ok: true,
      repeated,
      jobId: job.jobId,
      token: job.token,
      taskId: job.taskId,
      branch: launch?.branch,
      repoUrl,
      integrationBranch: o.config.integrationBranch,
      expectedHead: job.expectedHead,
      sealedSha: job.sealedSha,
      baseSha: job.baseSha,
      noChanges: Boolean(report?.body['noChanges']),
      checkCommand: job.offer?.checkCommand,
      checkTimeoutMs: o.config.checkTimeoutMs,
      leaseTtlMs: lease.ttlMs,
      leaseExpiresAt: lease.expiresAt,
      lease,
    },
  };
}

/** The job named in the path when `token` is its token and it is unapplied and `checking`; a job without a token never passes. */
function authenticateJob(o: Orchestrator, jobId: string, token: string): VerifierJob | undefined {
  const job = o.store.getJob(jobId);
  if (!job || job.applied || job.status !== 'checking') return undefined;
  if (typeof job.token !== 'string' || job.token === '' || job.token !== token) return undefined;
  return job;
}

// ---- routes ----

/**
 * `POST /v1/verify/claims`: hand the oldest claimable job to a verifier, or the job it already holds. Nothing is
 * written unless a job is granted or a held lease is renewed. See specs/verifier-pool "Verify claim".
 */
export async function claimVerifyJob(o: Orchestrator, body: Record<string, unknown>): Promise<ApiResponse> {
  const verifierId = String(body['verifierId'] ?? '').trim();
  if (!verifierId) return { status: 400, body: { error: 'verifierId is required' } };
  if (verifierId.length > VERIFIER_ID_LIMIT) return { status: 400, body: { error: `verifierId is longer than ${VERIFIER_ID_LIMIT} characters`, field: 'verifierId' } };
  // An id the store would rewrite would never match the verifier's next claim: refused before anything is written.
  assertStorableId('verifierId', verifierId);
  if (!heldBy(o, verifierId) && !oldestClaimable(o)) return { status: 404, body: { error: 'nothing to verify' } };
  const repoUrl = await o.workerRepoUrl();
  if (repoUrl === undefined) return { status: 409, body: { ok: false, reason: 'no repository URL: set git.workerOriginUrl or git.originUrl' } };
  // Look again: another claim may have taken the job while the URL resolved. Nothing is awaited from here to the grant.
  const held = heldBy(o, verifierId);
  const now = o.now();
  if (held) {
    const verifier = { ...held.verifier!, expiresAt: now + o.config.leaseTtlMs };
    o.store.updateJob(held.jobId, { verifier });
    notifyJob(o, held.jobId);
    return claimAnswer(o, { ...held, verifier }, true, repoUrl);
  }
  const job = oldestClaimable(o);
  if (!job) return { status: 404, body: { error: 'nothing to verify' } };
  const token = randomBytes(24).toString('hex');
  const verifier = { id: verifierId, claimedAt: now, expiresAt: now + o.config.leaseTtlMs };
  o.store.transaction(() => {
    o.store.updateJob(job.jobId, { token, verifier, updatedAt: now });
    o.store.appendEvent({ kind: 'verify.claimed', taskId: job.taskId, launchId: job.launchId, payload: { jobId: job.jobId, verifierId, expectedHead: job.expectedHead } }, now);
  });
  notifyJob(o, job.jobId);
  return claimAnswer(o, { ...job, token, verifier }, false, repoUrl);
}

/** `POST /v1/verify/:jobId/heartbeat`: renew the verify lease; no event. See specs/verifier-pool "Verify lease". */
export function verifyHeartbeat(o: Orchestrator, jobId: string, token: string): ApiResponse {
  const job = authenticateJob(o, jobId, token);
  if (!job || !job.verifier) return UNAUTHORIZED;
  const now = o.now();
  const verifier = { ...job.verifier, expiresAt: now + o.config.leaseTtlMs };
  o.store.updateJob(jobId, { verifier });
  return { status: 200, body: { ok: true, ...leaseOf(o, { ...job, verifier }) } };
}

type Parsed = { ok: true; result: Omit<VerifyResult, 'verifierId' | 'at'> } | { ok: false; error: string; field: string };

function parseResult(body: Record<string, unknown>): Parsed {
  const outcome = body['outcome'];
  if (typeof outcome !== 'string' || !(VERIFY_OUTCOMES as readonly string[]).includes(outcome)) {
    return { ok: false, error: `outcome must be one of ${VERIFY_OUTCOMES.join(', ')}`, field: 'outcome' };
  }
  const sha = optionalFullSha(body['rebasedSha'], 'rebasedSha');
  if (!sha.ok) return sha;
  if (outcome === 'verified' && sha.sha === undefined) return { ok: false, error: 'rebasedSha is required for a verified result', field: 'rebasedSha' };
  const output = body['output'];
  if (output !== undefined && typeof output !== 'string') return { ok: false, error: 'output must be a string', field: 'output' };
  const files = body['conflictFiles'];
  if (files !== undefined && (!Array.isArray(files) || files.some((f) => typeof f !== 'string'))) {
    return { ok: false, error: 'conflictFiles must be an array of strings', field: 'conflictFiles' };
  }
  return {
    ok: true,
    result: {
      outcome: outcome as VerifyOutcome,
      ...(sha.sha !== undefined ? { rebasedSha: sha.sha } : {}),
      output: (output ?? '').slice(-VERIFY_OUTPUT_LIMIT),
      conflictFiles: ((files as string[] | undefined) ?? []).slice(0, VERIFY_CONFLICT_FILES_LIMIT).map((file) => file.slice(0, VERIFY_CONFLICT_FILE_LIMIT)),
    },
  };
}

/**
 * `POST /v1/verify/:jobId/result`: store the verifier's result once, with a `verify.result` event that never carries the
 * output. The job stays `checking` and keeps its token and verifier. See specs/verifier-pool "Verify result".
 */
export function postVerifyResult(o: Orchestrator, jobId: string, token: string, body: Record<string, unknown>): ApiResponse {
  const job = authenticateJob(o, jobId, token);
  if (!job) return UNAUTHORIZED;
  if (job.result !== undefined) return { status: 200, body: { ok: true, duplicate: true } };
  const parsed = parseResult(body);
  if (!parsed.ok) return { status: 400, body: { error: parsed.error, field: parsed.field } };
  const now = o.now();
  const verifierId = job.verifier?.id ?? '';
  const result: VerifyResult = { ...parsed.result, verifierId, at: now };
  o.store.transaction(() => {
    o.store.updateJob(jobId, { result, updatedAt: now });
    o.store.appendEvent({ kind: 'verify.result', taskId: job.taskId, launchId: job.launchId, payload: { jobId, verifierId, outcome: result.outcome } }, now);
  });
  notifyJob(o, jobId);
  return { status: 200, body: { ok: true } };
}

/**
 * `POST /v1/verify/:jobId/release`: hand a claim back. The job keeps its offer and can be claimed again; a job that
 * holds a result cannot be released. See specs/verifier-pool "Verify release".
 */
export function releaseVerifyJob(o: Orchestrator, jobId: string, token: string, body: Record<string, unknown>): ApiResponse {
  const job = authenticateJob(o, jobId, token);
  if (!job) return UNAUTHORIZED;
  if (job.result !== undefined) return { status: 409, body: { ok: false, reason: 'a result is already recorded' } };
  const raw = body['reason'];
  if (raw !== undefined && typeof raw !== 'string') return { status: 400, body: { error: 'reason must be a string', field: 'reason' } };
  const reason = (raw ?? 'released by verifier').slice(0, VERIFY_REASON_LIMIT);
  const now = o.now();
  const verifierId = job.verifier?.id;
  // A release after an error of the verifier counts as a lost verifier; a pod that was stopping (podTerminating) does not.
  const lost = reason === VERIFIER_ERROR;
  o.store.transaction(() => {
    const losses = lost ? (job.leaseLosses ?? 0) + 1 : undefined;
    o.store.updateJob(jobId, { verifier: undefined, token: undefined, ...(losses !== undefined ? { leaseLosses: losses } : {}), updatedAt: now });
    o.store.appendEvent({ kind: 'verify.released', taskId: job.taskId, launchId: job.launchId, payload: { jobId, verifierId, reason, ...(losses !== undefined ? { leaseLosses: losses } : {}) } }, now);
    if (losses !== undefined) endIfLost(o, job, losses, now);
  });
  notifyJob(o, jobId);
  return { status: 200, body: { ok: true } };
}

/**
 * The cap on lease cycles: at `VERIFIER_LOSS_LIMIT` lost verifiers the job ends `failed` with `failureKind`
 * `verifierLost`, an output naming the count, and no claim fields; the tick then fails the task as for any failed
 * verification, spending an attempt. Called inside the transaction that counts the loss. See specs/verifier-pool
 * "Verify lease: cycle cap".
 */
function endIfLost(o: Orchestrator, job: VerifierJob, losses: number, now: number): void {
  if (losses < VERIFIER_LOSS_LIMIT) return;
  const output = `verify job ${job.jobId} lost its verifier ${losses} times (lease expiries and ${VERIFIER_ERROR} releases); not offered again`;
  o.store.updateJob(job.jobId, { status: 'failed', failureKind: 'verifierLost', output, ...NO_CLAIM, updatedAt: now });
  o.log.warn('verify job failed: it lost its verifier too often', { jobId: job.jobId, taskId: job.taskId, losses });
}

// ---- tick and gaps ----

/** Unapplied `checking` jobs whose verifier holds a lease and has posted no result. */
function leased(o: Orchestrator): VerifierJob[] {
  return unapplied(o).filter((j) => j.verifier !== undefined && j.result === undefined);
}

/**
 * End every verify lease that has run out: the verifier and token are removed and `verify.leaseExpired` is appended;
 * the job stays `checking` with its offer, claimable again. Before a lease is ended, the clock is noted and pending
 * gaps are written, as the expiry test of a claimed launch does, so a sleep since the tick read the clock renews the
 * leases first; with no lease that looks expired nothing is noted or written. Wakes every waiter at the end.
 * See specs/verifier-pool "Verify lease: expiry".
 */
export function expireVerifyLeases(o: Orchestrator): void {
  const due = (now: number) => leased(o).filter((j) => j.verifier!.expiresAt <= now);
  if (due(o.now()).length) {
    o.noteClock();
    o.recordGaps();
  }
  const now = o.now();
  for (const job of due(now)) {
    o.store.transaction(() => {
      const losses = (job.leaseLosses ?? 0) + 1;
      o.store.updateJob(job.jobId, { verifier: undefined, token: undefined, leaseLosses: losses, updatedAt: now });
      o.store.appendEvent({ kind: 'verify.leaseExpired', taskId: job.taskId, launchId: job.launchId, payload: { jobId: job.jobId, verifierId: job.verifier!.id, leaseLosses: losses } }, now);
      endIfLost(o, job, losses, now);
    });
  }
  wakeVerifyWaiters(o);
}

/**
 * Renew every verify lease after a gap in the daemon's clock; called inside the `recordGaps` transaction. Appends no
 * event. See specs/verifier-pool "Verify lease: renewal after a gap".
 */
export function renewVerifyLeases(o: Orchestrator): void {
  const now = o.now();
  for (const job of leased(o)) o.store.updateJob(job.jobId, { verifier: { ...job.verifier!, expiresAt: now + o.config.leaseTtlMs } });
}
