/**
 * The daemon's own git commands carry no store URL: specs/state-backend "No store URL in child environments".
 * A project hook prints its environment into a file outside the worktree; the daemon's environment holds the store.
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearWithheldStoreUrls, LIBPQ_VARS, withholdStoreUrl } from '../../src/runs/childEnv.js';
import type { Launch } from '../../src/state/store.js';
import { git } from '../../src/workspace/git.js';
import { GitWorkspace } from '../../src/workspace/git-workspace.js';
import { makeRepo } from './harness.js';

const URL = 'postgres://orch:s3cret-pw@db.internal:5432/orch';
const SAVED = ['DATABASE_URL', 'DATABASE_URL_FILE', 'ORCH_RUN_ID', 'ORCH_STORE_COPY', 'ORCH_TEST_UNRELATED', ...LIBPQ_VARS] as const;
/** The libpq variables of a store URL built from parts (ORC-100): the password is in PGPASSWORD, matched by no URL. */
const LIBPQ_PW = 'pg-pw-Qm4-s3cret';

let dir: string | undefined;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(SAVED.map((k) => [k, process.env[k]]));
  process.env.DATABASE_URL = URL;
  process.env.ORCH_RUN_ID = 'run-abc';
  process.env.ORCH_STORE_COPY = URL;
  process.env.ORCH_TEST_UNRELATED = 'kept';
  process.env.DATABASE_URL_FILE = '/run/secrets/db/uri';
  for (const k of LIBPQ_VARS) process.env[k] = k === 'PGPASSWORD' ? LIBPQ_PW : `v-${k}`;
  withholdStoreUrl(URL);
});

afterEach(() => {
  for (const k of SAVED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  clearWithheldStoreUrls();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const launchAt = (worktree: string): Launch => ({ launchId: 'L1', taskId: 'T1', attempt: 1, launchNo: 1, status: 'live', token: 't', branch: 'task/T1/l1', worktree, baseSha: 's', graphRev: 'r', createdAt: 1 });

/** Install a hook that appends its environment to `out`. */
const envHook = (repo: string, name: string, out: string) => {
  const hook = path.join(repo, '.git', 'hooks', name);
  writeFileSync(hook, `#!/bin/sh\nenv >> '${out}'\n`);
  chmodSync(hook, 0o755);
};

const expectNoStore = (printed: string) => {
  expect(printed).toContain('ORCH_TEST_UNRELATED=kept');
  expect(printed).not.toMatch(/^DATABASE_URL=/m);
  expect(printed).not.toMatch(/^ORCH_RUN_ID=/m);
  expect(printed).not.toMatch(/^ORCH_STORE_COPY=/m);
  expect(printed).not.toContain('s3cret-pw');
  expect(printed).not.toMatch(/^DATABASE_URL_FILE=/m);
  expect(printed).not.toContain(LIBPQ_PW);
  for (const k of LIBPQ_VARS) expect(printed, k).not.toMatch(new RegExp(`^${k}=`, 'm'));
  expect(printed).toMatch(/^GIT_TERMINAL_PROMPT=0$/m);
  expect(printed).toMatch(/^GIT_CONFIG_NOSYSTEM=1$/m);
  expect(printed).toMatch(/^GIT_OPTIONAL_LOCKS=0$/m);
};

describe('daemon git commands carry no store URL (specs/state-backend "No store URL in child environments")', () => {
  it('a hook run by the kept-release WIP commit sees neither DATABASE_URL nor any variable holding the store URL', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'orch-genv-'));
    const repo = makeRepo(dir);
    const out = path.join(dir, 'hook-env.txt');
    // The WIP commit runs with --no-verify, which skips pre-commit and commit-msg; post-commit still runs.
    envHook(repo, 'pre-commit', out);
    envHook(repo, 'post-commit', out);
    writeFileSync(path.join(repo, 'shared.txt'), 'agent edit\n');
    const ws = new GitWorkspace(repo, 'main', path.join(dir, 'wt'));
    const r = await ws.preserve(launchAt(repo), { untracked: false });
    expect(r.wipCommit).toBeTruthy();
    expect(existsSync(out)).toBe(true);
    expectNoStore(readFileSync(out, 'utf8'));
  });

  it('a pre-commit hook run by a daemon git commit, and the plain and bounded git paths, see no store URL', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'orch-genv-'));
    const repo = makeRepo(dir);
    const out = path.join(dir, 'hook-env.txt');
    envHook(repo, 'pre-commit', out);
    writeFileSync(path.join(repo, 'shared.txt'), 'edit\n');
    await git(repo, ['add', '-A']);
    await git(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'edit']);
    expectNoStore(readFileSync(out, 'utf8'));

    const unbounded = await git(repo, ['-c', 'alias.penv=!env', 'penv']);
    expectNoStore(unbounded.stdout);
    const bounded = await git(repo, ['-c', 'alias.penv=!env', 'penv'], { timeoutMs: 30_000 });
    expectNoStore(bounded.stdout);
  });

  it('reads the environment when each command runs, not at import', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'orch-genv-'));
    const repo = makeRepo(dir);
    process.env.ORCH_TEST_UNRELATED = 'changed-later';
    process.env.ORCH_STORE_COPY = 'postgres://late@db/orch';
    withholdStoreUrl('postgres://late@db/orch');
    const r = await git(repo, ['-c', 'alias.penv=!env', 'penv']);
    expect(r.stdout).toMatch(/^ORCH_TEST_UNRELATED=changed-later$/m);
    expect(r.stdout).not.toContain('late@db');
  });
});
