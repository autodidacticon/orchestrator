import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { headOf } from '../../src/health/progress.js';
import type { Launch } from '../../src/state/store.js';
import { FakeWorkspace } from '../../src/workspace/fake.js';
import { GitWorkspace } from '../../src/workspace/git-workspace.js';
import { gitIn, makeRepo } from '../slice/harness.js';

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const launchAt = (worktree: string): Launch => ({ launchId: 'L1', taskId: 'T1', attempt: 1, launchNo: 1, status: 'live', token: 't', branch: 'task/T1/l1', worktree, baseSha: 's', graphRev: 'r', createdAt: 1 });

describe('progress fingerprint', () => {
  it('fake workspace: scripted per launch, head plus clean by default', async () => {
    const ws = new FakeWorkspace();
    const l = launchAt('/nowhere');
    expect(await ws.fingerprint(l)).toBe('head0:clean');
    ws.fingerprints.set('L1', 'head0:dirty');
    expect(await ws.fingerprint(l)).toBe('head0:dirty');
    expect(headOf('abc:def')).toBe('abc');
    expect(headOf(undefined)).toBeUndefined();
  });

  it('git workspace: changes on an uncommitted edit, on a further edit to the same file, on an untracked file, and on a commit', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'orch-fp-'));
    const repo = makeRepo(dir);
    const ws = new GitWorkspace(repo, 'main', path.join(dir, 'wt'));
    const l = launchAt(repo);
    const clean = await ws.fingerprint(l);
    expect(clean).toMatch(/^[0-9a-f]{40}:[0-9a-f]{16}$/);
    expect(await ws.fingerprint(l)).toBe(clean);
    writeFileSync(path.join(repo, 'shared.txt'), 'edit one\n');
    const edited = await ws.fingerprint(l);
    expect(edited).not.toBe(clean);
    expect(headOf(edited)).toBe(headOf(clean));
    writeFileSync(path.join(repo, 'shared.txt'), 'edit two\n');
    const editedAgain = await ws.fingerprint(l);
    expect(editedAgain).not.toBe(edited);
    writeFileSync(path.join(repo, 'new.txt'), 'untracked\n');
    const untracked = await ws.fingerprint(l);
    expect(untracked).not.toBe(editedAgain);
    gitIn(repo, 'add', '-A');
    gitIn(repo, 'commit', '-q', '-m', 'work');
    const committed = await ws.fingerprint(l);
    expect(headOf(committed)).not.toBe(headOf(clean));
    // .orchestrator/ never counts
    writeFileSync(path.join(repo, '.orchestrator-marker'), 'x');
    const before = await ws.fingerprint(l);
    rmSync(path.join(repo, '.orchestrator-marker'));
    expect(await ws.fingerprint(l)).not.toBe(before);
    expect(await ws.fingerprint(l)).toBe(committed);
  });
});
