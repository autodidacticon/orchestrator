/**
 * Startup on a fresh clone (ORC-20): with no volume a restarted daemon has a new clone of origin and no worktrees.
 * A claimable launch is prepared again, a claimed launch whose worktree is gone is ended and retried at once, and a
 * queued verifier job whose sealed commit the new clone lacks fails its task with a retryable reason that spends no
 * attempt. Real git: a bare origin, and the clone re-made at the same path. See specs/crash-recovery "Startup on a fresh clone".
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { commitMissing } from '../../src/launch/recovery.js';
import type { VerifierJob } from '../../src/state/store.js';
import type { VerifierBackend, VerifierOutcome } from '../../src/verify/job.js';
import { gitIn, makeRepo, makeSlice, type SliceHarness } from './harness.js';

let h: SliceHarness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

/** A repository with a bare origin holding its integration branch. */
function withOrigin(): { dir: string; repo: string; origin: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'orch-fresh-'));
  const repo = makeRepo(dir);
  const origin = path.join(dir, 'origin.git');
  gitIn(dir, 'clone', '-q', '--bare', repo, origin);
  gitIn(repo, 'remote', 'add', 'origin', origin);
  gitIn(repo, 'fetch', '-q', 'origin');
  return { dir, repo, origin };
}

/** No volume: the clone is made again from origin at the same path, and the worktrees are gone. */
function freshClone(h: SliceHarness, origin: string): void {
  rmSync(h.repo, { recursive: true, force: true });
  gitIn(path.dirname(h.repo), 'clone', '-q', origin, h.repo);
  rmSync(path.join(h.config.dataDir, 'worktrees'), { recursive: true, force: true });
}

/** Leaves every job queued. */
class RequeueVerifier implements VerifierBackend {
  async run(_job: VerifierJob): Promise<VerifierOutcome> {
    return { kind: 'requeue', reason: 'held by the test' };
  }
}

const pull = { leaseTtlMs: 60_000, runner: { mode: 'pull' as const, claimWindowMs: 60_000 }, health: { stuckAfterMs: 0, stuckFailAfterMs: 0, reportGraceMs: 0, baseMovedNotice: true } };

describe('startup on a fresh clone', () => {
  it('a claimable launch is prepared again for the same launch; a claimed launch without a worktree is ended and retried at no cost', async () => {
    const o = withOrigin();
    const graph = 'nodes:\n  - { id: T1, deps: [], behavior: hang }\n  - { id: T2, deps: [], behavior: hang }\n';
    h = await makeSlice({ graph, dir: o.dir, repo: o.repo, config: { ...pull, git: { pushIntegration: true, originUrl: o.origin, fetchIntervalMs: 0 } } });
    await h.orch.tick();
    const claimed = await h.orch.claim({ workerId: 'w1', taskId: 'T2' });
    expect(claimed.status).toBe(200);
    const t1 = h.store.listLaunches({ taskId: 'T1' })[0]!;
    const t2 = h.store.getLaunch(String(claimed.body['launchId']))!;
    expect(t1.status).toBe('claimable');
    expect(t2).toMatchObject({ status: 'live', worker: { id: 'w1' } });

    freshClone(h, o.origin);
    expect(existsSync(t1.worktree)).toBe(false);
    await h.restart();

    // Parked: the same launch, its worktree prepared again in the new clone.
    expect(h.store.getLaunch(t1.launchId)?.status).toBe('claimable');
    expect(existsSync(path.join(t1.worktree, '.orchestrator', 'brief.json'))).toBe(true);
    expect(h.store.listEvents({ kind: 'launch.reprepared', launchId: t1.launchId })).toHaveLength(1);
    expect(gitIn(h.repo, 'rev-parse', `refs/heads/${t1.branch}`)).toBe(t1.baseSha);

    // Claimed: ended now (not at lease expiry), the attempt not spent, the task back to admission.
    expect(h.store.getLaunch(t2.launchId)).toMatchObject({ status: 'ended', endReason: 'worktreeLost' });
    const e2 = h.orch.entry('T2');
    expect(e2.attempts).toBe(0);
    expect(e2.status.kind).toBe('unstarted');
    expect(h.store.listEvents({ kind: 'transition', taskId: 'T2' }).some((e) => e.payload?.['trigger'] === 'worktreeLost')).toBe(true);
    await h.orch.tick();
    const next = h.store.listLaunches({ taskId: 'T2' }).sort((a, b) => a.launchNo - b.launchNo).at(-1)!;
    expect(next).toMatchObject({ status: 'claimable', launchNo: 2 });
    expect(existsSync(path.join(next.worktree, '.orchestrator', 'brief.json'))).toBe(true);
  }, 60_000);

  it('a queued verifier job whose sealed commit is not in the clone fails its task with a retryable reason naming the commit, without spending an attempt', async () => {
    const o = withOrigin();
    h = await makeSlice({ graph: 'nodes:\n  - { id: T1, deps: [], behavior: commitAndSubmit }\n', dir: o.dir, repo: o.repo, verifier: new RequeueVerifier(), config: { git: { pushIntegration: true, originUrl: o.origin, fetchIntervalMs: 0 } } });
    await h.waitFor(() => h!.orch.entry('T1').status.kind === 'submitted' && h!.store.listJobs({ taskId: 'T1' }).length === 1, 30_000);
    const job = h.store.listJobs({ taskId: 'T1' })[0]!;
    expect(job.status).toBe('queued');
    expect(await commitMissing(h.repo, job.sealedSha)).toBe(false);

    freshClone(h, o.origin);
    expect(await commitMissing(h.repo, job.sealedSha)).toBe(true);
    await h.restart();

    const after = h.store.getJob(job.jobId)!;
    expect(after.applied).toBe(true);
    expect(after.status).toBe('dropped');
    const entry = h.orch.entry('T1');
    expect(entry.attempts).toBe(0);
    expect(entry.status.kind).toBe('unstarted');
    expect(entry.carry?.priorFailure).toMatchObject({ kind: 'commitLost' });
    expect(entry.carry?.priorFailure?.message).toContain(job.sealedSha);
    expect(h.store.listEvents({ kind: 'verify.commitLost', taskId: 'T1' })).toMatchObject([{ payload: { sealedSha: job.sealedSha, jobId: job.jobId } }]);
  }, 60_000);

  it('a waiting claim whose answer arrived is retried with the answer in its brief; an unanswered one keeps waiting and its answer retries it (ORC-91)', async () => {
    const o = withOrigin();
    const graph = 'nodes:\n  - { id: T1, deps: [], behavior: hang }\n  - { id: T2, deps: [], behavior: hang }\n';
    h = await makeSlice({ graph, dir: o.dir, repo: o.repo, config: { ...pull, git: { pushIntegration: true, originUrl: o.origin, fetchIntervalMs: 0 } } });
    await h.orch.tick();
    const launches: Record<string, { launchId: string; token: string }> = {};
    for (const [worker, task] of [['w1', 'T1'], ['w2', 'T2']] as const) {
      const c = await h.orch.claim({ workerId: worker, taskId: task });
      const l = h.store.getLaunch(String(c.body['launchId']))!;
      launches[task] = l;
      // block long-polls for the answer; the restart ends the wait.
      void h.orch.agentCall(l.launchId, l.token, 'block', { seq: 1, kind: 'needsDecision', message: `${task}: which way?` });
    }
    await h.waitFor(() => h!.orch.entry('T1').status.kind === 'waiting' && h!.orch.entry('T2').status.kind === 'waiting');
    expect(h.orch.answer('T1', 'left')).toEqual({ ok: true });
    expect(h.orch.entry('T1').status).toMatchObject({ kind: 'waiting', answer: 'left' });

    freshClone(h, o.origin);
    await h.restart();

    // Answered: retried at no cost, the answer carried into the next brief.
    expect(h.store.getLaunch(launches['T1']!.launchId)).toMatchObject({ status: 'ended', endReason: 'worktreeLost' });
    const e1 = h.orch.entry('T1');
    expect(e1.status.kind).toBe('unstarted');
    expect(e1.attempts).toBe(0);
    expect(e1.carry).toMatchObject({ question: { message: 'T1: which way?' }, answer: 'left' });
    // Unanswered: still waiting for its answer, its launch ended.
    expect(h.store.getLaunch(launches['T2']!.launchId)).toMatchObject({ status: 'ended', endReason: 'worktreeLost' });
    expect(h.orch.entry('T2').status).toMatchObject({ kind: 'waiting', question: { message: 'T2: which way?' } });
    await h.orch.tick();
    expect(h.orch.entry('T2').status.kind).toBe('waiting');

    const next1 = h.store.listLaunches({ taskId: 'T1' }).sort((a, b) => a.launchNo - b.launchNo).at(-1)!;
    expect(next1).toMatchObject({ status: 'claimable', launchNo: 2 });
    const brief1 = readFileSync(path.join(next1.worktree, '.orchestrator', 'brief.md'), 'utf8');
    expect(brief1).toContain('Human answer: left');

    // The answer to the waiting task retries it with the answer.
    expect(h.orch.answer('T2', 'right')).toEqual({ ok: true });
    expect(h.orch.entry('T2')).toMatchObject({ attempts: 0, status: { kind: 'unstarted' }, carry: { answer: 'right' } });
    await h.orch.tick();
    const next2 = h.store.listLaunches({ taskId: 'T2' }).sort((a, b) => a.launchNo - b.launchNo).at(-1)!;
    expect(next2).toMatchObject({ status: 'claimable', launchNo: 2 });
    expect(readFileSync(path.join(next2.worktree, '.orchestrator', 'brief.md'), 'utf8')).toContain('Human answer: right');
  }, 60_000);

  it.each([
    { relaunch: 'parked' as const, journal: false },
    // A journaled store (as under Postgres) gates the workspace behind a proxy; a relaunch caught in `preparing` is briefed by recovery's own relaunch.
    { relaunch: 'preparing' as const, journal: true },
  ])('kept work on a branch the fresh clone lacks is recorded as an event, and no brief names that branch or its commit (ORC-91; relaunch $relaunch, journal $journal)', async ({ relaunch, journal }) => {
    const o = withOrigin();
    h = await makeSlice({ graph: 'nodes:\n  - { id: T1, deps: [], behavior: hang }\n', dir: o.dir, repo: o.repo, ...(journal ? { journal: {} } : {}), config: { ...pull, git: { pushIntegration: true, originUrl: o.origin, fetchIntervalMs: 0 } } });
    await h.orch.tick();
    const c = await h.orch.claim({ workerId: 'w1', taskId: 'T1' });
    const first = h.store.getLaunch(String(c.body['launchId']))!;
    writeFileSync(path.join(first.worktree, 'work.txt'), 'progress\n');
    gitIn(first.worktree, 'add', 'work.txt');
    gitIn(first.worktree, 'commit', '-q', '-m', 'progress');
    const head = gitIn(first.worktree, 'rev-parse', 'HEAD');
    expect((await h.orch.release(first.launchId, 'session ending', { keep: true })).status).toBe(200);
    expect(h.orch.entry('T1').carry?.interrupted).toMatchObject({ priorBranch: first.branch, headSha: head });
    // The relaunch is parked with the context still on the entry; its brief names the kept branch.
    await h.orch.tick();
    const second = h.store.listLaunches({ taskId: 'T1', status: 'claimable' })[0]!;
    expect(readFileSync(path.join(second.worktree, '.orchestrator', 'brief.md'), 'utf8')).toContain(first.branch);
    if (relaunch === 'preparing') h.store.updateLaunch(second.launchId, { status: 'preparing' });
    await h.store.durable();

    freshClone(h, o.origin);
    await h.restart();

    expect(h.store.listEvents({ kind: 'recovery.workLost', taskId: 'T1' })).toMatchObject([
      { payload: { field: 'interrupted', priorLaunchId: first.launchId, priorBranch: first.branch, headSha: head, reason: 'session ending' } },
    ]);
    const carry = h.orch.entry('T1').carry;
    expect(carry?.interrupted).toBeUndefined();
    expect(carry?.lostWork).toEqual({ priorLaunchId: first.launchId, reason: 'session ending' });
    // Parked: the same launch is briefed again. Preparing: recovery revokes it and relaunches the same attempt. Either
    // way the brief names neither the lost branch nor its commit.
    let briefed = second;
    if (relaunch === 'parked') {
      expect(h.store.getLaunch(second.launchId)?.status).toBe('claimable');
    } else {
      expect(h.store.getLaunch(second.launchId)?.status).toBe('revoked');
      briefed = h.store.listLaunches({ taskId: 'T1', status: 'claimable' })[0]!;
      expect(briefed.launchNo).toBe(3);
    }
    const md = readFileSync(path.join(briefed.worktree, '.orchestrator', 'brief.md'), 'utf8');
    const json = readFileSync(path.join(briefed.worktree, '.orchestrator', 'brief.json'), 'utf8');
    for (const text of [md, json]) {
      expect(text).not.toContain(first.branch);
      expect(text).not.toContain(head);
    }
    expect(md).toContain(`Your previous launch \`${first.launchId}\` was interrupted (session ending)`);
    expect(md).toContain('lost with the orchestrator\'s previous clone');
    expect(h.orch.lostRefs.has(first.branch)).toBe(true);
  }, 60_000);

  it('a parked launch whose base commit the clone lacks fails its task with a retryable reason, and the daemon keeps running (ORC-91)', async () => {
    const o = withOrigin();
    const graph = 'nodes:\n  - { id: T1, deps: [], behavior: hang }\n  - { id: T2, deps: [], behavior: hang }\n';
    h = await makeSlice({ graph, dir: o.dir, repo: o.repo, config: { ...pull, git: { pushIntegration: true, originUrl: o.origin, fetchIntervalMs: 0 } } });
    await h.orch.tick();
    const t1 = h.store.listLaunches({ taskId: 'T1', status: 'claimable' })[0]!;
    const t2 = h.store.listLaunches({ taskId: 'T2', status: 'claimable' })[0]!;
    // T1: a base commit made only in the old clone. T2: a base that names an object which is not a commit, so preparing throws.
    const lostBase = '1'.repeat(40);
    h.store.updateLaunch(t1.launchId, { baseSha: lostBase });
    h.store.updateLaunch(t2.launchId, { baseSha: gitIn(h.repo, 'rev-parse', 'HEAD^{tree}') });

    freshClone(h, o.origin);
    await h.restart();

    expect(h.store.getLaunch(t1.launchId)).toMatchObject({ status: 'ended', endReason: 'baseLost' });
    const e1 = h.orch.entry('T1');
    expect(e1).toMatchObject({ attempts: 0, status: { kind: 'unstarted' } });
    expect(e1.carry?.priorFailure).toMatchObject({ kind: 'worktreeLost', detail: { baseSha: lostBase, baseLost: true } });
    expect(e1.carry?.priorFailure?.message).toContain(lostBase);
    expect(h.store.getLaunch(t2.launchId)).toMatchObject({ status: 'ended', endReason: 'prepareFailed' });
    expect(h.orch.entry('T2')).toMatchObject({ attempts: 0, status: { kind: 'unstarted' }, carry: { priorFailure: { kind: 'worktreeLost' } } });

    // Both are admitted again from the clone's integration head.
    await h.orch.tick();
    const head = gitIn(h.repo, 'rev-parse', 'main');
    for (const task of ['T1', 'T2']) {
      const next = h.store.listLaunches({ taskId: task, status: 'claimable' })[0]!;
      expect(next).toMatchObject({ launchNo: 2, baseSha: head });
      expect(existsSync(path.join(next.worktree, '.orchestrator', 'brief.json'))).toBe(true);
    }
  }, 60_000);

  it('only a definitely missing object counts as lost', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'orch-fresh-'));
    try {
      const repo = makeRepo(dir);
      const head = gitIn(repo, 'rev-parse', 'HEAD');
      expect(await commitMissing(repo, head)).toBe(false);
      expect(await commitMissing(repo, '1'.repeat(40))).toBe(true);
      expect(await commitMissing(repo, 'x')).toBe(false);
      expect(await commitMissing(path.join(dir, 'not-a-repo'), '1'.repeat(40))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
