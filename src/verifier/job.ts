/**
 * One verify job of the verifier loop (`orchestrator-verifier`): the steps from a granted claim to the result body the
 * loop posts. Clone (cached per `repoUrl`), fetch, a detached worktree at the expected head, the daemon's own rebase
 * (`rebaseSealed`), the check through the daemon's own `runCheck`, and the push of the rebased commit to
 * `refs/verify/<jobId>`. It posts nothing, so it can run against a real repository with no API.
 * See specs/verifier-pool "Verifier job steps".
 */
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { rebaseSealed, runCheck } from '../verify/verifier.js';
import { ensureClone } from '../worker/clone.js';
import { git, worktreeAddDetached, worktreeRemove } from '../workspace/git.js';

/** The limit of the fetch and of each push try: the default of the daemon's `git.remoteTimeoutMs`. No variable sets it. */
export const VERIFIER_GIT_TIMEOUT_MS = 120_000;
/** The characters of a check's or a rebase's output that a result keeps, as the daemon keeps them. */
export const VERIFIER_MAX_OUT = 65_536;
/** How many times the rebased commit is pushed before the job ends `originFailed`, and the pause between tries. */
export const VERIFIER_PUSH_TRIES = 3;
export const VERIFIER_PUSH_PAUSE_MS = 2000;
/** The directory under the cache that holds one worktree per job. */
export const VERIFY_DIR = 'verify';

/** A job id the loop puts into a ref name and a path: letters, digits and `-` only. */
export const JOB_ID = /^[A-Za-z0-9-]+$/;

export type VerifyOutcome = 'verified' | 'checkFailed' | 'checkTimeout' | 'conflict' | 'rebaseFailed' | 'originFailed';

/** The body of `POST /v1/verify/<jobId>/result`. */
export interface VerifyResultBody {
  outcome: VerifyOutcome;
  rebasedSha?: string;
  output?: string;
  conflictFiles?: string[];
}

/** The fields of a claim answer the loop uses. See specs/verifier-pool "Verify claim: answer". */
export interface VerifyClaim {
  jobId: string;
  token: string;
  taskId?: string;
  repoUrl: string;
  expectedHead: string;
  sealedSha: string;
  baseSha: string;
  noChanges: boolean;
  checkCommand: string;
  checkTimeoutMs: number;
  leaseTtlMs?: number;
  repeated?: boolean;
  lease?: { ttlMs?: number; renewEveryMs?: number };
}

/** The ids of a claim answer, when it has them; an answer without `jobId` or `token` cannot be released. */
export function claimIds(body: Record<string, unknown>): { jobId?: string; token?: string; taskId?: string } {
  const str = (k: string) => (typeof body[k] === 'string' && body[k] !== '' ? (body[k] as string) : undefined);
  return { jobId: str('jobId'), token: str('token'), taskId: str('taskId') };
}

/**
 * The claim of a 200 answer; throws naming the first field that is missing or malformed. A `jobId` that holds anything
 * but letters, digits and `-` is refused, so it never goes into a ref name or a path.
 */
export function parseClaim(body: Record<string, unknown>): VerifyClaim {
  const req = (k: string): string => {
    const v = body[k];
    if (typeof v !== 'string' || v === '') throw new Error(`the claim answer has no ${k}`);
    return v;
  };
  const jobId = req('jobId');
  if (!JOB_ID.test(jobId)) throw new Error(`the claim answer's jobId ${JSON.stringify(jobId.slice(0, 80))} holds characters other than letters, digits and -`);
  const token = req('token');
  const repoUrl = req('repoUrl');
  const expectedHead = req('expectedHead');
  const sealedSha = req('sealedSha');
  const checkCommand = req('checkCommand');
  const baseSha = typeof body['baseSha'] === 'string' ? body['baseSha'] : '';
  const num = (k: string) => (typeof body[k] === 'number' && Number.isFinite(body[k]) && (body[k] as number) > 0 ? (body[k] as number) : undefined);
  const lease = body['lease'] && typeof body['lease'] === 'object' ? (body['lease'] as VerifyClaim['lease']) : undefined;
  return {
    jobId,
    token,
    ...(typeof body['taskId'] === 'string' ? { taskId: body['taskId'] } : {}),
    repoUrl,
    expectedHead,
    sealedSha,
    baseSha,
    noChanges: body['noChanges'] === true,
    checkCommand,
    checkTimeoutMs: num('checkTimeoutMs') ?? 900_000,
    ...(num('leaseTtlMs') !== undefined ? { leaseTtlMs: num('leaseTtlMs') } : {}),
    ...(body['repeated'] === true ? { repeated: true } : {}),
    ...(lease ? { lease } : {}),
  };
}

export interface WorkOptions {
  /** The cache: clones, `verify/<jobId>` worktrees, and the check's `child-home`. */
  cache: string;
  /** Aborted on a lost lease or on termination: the check is killed, a git step in flight is awaited, no further step starts. */
  signal?: AbortSignal;
  /** One stdout event of the job (`check`). */
  log?: (event: string, detail?: string) => void;
  /** Details (stderr): the check's command, exit and output. */
  err?: (text: string) => void;
  /** The pause between push tries. */
  sleep?: (ms: number) => Promise<void>;
  /** The limit of the fetch and of each push try; `VERIFIER_GIT_TIMEOUT_MS` when unset. */
  gitTimeoutMs?: number;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** git's output of a failed command, stderr first. */
const outputOf = (r: { stdout: string; stderr: string }): string => [r.stderr.trim(), r.stdout.trim()].filter(Boolean).join('\n');

/**
 * Work one granted job: answers the result body to post, or `undefined` when `o.signal` was aborted. Throws on an
 * error of its own (a full disk, a missing git). The worktree is removed in a `finally`, whatever happened.
 */
export async function workVerifyJob(claim: VerifyClaim, o: WorkOptions): Promise<VerifyResultBody | undefined> {
  if (!JOB_ID.test(claim.jobId)) throw new Error(`jobId ${JSON.stringify(claim.jobId.slice(0, 80))} holds characters other than letters, digits and -`);
  const aborted = () => o.signal?.aborted === true;
  const sleep = o.sleep ?? realSleep;
  const timeoutMs = o.gitTimeoutMs ?? VERIFIER_GIT_TIMEOUT_MS;
  // Remote commands run under LC_ALL=C: the daemon classifies an originFailed output by git's English messages.
  const remote = { allowFail: true, env: { LC_ALL: 'C' }, timeoutMs };
  if (aborted()) return undefined;

  // 1. The clone, unchanged from the worker loop's: no limit, not under LC_ALL=C.
  let clone: string;
  try {
    clone = await ensureClone(o.cache, claim.repoUrl);
  } catch (e) {
    return { outcome: 'originFailed', output: e instanceof Error ? e.message : String(e) };
  }
  if (aborted()) return undefined;

  // 2. The fetch, bounded.
  const fetched = await git(clone, ['fetch', '-q', '--prune', 'origin'], remote);
  if (fetched.code !== 0) return { outcome: 'originFailed', output: outputOf(fetched) || `git fetch origin exited ${fetched.code}` };
  if (aborted()) return undefined;
  const has = async (sha: string) => (await git(clone, ['cat-file', '-e', `${sha}^{commit}`], { allowFail: true })).code === 0;
  if (!(await has(claim.expectedHead))) return { outcome: 'originFailed', output: `origin has no commit ${claim.expectedHead} (the expected head) after git fetch origin` };
  if (!(await has(claim.sealedSha))) return { outcome: 'rebaseFailed', output: `origin has no commit ${claim.sealedSha} (the sealed commit) after git fetch origin` };
  if (aborted()) return undefined;

  // 3. A detached worktree at the expected head; a leftover of the same id is removed first.
  const root = path.join(o.cache, VERIFY_DIR);
  const dir = path.join(root, claim.jobId);
  await mkdir(root, { recursive: true });
  await worktreeRemove(clone, dir);
  await rm(dir, { recursive: true, force: true });
  await worktreeAddDetached(clone, dir, claim.expectedHead);
  try {
    // 4. The daemon's rebase, from the merge base.
    const rebased = await rebaseSealed(dir, claim.expectedHead, claim.sealedSha, claim.baseSha, VERIFIER_MAX_OUT);
    if (rebased.kind === 'conflict') return { outcome: 'conflict', conflictFiles: rebased.files };
    if (rebased.kind === 'failed') return { outcome: 'rebaseFailed', output: rebased.output };
    const { rebasedSha } = rebased;
    if (aborted()) return undefined;

    // 5. Nothing to check: the head already holds the work, or a declared no-op leaves the head's tree as it was.
    if (rebasedSha === claim.expectedHead) return { outcome: 'verified', rebasedSha };
    let check = true;
    if (claim.noChanges) {
      const tree = async (sha: string) => (await git(dir, ['rev-parse', `${sha}^{tree}`])).stdout.trim();
      if ((await tree(rebasedSha)) === (await tree(claim.expectedHead))) check = false;
    }

    // 6. The check, through the daemon's runCheck, unchanged: the cache is its data directory.
    if (check) {
      if (aborted()) return undefined;
      o.log?.('check');
      const r = await runCheck(claim.checkCommand, dir, claim.checkTimeoutMs, VERIFIER_MAX_OUT, o.cache, { ...(o.signal ? { signal: o.signal } : {}) });
      o.err?.(`check ${claim.jobId}: ${claim.checkCommand}\ncheck ${claim.jobId} exit: ${r.timedOut ? 'timeout' : r.aborted ? 'aborted' : String(r.code)}\n${r.output}${r.output && !r.output.endsWith('\n') ? '\n' : ''}`);
      if (r.aborted || aborted()) return undefined;
      if (r.timedOut) return { outcome: 'checkTimeout', output: r.output };
      if (r.code !== 0) return { outcome: 'checkFailed', output: r.output };
    }

    // 7. The push to refs/verify/<jobId>, up to three tries, two seconds apart.
    let last = '';
    for (let i = 1; i <= VERIFIER_PUSH_TRIES; i++) {
      if (aborted()) return undefined;
      const pushed = await git(clone, ['push', '--force', 'origin', `${rebasedSha}:refs/verify/${claim.jobId}`], remote);
      if (pushed.code === 0) return { outcome: 'verified', rebasedSha };
      last = outputOf(pushed) || `git push exited ${pushed.code}`;
      o.err?.(`push ${claim.jobId} try ${i}: ${last}\n`);
      if (i < VERIFIER_PUSH_TRIES) await sleep(VERIFIER_PUSH_PAUSE_MS);
    }
    if (aborted()) return undefined;
    return { outcome: 'originFailed', output: last };
  } finally {
    await worktreeRemove(clone, dir);
    await rm(dir, { recursive: true, force: true });
  }
}
