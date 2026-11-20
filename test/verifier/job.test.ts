/**
 * One verify job of the verifier loop (`workVerifyJob`) against a real bare origin, with no API: the clone, the fetch,
 * the worktree, the daemon's rebase, the check, the push to `refs/verify/<jobId>` and the answer.
 * See specs/verifier-pool "Verifier job steps" and "Verifier check environment".
 */
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { VERIFIER_GIT_TIMEOUT_MS, type VerifyClaim, type WorkOptions, workVerifyJob } from '../../src/verifier/job.js';
import { gitIn, makeRepo } from '../slice/harness.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Fx {
  dir: string;
  bare: string;
  /** A clone of origin the test commits in and pushes from. */
  work: string;
  cache: string;
  base: string;
}

function fixture(): Fx {
  // The real path: the check's `pwd` resolves symlinks (macOS /var -> /private/var).
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'orch-verifier-job-')));
  dirs.push(dir);
  const repo = makeRepo(dir);
  const bare = path.join(dir, 'origin.git');
  gitIn(dir, 'clone', '-q', '--bare', repo, bare);
  const work = path.join(dir, 'work');
  gitIn(dir, 'clone', '-q', bare, work);
  return { dir, bare, work, cache: path.join(dir, 'cache'), base: gitIn(work, 'rev-parse', 'HEAD') };
}

function commit(clone: string, file: string, text = `${file}\n`): string {
  writeFileSync(path.join(clone, file), text);
  gitIn(clone, 'add', file);
  gitIn(clone, 'commit', '-q', '-m', `change ${file}`);
  return gitIn(clone, 'rev-parse', 'HEAD');
}

/** `main` gets one commit past the base (the expected head); branch `task` one other commit past the base (the sealed commit). */
function diverged(f: Fx, opts: { head?: [string, string]; sealed?: [string, string] } = {}): { expectedHead: string; sealedSha: string } {
  const [hf, ht] = opts.head ?? ['head.txt', 'head\n'];
  const [sf, st] = opts.sealed ?? ['sealed.txt', 'sealed\n'];
  gitIn(f.work, 'checkout', '-q', 'main');
  const expectedHead = commit(f.work, hf, ht);
  gitIn(f.work, 'push', '-q', 'origin', 'main');
  gitIn(f.work, 'checkout', '-q', '-b', 'task', f.base);
  const sealedSha = commit(f.work, sf, st);
  gitIn(f.work, 'push', '-q', 'origin', 'task');
  return { expectedHead, sealedSha };
}

function claimFor(f: Fx, over: Partial<VerifyClaim> & Pick<VerifyClaim, 'expectedHead' | 'sealedSha'>): VerifyClaim {
  return {
    jobId: randomUUID(),
    token: `tok-${randomUUID().replace(/-/g, '')}`,
    taskId: 'T1',
    repoUrl: f.bare,
    baseSha: f.base,
    noChanges: false,
    checkCommand: 'true',
    checkTimeoutMs: 30_000,
    ...over,
  };
}

function options(f: Fx, over: Partial<WorkOptions> = {}) {
  const events: string[] = [];
  const stderr: string[] = [];
  const sleeps: number[] = [];
  const o: WorkOptions = {
    cache: f.cache,
    log: (event) => void events.push(event),
    err: (t) => void stderr.push(t),
    sleep: async (ms) => void sleeps.push(ms),
    ...over,
  };
  return { o, events, stderr, sleeps };
}

const verifyRefs = (f: Fx) => gitIn(f.dir, 'ls-remote', f.bare, 'refs/verify/*');
const jobDir = (f: Fx, c: VerifyClaim) => path.join(f.cache, 'verify', c.jobId);

describe('workVerifyJob: verified', () => {
  it('rebases the sealed commit onto the expected head, runs the check in <cache>/verify/<jobId>, pushes refs/verify/<jobId> and removes the worktree', async () => {
    const f = fixture();
    const { expectedHead, sealedSha } = diverged(f);
    const pwdFile = path.join(f.dir, 'pwd.txt');
    const claim = claimFor(f, { expectedHead, sealedSha, checkCommand: `pwd > ${pwdFile}` });
    const { o, events, stderr } = options(f);
    const answer = await workVerifyJob(claim, o);
    expect(answer).toEqual({ outcome: 'verified', rebasedSha: expect.stringMatching(/^[0-9a-f]{40}$/) });
    const rebasedSha = answer!.rebasedSha!;
    expect(rebasedSha).not.toBe(expectedHead);
    expect(readFileSync(pwdFile, 'utf8').trim()).toBe(jobDir(f, claim));
    expect(gitIn(f.bare, 'rev-parse', `refs/verify/${claim.jobId}`)).toBe(rebasedSha);
    // In a clone of origin, the expected head is an ancestor of the pushed commit.
    const check = path.join(f.dir, 'check-clone');
    gitIn(f.dir, 'clone', '-q', f.bare, check);
    gitIn(check, 'fetch', '-q', 'origin', `refs/verify/${claim.jobId}`);
    gitIn(check, 'merge-base', '--is-ancestor', expectedHead, rebasedSha);
    expect(gitIn(check, 'show', `${rebasedSha}:sealed.txt`)).toBe('sealed');
    expect(gitIn(check, 'show', `${rebasedSha}:head.txt`)).toBe('head');
    expect(existsSync(jobDir(f, claim))).toBe(false);
    expect(events.filter((e) => e === 'check')).toHaveLength(1);
    // The check's command and exit are written to stderr.
    expect(stderr.join('')).toContain(`pwd > ${pwdFile}`);
    expect(stderr.join('')).toMatch(/exit: 0/);
  }, 30_000);
});

describe('workVerifyJob: failed check', () => {
  it('answers checkFailed with the output and pushes nothing; a check past its limit answers checkTimeout', async () => {
    const f = fixture();
    const { expectedHead, sealedSha } = diverged(f);
    const failed = await workVerifyJob(claimFor(f, { expectedHead, sealedSha, checkCommand: 'echo boom; exit 3' }), options(f).o);
    expect(failed).toMatchObject({ outcome: 'checkFailed' });
    expect(failed!.output).toContain('boom');
    expect(verifyRefs(f)).toBe('');
    const slow = await workVerifyJob(claimFor(f, { expectedHead, sealedSha, checkCommand: 'sleep 5', checkTimeoutMs: 200 }), options(f).o);
    expect(slow).toMatchObject({ outcome: 'checkTimeout' });
    expect(verifyRefs(f)).toBe('');
  }, 30_000);
});

describe('workVerifyJob: rebase', () => {
  it('answers conflict with the unmerged files when both sides change shared.txt, and runs no check', async () => {
    const f = fixture();
    const { expectedHead, sealedSha } = diverged(f, { head: ['shared.txt', 'head\n'], sealed: ['shared.txt', 'sealed\n'] });
    const marker = path.join(f.dir, 'marker');
    const claim = claimFor(f, { expectedHead, sealedSha, checkCommand: `touch ${marker}` });
    expect(await workVerifyJob(claim, options(f).o)).toEqual({ outcome: 'conflict', conflictFiles: ['shared.txt'] });
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(jobDir(f, claim))).toBe(false);
  }, 30_000);

  it('answers rebaseFailed naming the sha when origin lacks the sealed commit, and runs no check', async () => {
    const f = fixture();
    const { expectedHead } = diverged(f);
    const unpushed = commit(f.work, 'local.txt');
    const marker = path.join(f.dir, 'marker');
    const answer = await workVerifyJob(claimFor(f, { expectedHead, sealedSha: unpushed, checkCommand: `touch ${marker}` }), options(f).o);
    expect(answer).toMatchObject({ outcome: 'rebaseFailed' });
    expect(answer!.output).toContain(unpushed);
    expect(existsSync(marker)).toBe(false);
  }, 30_000);
});

describe('workVerifyJob: nothing to check', () => {
  it('answers verified at the expected head when it already holds the sealed commit, with no check and no push', async () => {
    const f = fixture();
    gitIn(f.work, 'checkout', '-q', '-b', 'task', f.base);
    const sealedSha = commit(f.work, 'sealed.txt');
    gitIn(f.work, 'push', '-q', 'origin', 'task');
    gitIn(f.work, 'checkout', '-q', 'main');
    gitIn(f.work, 'merge', '-q', '--ff-only', 'task');
    const expectedHead = commit(f.work, 'after.txt');
    gitIn(f.work, 'push', '-q', 'origin', 'main');
    const marker = path.join(f.dir, 'marker');
    const { o, events } = options(f);
    expect(await workVerifyJob(claimFor(f, { expectedHead, sealedSha, checkCommand: `touch ${marker}` }), o)).toEqual({ outcome: 'verified', rebasedSha: expectedHead });
    expect(existsSync(marker)).toBe(false);
    expect(events).not.toContain('check');
    expect(verifyRefs(f)).toBe('');
  }, 30_000);

  it('with noChanges and a sealed range that leaves the tree as it was, runs no check and pushes the rebased head', async () => {
    const f = fixture();
    gitIn(f.work, 'checkout', '-q', 'main');
    const expectedHead = commit(f.work, 'head.txt');
    gitIn(f.work, 'push', '-q', 'origin', 'main');
    gitIn(f.work, 'checkout', '-q', '-b', 'task', f.base);
    commit(f.work, 'shared.txt', 'changed\n');
    const sealedSha = commit(f.work, 'shared.txt', 'base\n');
    gitIn(f.work, 'push', '-q', 'origin', 'task');
    const marker = path.join(f.dir, 'marker');
    const claim = claimFor(f, { expectedHead, sealedSha, noChanges: true, checkCommand: `touch ${marker}` });
    const answer = await workVerifyJob(claim, options(f).o);
    expect(answer).toMatchObject({ outcome: 'verified' });
    expect(answer!.rebasedSha).not.toBe(expectedHead);
    expect(existsSync(marker)).toBe(false);
    expect(gitIn(f.bare, 'rev-parse', `refs/verify/${claim.jobId}`)).toBe(answer!.rebasedSha);
  }, 30_000);
});

describe('workVerifyJob: origin', () => {
  it('answers originFailed for a repoUrl that does not exist and for an expected head origin lacks', async () => {
    const f = fixture();
    const { expectedHead, sealedSha } = diverged(f);
    const gone = await workVerifyJob(claimFor(f, { expectedHead, sealedSha, repoUrl: path.join(f.dir, 'missing.git') }), options(f).o);
    expect(gone).toMatchObject({ outcome: 'originFailed' });
    expect(gone!.output).toBeTruthy();
    const lacking = await workVerifyJob(claimFor(f, { expectedHead: 'a'.repeat(40), sealedSha }), options(f).o);
    expect(lacking).toMatchObject({ outcome: 'originFailed' });
    expect(lacking!.output).toContain('a'.repeat(40));
  }, 30_000);

  it('tries a refused push three times under LC_ALL=C, two seconds apart, then answers originFailed with the hook message', async () => {
    const f = fixture();
    const { expectedHead, sealedSha } = diverged(f);
    const hookLog = path.join(f.dir, 'hook.log');
    const hook = path.join(f.bare, 'hooks', 'pre-receive');
    writeFileSync(
      hook,
      `#!/bin/sh\necho "LC_ALL=$LC_ALL" >> ${hookLog}\nwhile read old new ref; do\n  case "$ref" in refs/verify/*) echo "verify refs are refused here" >&2; exit 1;; esac\ndone\nexit 0\n`,
    );
    chmodSync(hook, 0o755);
    const { o, sleeps } = options(f);
    const answer = await workVerifyJob(claimFor(f, { expectedHead, sealedSha }), o);
    expect(answer).toMatchObject({ outcome: 'originFailed' });
    expect(answer!.output).toContain('verify refs are refused here');
    expect(readFileSync(hookLog, 'utf8').trim().split('\n')).toEqual(['LC_ALL=C', 'LC_ALL=C', 'LC_ALL=C']);
    expect(sleeps).toEqual([2000, 2000]);
  }, 30_000);

  it('a push past o.gitTimeoutMs counts as a failure that says it timed out; the default limit is 120000 ms', async () => {
    expect(VERIFIER_GIT_TIMEOUT_MS).toBe(120_000);
    const f = fixture();
    const { expectedHead, sealedSha } = diverged(f);
    const hook = path.join(f.bare, 'hooks', 'pre-receive');
    writeFileSync(hook, '#!/bin/sh\nsleep 10\nexit 0\n');
    chmodSync(hook, 0o755);
    const answer = await workVerifyJob(claimFor(f, { expectedHead, sealedSha }), options(f, { gitTimeoutMs: 500 }).o);
    expect(answer).toMatchObject({ outcome: 'originFailed' });
    expect(answer!.output).toContain('timed out');
  }, 30_000);
});

describe('workVerifyJob: abort', () => {
  it('kills the check when the signal is aborted, answers undefined within two seconds, pushes nothing and removes the worktree', async () => {
    const f = fixture();
    const { expectedHead, sealedSha } = diverged(f);
    const pidFile = path.join(f.dir, 'check.pid');
    const claim = claimFor(f, { expectedHead, sealedSha, checkCommand: `echo $$ > ${pidFile}; exec sleep 30` });
    const ctl = new AbortController();
    const running = workVerifyJob(claim, options(f, { signal: ctl.signal }).o);
    const deadline = Date.now() + 20_000;
    while (!existsSync(pidFile) || readFileSync(pidFile, 'utf8').trim() === '') {
      if (Date.now() > deadline) throw new Error('the check never started');
      await new Promise((r) => setTimeout(r, 25));
    }
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    const t0 = Date.now();
    ctl.abort();
    expect(await running).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(() => process.kill(pid, 0)).toThrow();
    expect(verifyRefs(f)).toBe('');
    expect(existsSync(jobDir(f, claim))).toBe(false);
  }, 30_000);
});

describe('workVerifyJob: check environment', () => {
  it('gives the check the environment of a process with no store: no client, run or database variables, ORCH_HOME in the cache, and no job token', async () => {
    const f = fixture();
    const { expectedHead, sealedSha } = diverged(f);
    const set = { ORCH_URL: 'http://127.0.0.1:1', ORCH_RUN_ID: 'run-secret', DATABASE_URL: 'postgres://u:p@db/x', PGPASSWORD: 'pg-secret' };
    const saved = Object.fromEntries(Object.keys(set).map((k) => [k, process.env[k]]));
    Object.assign(process.env, set);
    try {
      const envFile = path.join(f.dir, 'check.env');
      const claim = claimFor(f, { expectedHead, sealedSha, checkCommand: `env > ${envFile}` });
      expect(await workVerifyJob(claim, options(f).o)).toMatchObject({ outcome: 'verified' });
      const env = readFileSync(envFile, 'utf8');
      const names = env.split('\n').map((l) => l.split('=')[0]);
      for (const k of Object.keys(set)) expect(names, k).not.toContain(k);
      expect(env.split('\n')).toContain(`ORCH_HOME=${path.join(f.cache, 'child-home')}`);
      expect(env).not.toContain(claim.token);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }, 30_000);
});
