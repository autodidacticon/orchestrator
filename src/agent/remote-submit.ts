/**
 * The shim's steps before a remote submit (`ORCH_ACCESS=remote`): the daemon cannot see the worker's clone, so the
 * shim checks it, pushes the launch branch to origin and names the pushed commit as `sealedSha`. See
 * specs/agent-protocol "MCP façade".
 */
import { dirtyFiles, git, revParse } from '../workspace/git.js';
import { ORCH_DIR } from '../workspace/git-workspace.js';

/** The push's limit: git is killed with its transport helpers when it runs longer. */
export const REMOTE_PUSH_TIMEOUT_MS = 60_000;

export type RemoteSubmitResult =
  | { ok: true; sealedSha: string }
  | { ok: false; status: 409; error: 'dirtyWorktree'; files: string[] }
  | { ok: false; status: 503; error: 'pushFailed'; message: string }
  | { ok: false; status: 500; error: 'gitFailed'; message: string };

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Before a remote submit: the dirty check by the rule of a local seal (`.orchestrator/` does not count), then
 * `git push --force origin HEAD:refs/heads/<branch>` within `REMOTE_PUSH_TIMEOUT_MS`, then the full sha of `HEAD`.
 * Answers the sha, or the refusal the shim returns without calling the daemon. Never throws.
 */
export async function prepareRemoteSubmit(worktree: string, branch: string, opts: { pushTimeoutMs?: number } = {}): Promise<RemoteSubmitResult> {
  let dirty: string[];
  try {
    dirty = (await dirtyFiles(worktree)).filter((f) => !f.startsWith(`${ORCH_DIR}/`));
  } catch (err) {
    return { ok: false, status: 500, error: 'gitFailed', message: messageOf(err) };
  }
  if (dirty.length) return { ok: false, status: 409, error: 'dirtyWorktree', files: dirty };
  // HEAD is pushed whatever branch the clone has checked out, or none: the launch branch belongs to this launch alone,
  // and an agent may have rebased it, so the push is forced. git never prompts (GIT_TERMINAL_PROMPT=0).
  const push = await git(worktree, ['push', '--force', 'origin', `HEAD:refs/heads/${branch}`], { allowFail: true, timeoutMs: opts.pushTimeoutMs ?? REMOTE_PUSH_TIMEOUT_MS });
  if (push.code !== 0) return { ok: false, status: 503, error: 'pushFailed', message: (push.stderr.trim() || push.stdout.trim() || `git push exited with ${push.code}`).slice(0, 2000) };
  try {
    return { ok: true, sealedSha: await revParse(worktree, 'HEAD') };
  } catch (err) {
    return { ok: false, status: 500, error: 'gitFailed', message: messageOf(err) };
  }
}
