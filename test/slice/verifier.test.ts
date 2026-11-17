import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { commitTrailers } from '../../src/workspace/git.js';
import { GitVerifierBackend, TRAILER_TASK } from '../../src/verify/verifier.js';
import { gitIn, makeRepo, makeSlice, single, type SliceHarness } from './harness.js';

let h: SliceHarness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

describe('slice: verifier and publication', () => {
  it('clean branch publishes one squash commit with trailers and the verified tree', async () => {
    h = await makeSlice({ graph: single('commitAndSubmit'), realVerifier: true });
    const before = gitIn(h.repo, 'rev-parse', 'main');
    await h.waitFor(() => h!.orch.entry('T1').status.kind === 'done');
    const job = h.store.listJobs({ taskId: 'T1' })[0]!;
    const head = gitIn(h.repo, 'rev-parse', 'main');
    expect(head).toBe(job.publishedSha);
    expect(gitIn(h.repo, 'rev-parse', `${head}^`)).toBe(before);
    expect(gitIn(h.repo, 'rev-parse', `${head}^{tree}`)).toBe(gitIn(h.repo, 'rev-parse', `${job.verifiedSha}^{tree}`));
    expect(await commitTrailers(h.repo, head)).toEqual({ 'Orchestrator-Task': 'T1', 'Orchestrator-Launch': job.launchId });
    expect(gitIn(h.repo, 'log', '-1', '--format=%s', 'main')).toContain('T1 done by scripted agent');
    // primary clone's working tree follows the ref
    expect(gitIn(h.repo, 'status', '--porcelain')).toBe('');
    expect(h.orch.status().foreignCommits).toEqual([]);
  });

  // See specs/worker-runners "Sandbox and commit policy".
  it('a daemon-authored commit publishes as one squash commit with the task trailer like any other', async () => {
    h = await makeSlice({ graph: single('submitDirty'), realVerifier: true, config: { runner: { claude: { commit: 'daemon' } } } });
    const before = gitIn(h.repo, 'rev-parse', 'main');
    await h.waitFor(() => h!.orch.entry('T1').status.kind === 'done');
    const job = h.store.listJobs({ taskId: 'T1' })[0]!;
    expect(gitIn(h.repo, 'log', '-1', '--format=%an', job.sealedSha)).toBe('orchestrator');
    const head = gitIn(h.repo, 'rev-parse', 'main');
    expect(head).toBe(job.publishedSha);
    expect(gitIn(h.repo, 'rev-parse', `${head}^`)).toBe(before);
    expect((await commitTrailers(h.repo, head))[TRAILER_TASK]).toBe('T1');
    expect(gitIn(h.repo, 'show', `${head}:T1.txt`)).toBe('T1 uncommitted');
  });

  // See specs/integration-pipeline "Check environment".
  it('the check runs with an isolated ORCH_HOME and no client-side daemon variables', async () => {
    h = await makeSlice({ graph: single('commitAndSubmit'), realVerifier: true, config: { checkCommand: 'test "$ORCH_HOME" = "$EXPECTED_HOME" && test -z "$ORCH_URL" && test -z "$ORCH_REPO"' } });
    process.env['EXPECTED_HOME'] = path.join(h.orch.config.dataDir, 'child-home');
    process.env['ORCH_URL'] = 'http://127.0.0.1:1';
    try {
      // Wait for the first job to finish either way: a red check fails fast here instead of racing the retry.
      await h.waitFor(() => h!.orch.entry('T1').status.kind === 'done' || ['failed', 'conflict'].includes(h!.store.listJobs({ taskId: 'T1' })[0]?.status ?? ''));
      expect(h.orch.entry('T1').status.kind).toBe('done');
      expect(h.store.listJobs({ taskId: 'T1' })[0]).toMatchObject({ status: 'published' });
    } finally {
      delete process.env['EXPECTED_HOME'];
      delete process.env['ORCH_URL'];
    }
  });

  it('red check fails with output attached to the next brief', async () => {
    h = await makeSlice({ graph: single('commitAndSubmit'), realVerifier: true, config: { checkCommand: 'echo FAIL test_x; exit 1' } });
    await h.waitFor(() => h!.orch.entry('T1').attempts >= 1);
    expect(h.store.listJobs({ taskId: 'T1' })[0]).toMatchObject({ status: 'failed', failureKind: 'checkFailed' });
    expect(h.store.listJobs({ taskId: 'T1' })[0]?.output).toContain('FAIL test_x');
    await h.waitFor(() => h!.store.listLaunches({ taskId: 'T1' }).length === 2);
    const l2 = h.store.listLaunches({ taskId: 'T1' })[1]!;
    const briefJson = JSON.parse(readFileSync(path.join(l2.worktree, '.orchestrator', 'brief.json'), 'utf8')) as { context?: { verifierOutput?: string } };
    expect(briefJson.context?.verifierOutput).toContain('FAIL test_x');
    expect(gitIn(h.repo, 'rev-list', '--count', 'main')).toBe('1');
  });

  it('check timeout is a failure', async () => {
    h = await makeSlice({ graph: single('commitAndSubmit'), realVerifier: true, config: { checkCommand: 'sleep 30', checkTimeoutMs: 300, maxAttempts: 1 } });
    await h.waitFor(() => h!.orch.entry('T1').status.kind === 'blocked');
    expect(h.store.listJobs({ taskId: 'T1' })[0]).toMatchObject({ status: 'failed', failureKind: 'checkTimeout' });
  });

  it('conflict with a sibling retries with context and then lands', async () => {
    h = await makeSlice({ graph: `nodes:\n  - { id: A, deps: [], behavior: "conflictWith:shared.txt" }\n  - { id: B, deps: [], behavior: "conflictWith:shared.txt" }`, realVerifier: true });
    await h.waitFor(() => h!.orch.entry('A').status.kind === 'done' && h!.orch.entry('B').status.kind === 'done', 30_000);
    const entries = [h.orch.entry('A'), h.orch.entry('B')];
    const retried = entries.find((e) => e.integrationRetries === 1);
    expect(retried).toBeDefined();
    expect(entries.every((e) => e.attempts === 0)).toBe(true);
    const conflictJob = h.store.listJobs().find((j) => j.status === 'conflict')!;
    expect(conflictJob.conflictFiles).toEqual(['shared.txt']);
    expect(conflictJob.conflictSince).toHaveLength(1);
    const retriedId = conflictJob.taskId;
    const launches = h.store.listLaunches({ taskId: retriedId });
    expect(launches).toHaveLength(2);
    const ev = h.store.listEvents({ kind: 'transition', taskId: retriedId }).map((e) => `${e.payload?.['to']}/${e.payload?.['trigger']}`);
    expect(ev).toContain('unstarted/conflict');
    expect(gitIn(h.repo, 'rev-list', '--count', 'main')).toBe('3');
    expect(gitIn(h.repo, 'show', 'main:shared.txt')).toContain(`line from ${retriedId} launch 2`);
  });

  it('cap exhaustion fails the task', async () => {
    h = await makeSlice({ graph: `nodes:\n  - { id: A, deps: [], behavior: "conflictWith:shared.txt" }\n  - { id: B, deps: [], behavior: "conflictWith:shared.txt" }`, realVerifier: true, config: { integrationRetries: 0, maxAttempts: 1 } });
    await h.waitFor(() => ['done', 'blocked'].includes(h!.orch.entry('A').status.kind) && ['done', 'blocked'].includes(h!.orch.entry('B').status.kind), 30_000);
    const blocked = [h.orch.entry('A'), h.orch.entry('B')].find((e) => e.status.kind === 'blocked')!;
    expect(blocked.status).toMatchObject({ kind: 'blocked', reason: { message: expect.stringContaining('integrationCapExceeded') } });
  });

  it('compare-and-swap failure after head movement requeues', async () => {
    h = await makeSlice({ graph: single('commitAndSubmit'), realVerifier: true });
    const backend = new GitVerifierBackend({ repo: h.repo, integrationBranch: 'main', tempRoot: path.join(h.dir, 'v2'), checkCommand: 'true', checkTimeoutMs: 5000 });
    // produce a sealed branch by hand
    const wt = path.join(h.dir, 'wt');
    gitIn(h.repo, 'worktree', 'add', '-q', '-b', 'task/X/l1', wt, 'main');
    writeFileSync(path.join(wt, 'x.txt'), 'x\n');
    gitIn(wt, 'add', '.');
    gitIn(wt, 'commit', '-q', '-m', 'x');
    const sealed = gitIn(wt, 'rev-parse', 'HEAD');
    const base = gitIn(h.repo, 'rev-parse', 'main');
    const job = { jobId: 'J', taskId: 'X', launchId: 'LX', sealedSha: sealed, baseSha: base, status: 'queued' as const, applied: false, createdAt: 0, updatedAt: 0 };
    let moved = false;
    const outcome = await backend.run(job, {
      summary: 'x',
      noChanges: false,
      publishedSince: async () => [],
      progress: (patch) => {
        if (patch.status === 'verified' && !moved) {
          moved = true;
          writeFileSync(path.join(h!.repo, 'other.txt'), 'o\n');
          gitIn(h!.repo, 'add', '.');
          gitIn(h!.repo, 'commit', '-q', '-m', 'someone else');
        }
      },
    });
    expect(outcome).toEqual({ kind: 'requeue' });
    const second = await backend.run(job, { summary: 'x', noChanges: false, publishedSince: async () => [], progress: () => undefined });
    expect(second.kind).toBe('published');
    expect(gitIn(h.repo, 'show', 'main:x.txt')).toBe('x');
    expect(gitIn(h.repo, 'show', 'main:other.txt')).toBe('o');
    expect(await backend.recoverPublishing(job)).toBe('published');
    expect(await backend.recoverPublishing({ ...job, launchId: 'never' })).toBe('requeue');
  });

  it('a branch rebased onto the head after a baseMoved notice verifies to one trailer commit with only its files; changedFiles recorded', async () => {
    h = await makeSlice({ graph: `nodes:\n  - { id: A, deps: [], behavior: commitAndSubmit }\n  - { id: B, deps: [], behavior: "rebaseThenSubmit:20000" }`, realVerifier: true, config: { tickIntervalMs: 100 } });
    await h.waitFor(() => h!.orch.entry('A').status.kind === 'done' && h!.orch.entry('B').status.kind === 'done', 40_000);
    const commits = gitIn(h.repo, 'rev-list', '--first-parent', 'HEAD~2..main').split('\n').filter(Boolean);
    expect(commits).toHaveLength(2);
    const bCommit = commits.find((sha) => gitIn(h!.repo, 'show', '-s', '--format=%(trailers:key=Orchestrator-Task,valueonly)', sha).trim() === 'B')!;
    expect(gitIn(h.repo, 'show', '--name-only', '--format=', bCommit).split('\n').filter(Boolean).sort()).toEqual(['B-after.txt', 'B.txt']);
    const jobs = h.store.listJobs({ status: 'published' });
    expect(jobs.find((j) => j.taskId === 'A')?.changedFiles).toEqual(['A.txt']);
    expect(jobs.find((j) => j.taskId === 'B')?.changedFiles).toEqual(['B-after.txt', 'B.txt']);
    const bLaunch = h.store.listLaunches({ taskId: 'B' })[0]!;
    expect(bLaunch.notices ?? []).toEqual([]); // drained by the agent
    expect(h.store.listEvents({ kind: 'launch.notice', taskId: 'B' })).toMatchObject([{ payload: { kind: 'baseMoved' } }]);
  }, 60_000);

  it('foreign commit sweep flags a manual commit', async () => {
    h = await makeSlice({ graph: single('commitAndSubmit'), realVerifier: true });
    await h.waitFor(() => h!.orch.entry('T1').status.kind === 'done');
    expect(h.orch.status().foreignCommits).toEqual([]);
    writeFileSync(path.join(h.repo, 'manual.txt'), 'm\n');
    gitIn(h.repo, 'add', '.');
    gitIn(h.repo, 'commit', '-q', '-m', 'manual');
    const manual = gitIn(h.repo, 'rev-parse', 'main');
    await h.orch.tick();
    expect(h.orch.status().foreignCommits).toEqual([manual]);
  });

  it('declared no-op publishes nothing; gated milestone tags the pinned sha idempotently', async () => {
    h = await makeSlice({ graph: `nodes:\n  - { id: T1, deps: [], behavior: noopDeclared }\n  - { id: T2, deps: [T1], behavior: commitAndSubmit }\n  - { id: MVP, kind: milestone, gated: true, deps: [T2] }`, realVerifier: true });
    const before = gitIn(h.repo, 'rev-parse', 'main');
    await h.waitFor(() => h!.orch.entry('T1').status.kind === 'done');
    expect(gitIn(h.repo, 'rev-parse', 'main')).toBe(before);
    await h.waitFor(() => h!.orch.entry('MVP').status.kind === 'submitted', 20_000);
    const mvp = h.orch.entry('MVP');
    expect(mvp.integrationSha).toBe(gitIn(h.repo, 'rev-parse', 'main'));
    expect(gitIn(h.repo, 'rev-parse', 'milestone/MVP/v1^{commit}')).toBe(mvp.integrationSha);
    await h.workspace.tagMilestone('MVP', 1, mvp.integrationSha!);
    // A tag at another sha is never moved, and the conflict is returned rather than thrown.
    await expect(h.workspace.tagMilestone('MVP', 1, before)).resolves.toMatchObject({ pushed: false, conflict: { remoteSha: mvp.integrationSha, where: 'clone' } });
    expect(gitIn(h.repo, 'rev-parse', 'milestone/MVP/v1^{commit}')).toBe(mvp.integrationSha);
    expect(h.orch.acceptMilestone('MVP', mvp.integrationSha!, 1)).toEqual({ ok: true });
    expect(h.orch.status().finished).toBe(true);
  });
});

// See specs/integration-pipeline "Prepare command before the check". Every case builds its own backend and leaves the
// config key unset, so the launch-side prepare command never runs.
describe('slice: prepare command in the verifier', () => {
  function fixture(): { dir: string; repo: string } {
    const dir = mkdtempSync(path.join(tmpdir(), 'orch-slice-'));
    return { dir, repo: makeRepo(dir) };
  }
  function backend(dir: string, repo: string, opts: { checkCommand: string; prepareCommand: string; prepareTimeoutMs?: number }): GitVerifierBackend {
    return new GitVerifierBackend({
      repo,
      integrationBranch: 'main',
      tempRoot: path.join(dir, 'run', 'verify'),
      checkCommand: opts.checkCommand,
      checkTimeoutMs: 10_000,
      prepareCommand: opts.prepareCommand,
      ...(opts.prepareTimeoutMs !== undefined ? { prepareTimeoutMs: opts.prepareTimeoutMs } : {}),
      baselineSha: gitIn(repo, 'rev-parse', 'main'),
    });
  }
  function noLaunchPrepare(): void {
    expect(h!.store.listEvents().filter((e) => e.kind.startsWith('launch.prepare'))).toEqual([]);
  }

  it('runs before the check in the temporary worktree, and nothing it installs is published', async () => {
    const { dir, repo } = fixture();
    const verifier = backend(dir, repo, { prepareCommand: 'mkdir -p node_modules && touch node_modules/marker', checkCommand: 'test -f node_modules/marker' });
    h = await makeSlice({ graph: single('commitAndSubmit'), verifier, dir, repo });
    expect(h.config.prepareCommand).toBeUndefined();
    await h.waitFor(() => h!.orch.entry('T1').status.kind === 'done' || h!.store.listJobs({ taskId: 'T1' })[0]?.status === 'failed');
    expect(h.orch.entry('T1').status.kind).toBe('done');
    const job = h.store.listJobs({ taskId: 'T1' })[0]!;
    expect(job.status).toBe('published');
    expect(gitIn(repo, 'rev-parse', 'main')).toBe(job.publishedSha);
    // The repository has no ignore line for node_modules/.
    expect(existsSync(path.join(repo, '.gitignore'))).toBe(false);
    const files = gitIn(repo, 'ls-tree', '-r', '--name-only', 'main').split('\n');
    expect(files).toContain('T1.txt');
    expect(files).not.toContain('node_modules/marker');
    noLaunchPrepare();
  });

  it('a non-zero exit fails the job as checkFailed, spends an attempt, skips the check and reaches the next brief', async () => {
    const { dir, repo } = fixture();
    const outside = path.join(dir, 'check-ran');
    const verifier = backend(dir, repo, { prepareCommand: 'echo NOPE; exit 3', checkCommand: `touch ${outside}` });
    h = await makeSlice({ graph: single('commitAndSubmit'), verifier, dir, repo });
    await h.waitFor(() => h!.orch.entry('T1').attempts >= 1);
    expect(h.orch.entry('T1').attempts).toBe(1);
    const job = h.store.listJobs({ taskId: 'T1' })[0]!;
    expect(job).toMatchObject({ status: 'failed', failureKind: 'checkFailed' });
    const lines = job.output!.split('\n');
    expect(lines[0]).toBe('prepare command exited 3');
    expect(lines.slice(1).some((l) => l.includes('NOPE'))).toBe(true);
    expect(existsSync(outside)).toBe(false);
    await h.waitFor(() => h!.store.listLaunches({ taskId: 'T1' }).length === 2);
    const l2 = h.store.listLaunches({ taskId: 'T1' })[1]!;
    const briefJson = JSON.parse(readFileSync(path.join(l2.worktree, '.orchestrator', 'brief.json'), 'utf8')) as { context?: { verifierOutput?: string } };
    expect(briefJson.context?.verifierOutput).toContain('prepare command exited 3');
    noLaunchPrepare();
  });

  it('a timeout fails the job as checkTimeout and spends the attempt', async () => {
    const { dir, repo } = fixture();
    const verifier = backend(dir, repo, { prepareCommand: 'sleep 30', prepareTimeoutMs: 300, checkCommand: 'true' });
    h = await makeSlice({ graph: single('commitAndSubmit'), verifier, dir, repo, config: { maxAttempts: 1 } });
    await h.waitFor(() => h!.orch.entry('T1').status.kind === 'blocked');
    const job = h.store.listJobs({ taskId: 'T1' })[0]!;
    expect(job).toMatchObject({ status: 'failed', failureKind: 'checkTimeout' });
    expect(job.output!.split('\n')[0]).toBe('prepare command exceeded 300ms');
    noLaunchPrepare();
  });

  it('a command that exits and leaves its output pipe held is a timeout after the bounded wait', async () => {
    const { dir, repo } = fixture();
    const pidFile = path.join(dir, 'holder.pid');
    // The helper starts a sleep in its own session holding stdout, writes its pid and exits 0.
    const script = `const c = require("node:child_process").spawn("sleep", ["30"], { detached: true, stdio: "inherit" }); c.unref(); require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));`;
    const verifier = backend(dir, repo, { prepareCommand: `${process.execPath} -e '${script}'`, prepareTimeoutMs: 1000, checkCommand: 'true' });
    let pid: number | undefined;
    try {
      h = await makeSlice({ graph: single('commitAndSubmit'), verifier, dir, repo, config: { maxAttempts: 1 } });
      await h.waitFor(() => h!.orch.entry('T1').status.kind === 'blocked');
      pid = Number(readFileSync(pidFile, 'utf8'));
      expect(() => process.kill(pid!, 0)).not.toThrow();
      const job = h.store.listJobs({ taskId: 'T1' })[0]!;
      expect(job).toMatchObject({ status: 'failed', failureKind: 'checkTimeout' });
      expect(job.output!.split('\n')[0]).toBe('prepare command exceeded 1000ms');
      noLaunchPrepare();
    } finally {
      if (pid === undefined && existsSync(pidFile)) pid = Number(readFileSync(pidFile, 'utf8'));
      if (pid) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
    }
  });

  it('runs with the check environment', async () => {
    const { dir, repo } = fixture();
    const verifier = backend(dir, repo, { prepareCommand: 'test -z "$ORCH_URL" && test -n "$ORCH_HOME"', checkCommand: 'true' });
    h = await makeSlice({ graph: single('commitAndSubmit'), verifier, dir, repo });
    process.env['ORCH_URL'] = 'http://127.0.0.1:1';
    try {
      await h.waitFor(() => h!.orch.entry('T1').status.kind === 'done' || h!.store.listJobs({ taskId: 'T1' })[0]?.status === 'failed');
      expect(h.store.listJobs({ taskId: 'T1' })[0]).toMatchObject({ status: 'published' });
      expect(h.orch.entry('T1').status.kind).toBe('done');
      noLaunchPrepare();
    } finally {
      delete process.env['ORCH_URL'];
    }
  });

  it('a declared no-op runs no prepare command', async () => {
    const { dir, repo } = fixture();
    const outside = path.join(dir, 'prepare-ran');
    const verifier = backend(dir, repo, { prepareCommand: `touch ${outside}`, checkCommand: 'true' });
    h = await makeSlice({ graph: single('noopDeclared'), verifier, dir, repo });
    await h.waitFor(() => h!.orch.entry('T1').status.kind === 'done');
    expect(h.store.listJobs({ taskId: 'T1' })[0]).toMatchObject({ status: 'published' });
    expect(existsSync(outside)).toBe(false);
    noLaunchPrepare();
  });
});
