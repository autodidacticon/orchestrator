import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectIntegrationBranch } from '../../src/toolchain/branch.js';
import { gitIn, makeRepo } from '../slice/harness.js';

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});
const fresh = () => {
  const d = mkdtempSync(path.join(tmpdir(), 'orch-branch-'));
  dirs.push(d);
  return d;
};

// See specs/toolchain-discovery "Integration branch detection and pinning".
describe('integration branch detection', () => {
  it('takes the branch origin/HEAD points at when it exists locally', async () => {
    const repo = makeRepo(fresh());
    gitIn(repo, 'branch', 'develop');
    gitIn(repo, 'update-ref', 'refs/remotes/origin/develop', 'HEAD');
    gitIn(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop');
    expect(gitIn(repo, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
    expect(await detectIntegrationBranch(repo)).toBe('develop');
  });

  it('falls through to the current branch when origin/HEAD names a branch missing locally', async () => {
    const repo = makeRepo(fresh());
    gitIn(repo, 'update-ref', 'refs/remotes/origin/trunk', 'HEAD');
    gitIn(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
    expect(await detectIntegrationBranch(repo)).toBe('main');
  });

  it('gives the current branch without a remote, and nothing on a detached head', async () => {
    const dir = fresh();
    const repo = path.join(dir, 'trunk-repo');
    mkdirSync(repo);
    gitIn(repo, 'init', '-q', '-b', 'trunk');
    writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    gitIn(repo, 'add', '.');
    gitIn(repo, 'commit', '-q', '-m', 'a');
    expect(await detectIntegrationBranch(repo)).toBe('trunk');
    gitIn(repo, 'checkout', '-q', '--detach');
    expect(await detectIntegrationBranch(repo)).toBeUndefined();
    expect(await detectIntegrationBranch(path.join(dir, 'not-a-repo'))).toBeUndefined();
  });
});
