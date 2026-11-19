/**
 * Graceful pod termination for the remote worker loop: stopping the agent's process group within a time limit, the
 * work-in-progress commit, the bounded push of the launch branch, and the hand-back that releases the launch with
 * keep and reason `podTerminating`. Free of the loop's state, so each step can be tested alone; the hand-back answers
 * its outcome as data and the loop derives its exit code from it. See specs/worker-pool "Pod termination".
 */
import { git } from '../workspace/git.js';
import type { ApiCall, ApiResult } from './http.js';
import { SCRIPTED_IDENTITY } from './scripted.js';

/** The release reason of a launch handed back on termination. */
export const POD_TERMINATING = 'podTerminating';
/** How long the agent's process group has after SIGTERM before SIGKILL (`ORCH_WORKER_AGENT_STOP_MS`). */
export const DEFAULT_AGENT_STOP_MS = 10_000;
/** The limit of a push made after the signal. */
export const TERMINATION_PUSH_MS = 30_000;
/** The longest connection-failure retry of an API call made after the signal, and the longest wait for a heartbeat in flight. */
export const TERMINATION_CALL_MS = 5_000;

/** A running agent command: its process group leader, and when it exited (`exited`) and its pipes closed (`closed`). */
export interface AgentHandle {
  pid: number | undefined;
  /** The exit code (signal: 128+) once the process has exited, whether or not its pipes are still open. */
  exited: Promise<number>;
  /** The exit code once the process has exited and its output pipes have closed. */
  closed: Promise<number>;
}

export type Kill = (pid: number, signal: NodeJS.Signals) => void;

const killGroup: Kill = (pid, signal) => {
  try {
    process.kill(-pid, signal);
  } catch {
    // The group is gone already.
  }
};

/** A timer that resolves `'timeout'` after `ms` and can be cleared. */
function timer(ms: number): { done: Promise<'timeout'>; clear: () => void } {
  let t: NodeJS.Timeout | undefined;
  const done = new Promise<'timeout'>((r) => (t = setTimeout(() => r('timeout'), ms)));
  return { done, clear: () => clearTimeout(t) };
}

/** `p`, or `undefined` once `ms` has passed. */
export async function withLimit<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  const t = timer(ms);
  try {
    const r = await Promise.race([p, t.done]);
    return r === 'timeout' ? undefined : (r as T);
  } finally {
    t.clear();
  }
}

/**
 * Stop the agent: SIGTERM to its process group, up to `stopMs` for it to exit and close its pipes, then SIGKILL to the
 * group (at once when `stopMs` is 0). Watching the pipes, not only the leader's exit, catches a group member that
 * outlives a shell killed by the SIGTERM. After the SIGKILL only the exit is awaited, not the pipes: a child that left
 * the group may still hold them. Answers the exit code and whether SIGKILL was sent.
 */
export async function stopAgent(handle: AgentHandle, stopMs: number, kill: Kill = killGroup): Promise<{ code: number; killed: boolean }> {
  const pid = handle.pid;
  if (pid === undefined) return { code: await handle.exited, killed: false };
  let killed = false;
  if (stopMs > 0) {
    kill(pid, 'SIGTERM');
    const code = await withLimit(handle.closed, stopMs);
    if (code !== undefined) return { code, killed };
  }
  kill(pid, 'SIGKILL');
  killed = true;
  return { code: await handle.exited, killed };
}

/** The identity of the work-in-progress commit. */
export const WIP_IDENTITY = { GIT_AUTHOR_NAME: SCRIPTED_IDENTITY.GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL: SCRIPTED_IDENTITY.GIT_AUTHOR_EMAIL, GIT_COMMITTER_NAME: SCRIPTED_IDENTITY.GIT_COMMITTER_NAME, GIT_COMMITTER_EMAIL: SCRIPTED_IDENTITY.GIT_COMMITTER_EMAIL };

/**
 * Commit every uncommitted or untracked file outside `.orchestrator/` as one work-in-progress commit (`git add -A`,
 * hooks skipped). Answers the commit's sha, nothing when the tree was clean, or the error when the commit failed.
 */
export async function commitWorkInProgress(clone: string): Promise<{ wipCommit?: string; error?: string }> {
  try {
    const st = await git(clone, ['status', '--porcelain', '--untracked-files=all']);
    if (!st.stdout.trim()) return {};
    await git(clone, ['add', '-A']);
    await git(clone, ['reset', '-q', '--', '.orchestrator'], { allowFail: true });
    const staged = await git(clone, ['diff', '--cached', '--quiet'], { allowFail: true });
    if (staged.code === 0) return {};
    await git(clone, ['commit', '-q', '--no-verify', '-m', 'orchestrator-worker: work in progress at pod termination'], { env: WIP_IDENTITY });
    return { wipCommit: (await git(clone, ['rev-parse', 'HEAD'])).stdout.trim() };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** Push `HEAD` to `branch` on origin, forced or not, within `TERMINATION_PUSH_MS`. Answers git's message on failure. */
export async function pushHead(clone: string, branch: string, opts: { force?: boolean; timeoutMs?: number } = {}): Promise<{ ok: true } | { ok: false; error: string }> {
  const r = await git(clone, ['push', '-q', ...(opts.force ? ['--force'] : []), 'origin', `HEAD:refs/heads/${branch}`], { allowFail: true, timeoutMs: opts.timeoutMs ?? TERMINATION_PUSH_MS });
  if (r.code === 0) return { ok: true };
  return { ok: false, error: (r.stderr || r.stdout || `git push exited with ${r.code}`).trim() };
}

/** What a hand-back did: whether the push went through, and the release's answer (or that none came). */
export interface HandBackOutcome {
  /** The work-in-progress commit, when one was made. */
  wipCommit?: string;
  /** Why the work-in-progress commit could not be made; the hand-back went on without it. */
  wipError?: string;
  /** The pushed `HEAD`. */
  headSha?: string;
  pushed: boolean;
  pushError?: string;
  /** Absent when the push failed and no release was sent. */
  release?: { status: number; body: Record<string, unknown> } | { status: undefined; error: string };
}

/**
 * Hand a held launch back: commit work in progress, push `HEAD` to the launch branch (forced, bounded), and release
 * with `{ workerId, reason: 'podTerminating', keep: true, headSha, wipCommit? }`. No release follows a failed push;
 * neither step is tried again. The push comes first, so a lease expiry keeps the work when the release is not made.
 */
export async function handBack(o: { clone: string; branch: string; launchId: string; workerId: string; call: ApiCall; pushTimeoutMs?: number }): Promise<HandBackOutcome> {
  const out: HandBackOutcome = { pushed: false };
  const wip = await commitWorkInProgress(o.clone);
  if (wip.wipCommit) out.wipCommit = wip.wipCommit;
  if (wip.error) out.wipError = wip.error;
  try {
    out.headSha = (await git(o.clone, ['rev-parse', 'HEAD'])).stdout.trim();
  } catch (e) {
    out.pushError = e instanceof Error ? e.message : String(e);
    return out;
  }
  const push = await pushHead(o.clone, o.branch, { force: true, timeoutMs: o.pushTimeoutMs });
  if (!push.ok) {
    out.pushError = push.error;
    return out;
  }
  out.pushed = true;
  const body: Record<string, unknown> = { workerId: o.workerId, reason: POD_TERMINATING, keep: true, headSha: out.headSha, ...(out.wipCommit ? { wipCommit: out.wipCommit } : {}) };
  try {
    const r: ApiResult = await o.call('POST', `/v1/launches/${o.launchId}/release`, body);
    out.release = { status: r.status, body: r.body };
  } catch (e) {
    out.release = { status: undefined, error: e instanceof Error ? e.message : String(e) };
  }
  return out;
}

/** The loop's exit code after a hand-back: 0 when the release was answered 200, whatever `kept` says; else 1. */
export function handBackExitCode(o: HandBackOutcome): number {
  return o.pushed && o.release?.status === 200 ? 0 : 1;
}
