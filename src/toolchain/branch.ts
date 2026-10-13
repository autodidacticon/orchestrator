/**
 * Integration branch detection: the remote's default branch when it exists
 * locally, else the checked-out branch, else nothing (the default applies).
 * See specs/toolchain-discovery "Integration branch detection and pinning".
 */
import { git } from '../workspace/git.js';

export async function detectIntegrationBranch(repo: string): Promise<string | undefined> {
  const originHead = await git(repo, ['symbolic-ref', '-q', 'refs/remotes/origin/HEAD'], { allowFail: true });
  if (originHead.code === 0) {
    const name = originHead.stdout.trim().replace(/^refs\/remotes\/origin\//, '');
    if (name && (await git(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`], { allowFail: true })).code === 0) return name;
  }
  const current = await git(repo, ['symbolic-ref', '-q', '--short', 'HEAD'], { allowFail: true });
  if (current.code === 0 && current.stdout.trim()) return current.stdout.trim();
  return undefined;
}
