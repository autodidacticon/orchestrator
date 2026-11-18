/**
 * The progress fingerprint of a working tree: the head sha, a colon, and a 16-hex hash over `git status --porcelain`
 * (minus `.orchestrator/`) and `git diff-index -p HEAD`, so a further edit to an already dirty file still registers.
 * `diff-index` is plumbing and never refreshes the index; porcelain `git diff` does, taking index.lock even under
 * GIT_OPTIONAL_LOCKS=0. A touch that keeps a tracked file's content shows in neither, so it does not change the value.
 * One function for the daemon's worktrees (`GitWorkspace.fingerprint`) and a remote worker's clone (the loop's
 * heartbeat), so both give the same string for the same tree. See specs/health-monitoring "Progress signals".
 */
import { createHash } from 'node:crypto';
import { git, revParse } from './git.js';

/** The directory the orchestrator writes into a tree; never part of the fingerprint. */
export const FINGERPRINT_EXCLUDED_DIR = '.orchestrator';

export async function treeFingerprint(dir: string): Promise<string> {
  const head = await revParse(dir, 'HEAD');
  const status = await git(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { allowFail: true });
  const entries = status.stdout.split('\0').filter((e) => e && !e.slice(3).startsWith(`${FINGERPRINT_EXCLUDED_DIR}/`));
  const diff = await git(dir, ['diff-index', '-p', 'HEAD', '--', '.', `:(exclude)${FINGERPRINT_EXCLUDED_DIR}`], { allowFail: true });
  const hash = createHash('sha256').update(entries.join('\0')).update('\n').update(diff.stdout).digest('hex').slice(0, 16);
  return `${head}:${hash}`;
}

/** A fingerprint as a heartbeat carries it: a full hex head sha, a colon, a hex hash. */
export const FINGERPRINT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64}):[0-9a-f]{1,64}$/;
