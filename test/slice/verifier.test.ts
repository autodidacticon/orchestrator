import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { commitTrailers } from '../../src/workspace/git.js';
import { GitVerifierBackend } from '../../src/verify/verifier.js';
import { gitIn, makeSlice, single, type SliceHarness } from './harness.js';

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

  // See specs/integration-pipeline "Check environment".
  it('the check runs with an isolated ORCH_HOME and no client-side daemon variables', async () => {
    h = await makeSlice({ graph: single('commitAndSubmit'), realVerifier: true, config: { checkCommand: 'test "$ORCH_HOME" = "$EXPECTED_HOME" && test -z "$ORCH_URL" && test -z "$ORCH_REPO"' } });
    process.env['EXPECTED_HOME'] = path.join(h.orch.config.dataDir, 'child-home');
    process.env['ORCH_URL'] = 'http://127.0.0.1:1';
    try {
      await h.waitFor(() => h!.orch.entry('T1').status.kind === 'done' || h!.orch.entry('T1').attempts >= 1);
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
    await expect(h.workspace.tagMilestone('MVP', 1, before)).rejects.toThrow(/exists/);
    expect(h.orch.acceptMilestone('MVP', mvp.integrationSha!, 1)).toEqual({ ok: true });
    expect(h.orch.status().finished).toBe(true);
  });
});
