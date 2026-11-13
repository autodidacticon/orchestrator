/**
 * Startup on a fresh clone (ORC-20): with no volume a restarted daemon has a new clone of origin and no worktrees.
 * A claimable launch is prepared again, a claimed launch whose worktree is gone is ended and retried at once, and a
 * queued verifier job whose sealed commit the new clone lacks fails its task with a retryable reason that spends no
 * attempt. Real git: a bare origin, and the clone re-made at the same path. See specs/crash-recovery "Startup on a fresh clone".
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
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
