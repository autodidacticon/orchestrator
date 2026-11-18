import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { gitTopLevel, repoOfWorktree } from '../../src/runs/runDir.js';
import { gitIn, makeRepo } from '../slice/harness.js';

// See specs/operator-mcp "Operator MCP server": a path in a linked worktree names the main working tree of its repository.
let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function fixture() {
  const base = mkdtempSync(path.join(tmpdir(), 'orch-repo-of-wt-'));
  dirs.push(base);
  const repo = makeRepo(base);
  const worktree = path.join(base, 'worktrees', 'launch-1');
  mkdirSync(path.dirname(worktree));
  gitIn(repo, 'worktree', 'add', '-q', '-b', 'task/T1/l1', worktree);
  return { base, repo, worktree };
}

describe('repoOfWorktree', () => {
  it('names the main working tree for a path inside a linked worktree', async () => {
    const { repo, worktree } = fixture();
    // The old rule names the worktree itself.
    expect(await gitTopLevel(worktree)).toBe(realpathSync(worktree));
    expect(await repoOfWorktree(worktree)).toBe(realpathSync(repo));
    mkdirSync(path.join(worktree, 'src', 'deep'), { recursive: true });
    expect(await repoOfWorktree(path.join(worktree, 'src', 'deep'))).toBe(realpathSync(repo));
  });

  it('names the real top level for the main working tree and a subdirectory of it', async () => {
    const { repo } = fixture();
    expect(await repoOfWorktree(repo)).toBe(realpathSync(repo));
    mkdirSync(path.join(repo, 'sub', 'dir'), { recursive: true });
    expect(await repoOfWorktree(path.join(repo, 'sub'))).toBe(realpathSync(repo));
    expect(await repoOfWorktree(path.join(repo, 'sub', 'dir'))).toBe(realpathSync(repo));
  });

  it('returns real paths through a symlink to either tree', async () => {
    const { base, repo, worktree } = fixture();
    symlinkSync(repo, path.join(base, 'repo-link'));
    symlinkSync(worktree, path.join(base, 'wt-link'));
    expect(await repoOfWorktree(path.join(base, 'repo-link'))).toBe(realpathSync(repo));
    expect(await repoOfWorktree(path.join(base, 'wt-link'))).toBe(realpathSync(repo));
  });

  it('throws outside a git repository', async () => {
    const outside = realpathSync(mkdtempSync(path.join(tmpdir(), 'orch-not-git-')));
    dirs.push(outside);
    await expect(repoOfWorktree(outside)).rejects.toThrow();
  });
});
