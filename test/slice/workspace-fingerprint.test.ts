import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Launch } from '../../src/state/store.js';
import { git } from '../../src/workspace/git.js';
import { GitWorkspace } from '../../src/workspace/git-workspace.js';
import { gitIn, makeRepo } from './harness.js';

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const launchAt = (worktree: string): Launch => ({ launchId: 'L1', taskId: 'T1', attempt: 1, launchNo: 1, status: 'live', token: 't', branch: 'task/T1/l1', worktree, baseSha: 's', graphRev: 'r', createdAt: 1 });

const indexStat = (repo: string) => {
  const s = statSync(path.join(repo, '.git', 'index'));
  return { ino: s.ino, mtimeMs: s.mtimeMs, size: s.size };
};

/** Move a file's mtime forward without changing its content, as a formatter or checkout does. */
const touch = (file: string, secondsAhead: number) => {
  const t = new Date(Date.now() + secondsAhead * 1000);
  utimesSync(file, t, t);
};

describe('worktree fingerprint takes no index lock (specs/health-monitoring "Worktree observation takes no index lock")', () => {
  it('daemon git commands run with GIT_OPTIONAL_LOCKS=0', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'orch-fpl-'));
    const repo = makeRepo(dir);
    const r = await git(repo, ['-c', 'alias.optlocks=!printenv GIT_OPTIONAL_LOCKS', 'optlocks']);
    expect(r.stdout.trim()).toBe('0');
  });

  it('a content-preserving touch of a tracked file leaves .git/index unrewritten, creates no index.lock, and keeps the fingerprint', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'orch-fpl-'));
    const repo = makeRepo(dir);
    const ws = new GitWorkspace(repo, 'main', path.join(dir, 'wt'));
    const l = launchAt(repo);
    const clean = await ws.fingerprint(l);
    const before = indexStat(repo);
    // Make both tracked files stat-dirty: content unchanged, mtime ahead of the index entry.
    touch(path.join(repo, 'shared.txt'), 5);
    touch(path.join(repo, 'README.md'), 5);
    for (let i = 0; i < 3; i++) {
      expect(await ws.fingerprint(l)).toBe(clean);
      expect(indexStat(repo)).toEqual(before);
      expect(existsSync(path.join(repo, '.git', 'index.lock'))).toBe(false);
    }
    // Control: porcelain `git diff HEAD` would have rewritten the index here, which is why the fingerprint avoids it.
    await git(repo, ['diff', 'HEAD']);
    expect(indexStat(repo)).not.toEqual(before);
  });

  it('still changes on a content edit and an untracked file, and ignores .orchestrator/, all without writing the index', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'orch-fpl-'));
    const repo = makeRepo(dir);
    // A tracked file under .orchestrator/ exercises the diff-index pathspec exclusion; an untracked one, the status filter.
    mkdirSync(path.join(repo, '.orchestrator'));
    writeFileSync(path.join(repo, '.orchestrator', 'tracked.md'), 'tracked\n');
    gitIn(repo, 'add', '-A');
    gitIn(repo, 'commit', '-q', '-m', 'track .orchestrator');
    const ws = new GitWorkspace(repo, 'main', path.join(dir, 'wt'));
    const l = launchAt(repo);
    const clean = await ws.fingerprint(l);
    const before = indexStat(repo);
    writeFileSync(path.join(repo, '.orchestrator', 'tracked.md'), 'tracked, edited\n');
    writeFileSync(path.join(repo, '.orchestrator', 'brief.md'), 'brief\n');
    expect(await ws.fingerprint(l)).toBe(clean);
    writeFileSync(path.join(repo, 'shared.txt'), 'edited\n');
    const edited = await ws.fingerprint(l);
    expect(edited).not.toBe(clean);
    writeFileSync(path.join(repo, '.orchestrator', 'brief.md'), 'brief two\n');
    expect(await ws.fingerprint(l)).toBe(edited);
    writeFileSync(path.join(repo, 'new.txt'), 'untracked\n');
    const untracked = await ws.fingerprint(l);
    expect(untracked).not.toBe(edited);
    expect(indexStat(repo)).toEqual(before);
    expect(existsSync(path.join(repo, '.git', 'index.lock'))).toBe(false);
  });
});
