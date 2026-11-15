/**
 * Startup recovery, run before the first tick. Idempotent. See specs/crash-recovery.
 */
import { existsSync } from 'node:fs';
import type { Orchestrator } from '../loop/orchestrator.js';
import { applyPendingCascade, recordTagPush, tagSafely } from '../loop/tick.js';
import { scrubCarry } from '../brief/lost.js';
import { startLaunch } from './launch.js';
import type { Launch, VerifierJob } from '../state/store.js';
import { TRAILER_LAUNCH } from '../verify/verifier.js';
import { findTrailer, git } from '../workspace/git.js';
import { GitWorkspace } from '../workspace/git-workspace.js';
import { OriginConfigError } from '../workspace/origin.js';

/** Jobs recovery decides against origin: every unapplied job that has not reached a verdict. */
const UNDECIDED: VerifierJob['status'][] = ['queued', 'checking', 'verified', 'publishing'];

/**
 * With `git.pushIntegration` on, fetch origin once and find each job's launch trailer on origin's integration branch.
 * `off` when pushing is off or origin is not configured (a setting, not an outage: the verifier reports it);
 * `unreachable` when the fetch failed, which decides nothing. See specs/crash-recovery "Origin lookup before commit lost".
 */
async function landedOnOrigin(o: Orchestrator, jobs: readonly VerifierJob[]): Promise<{ kind: 'off' } | { kind: 'unreachable'; error: string } | { kind: 'fetched'; landed: Map<string, string> }> {
  const origin = o.origin;
  if (!origin) return { kind: 'off' };
  const landed = new Map<string, string>();
  if (!jobs.length) return { kind: 'fetched', landed };
  try {
    await origin.fetch();
  } catch (err) {
    if (err instanceof OriginConfigError) return { kind: 'off' };
    return { kind: 'unreachable', error: String(err) };
  }
  if (!(await origin.head())) return { kind: 'fetched', landed };
  for (const job of jobs) {
    const sha = await findTrailer(origin.repo, origin.trackingRef, TRAILER_LAUNCH, job.launchId);
    if (sha) landed.set(job.jobId, sha);
  }
  return { kind: 'fetched', landed };
}

/** A job whose launch trailer is on origin is published at origin's commit, whatever its stored status. */
async function recordLanded(o: Orchestrator, job: VerifierJob, sha: string): Promise<void> {
  // The files the commit changed, for the baseMoved notice sent when the publication is applied.
  const changedFiles = (await git(o.config.repoPath, ['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', sha], { allowFail: true })).stdout.trim().split('\n').filter(Boolean).sort();
  o.store.updateJob(job.jobId, { status: 'published', publishedSha: sha, verifiedSha: job.verifiedSha ?? sha, changedFiles, updatedAt: o.now() });
  o.log.info('recovery: launch trailer found on origin; job published there', { taskId: job.taskId, jobId: job.jobId, from: job.status, publishedSha: sha });
}

/**
 * A queued job whose sealed commit is not in the clone (a fresh clone; launch branches live only in the clone) and
 * whose trailer is not on origin can never be verified: drop it and retry the task, without spending an attempt.
 */
async function dropIfCommitLost(o: Orchestrator, job: VerifierJob): Promise<void> {
  if (!(await commitMissing(o.config.repoPath, job.sealedSha))) return;
  const { store } = o;
  const message = `sealed commit ${job.sealedSha} of launch ${job.launchId} is not in the clone (lost with the previous clone); retried without spending an attempt`;
  store.transaction(() => {
    store.dropJob(job.jobId);
    store.appendEvent({ kind: 'verify.commitLost', taskId: job.taskId, launchId: job.launchId, payload: { jobId: job.jobId, sealedSha: job.sealedSha } }, o.now());
    if (o.entry(job.taskId).status.kind === 'submitted') o.fail(job.taskId, { kind: 'commitLost', message, detail: { sealedSha: job.sealedSha, jobId: job.jobId } }, 'orchestrator', 'commitLost');
  });
  o.log.warn('recovery: sealed commit lost; task retried', { taskId: job.taskId, jobId: job.jobId, sealedSha: job.sealedSha });
}

/**
 * A later pass over jobs recovery deferred because origin could not be fetched. Still unreachable: they stay queued
 * and deferred. Otherwise a trailer on origin publishes the job, a missing sealed commit drops it as `commitLost`, and
 * anything else goes back to the verifier.
 */
export async function decideJobsOnOrigin(o: Orchestrator, jobIds: readonly string[]): Promise<void> {
  const jobs = jobIds.map((id) => o.store.getJob(id)).filter((j): j is VerifierJob => j !== undefined && !j.applied && j.status === 'queued');
  for (const id of jobIds) if (!jobs.some((j) => j.jobId === id)) o.deferredJobs.delete(id);
  const found = await landedOnOrigin(o, jobs);
  if (found.kind === 'unreachable') return;
  for (const job of jobs) {
    o.deferredJobs.delete(job.jobId);
    const sha = found.kind === 'fetched' ? found.landed.get(job.jobId) : undefined;
    if (sha) await recordLanded(o, job, sha);
    else await dropIfCommitLost(o, job);
  }
}

/**
 * True only when the clone definitely lacks the commit: `git cat-file -e` on a full sha exits 1 for a missing object.
 * Any other failure (no repository, a malformed sha) is not a lost commit.
 */
export async function commitMissing(repo: string, sha: string): Promise<boolean> {
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha)) return false;
  // A missing directory surfaces as code 1 from the spawn too: confirm the repository first.
  if ((await git(repo, ['rev-parse', '--git-dir'], { allowFail: true })).code !== 0) return false;
  const r = await git(repo, ['cat-file', '-e', sha], { allowFail: true });
  return r.code === 1 && !r.stderr.trim();
}

export async function recover(o: Orchestrator): Promise<void> {
  if (!o.hasGraph()) return;
  const { store, runner, workspace } = o;

  // A cascade recorded before the crash resumes first; nodes already reset are skipped.
  await applyPendingCascade(o);

  // With origin as the source of truth, a fresh clone (no volume) learns origin's integration head before anything is
  // prepared or checked. Without an origin this reads the clone's head. See specs/crash-recovery "Startup on a fresh clone".
  try {
    await workspace.integrationHead({ awaitFetch: true });
  } catch (err) {
    o.log.warn('recovery: could not read the integration head', { err: String(err) });
  }

  // Before any brief is composed (a relaunch below, a parked launch prepared again): context naming a branch or commit
  // the clone lacks is rewritten, and lost kept work recorded. See specs/crash-recovery "Context naming lost work".
  await scrubLostRefs(o);

  for (const launch of store.listLaunches({ status: ['preparing', 'launching'] })) {
    const entry = o.entry(launch.taskId);
    const owns = entry.lease?.launchId === launch.launchId && entry.status.kind === 'running';
    // Unknown spawn status: revoke, kill by launch id, remove worktree, relaunch same attempt.
    store.updateLaunch(launch.launchId, { status: 'revoked', endedAt: o.now(), endReason: `recovered from ${launch.status}` });
    store.appendEvent({ kind: 'launch.revoked', taskId: launch.taskId, launchId: launch.launchId, payload: { from: launch.status } }, o.now());
    await runner.killByLaunchId(launch.launchId);
    await workspace.remove(launch);
    if (owns) await startLaunch(o, launch.taskId, { sameAttempt: true });
  }

  // Parked launches stay parked; a worktree lost while the daemon was down is prepared again for the same launch.
  for (const launch of store.listLaunches({ status: 'claimable' })) {
    const entry = o.entry(launch.taskId);
    const owns = entry.lease?.launchId === launch.launchId && entry.status.kind === 'running';
    if (!owns) {
      o.endLaunch(launch, 'superseded');
      await workspace.remove(launch);
      continue;
    }
    if (!(await workspace.exists(launch))) {
      await workspace.remove(launch);
      // A base the clone lacks (or any failure to prepare) fails the task at no cost instead of ending the daemon,
      // which would crash-loop on the same durable state. See specs/crash-recovery "Re-preparing a parked launch".
      let error: string | undefined;
      const baseLost = await commitMissing(o.config.repoPath, launch.baseSha);
      if (!baseLost) {
        try {
          await workspace.prepare(launch, o.briefInput(launch));
        } catch (err) {
          error = String(err);
        }
      }
      if (baseLost || error !== undefined) {
        failUnpreparable(o, launch, baseLost, error);
        await workspace.remove(launch).catch(() => undefined);
        continue;
      }
      store.appendEvent({ kind: 'launch.reprepared', taskId: launch.taskId, launchId: launch.launchId, payload: {} }, o.now());
    }
  }

  for (const launch of store.listLaunches({ status: 'live' })) {
    const entry = o.entry(launch.taskId);
    const owns = entry.lease?.launchId === launch.launchId;
    if (!owns || (entry.status.kind !== 'running' && entry.status.kind !== 'waiting')) continue;
    if (launch.worker && launch.pid === undefined) {
      // A claimed launch whose worktree is gone (a fresh clone) cannot be worked: end it and retry now, not at lease expiry.
      if (!(await workspace.exists(launch))) {
        endLostClaim(o, launch);
        await workspace.remove(launch);
        continue;
      }
      // A claimed launch is judged by its lease, never as a dead process, and has no fallback file. One whose lease ran
      // out while the daemon was down is expired as the tick would: kept with progress, failed without.
      // See specs/crash-recovery "Claimed lease expired while the daemon was down".
      if (entry.status.kind === 'running' && entry.lease && entry.lease.expiresAt <= o.now()) {
        const outcome = await o.expireClaim(launch);
        o.log.info('recovery: claimed launch lease expired while the daemon was down', { taskId: launch.taskId, launchId: launch.launchId, outcome });
      }
      continue;
    }
    const liveness = await runner.liveness(launch);
    if (liveness === 'alive') {
      // Adopt, and renew first: an outage longer than the TTL must not fail a surviving agent.
      o.renewLease(launch);
      continue;
    }
    if (liveness === 'unknown') continue; // adopt; the lease bounds its silence
    await o.recordUsage(launch);
    const fb = await workspace.readFallback(launch);
    let runnerFailure: unknown;
    if (fb && entry.status.kind === 'running') {
      await o.sealFallback(launch, fb);
      o.applyFallback(launch, fb);
    } else if (entry.status.kind === 'waiting') {
      o.transition(launch.taskId, { kind: 'blocked', reason: { ...entry.status.question, answer: entry.status.answer } }, 'orchestrator', 'maxWaitOrDead');
      if (entry.status.answer !== undefined) o.unblock(launch.taskId, { answer: entry.status.answer });
    } else {
      // Same path as a death seen by tick: recorded as launch.failed, contended deaths within the allowance uncharged.
      const reason = await o.exitedWithoutReport(launch, 'process gone at recovery');
      runnerFailure = reason.detail?.['runnerFailure'];
      o.failExited(launch, reason, 'deadOrExpired');
    }
    o.endLaunch(launch, 'recovered-dead', runnerFailure ? { runnerFailure } : {});
    if (o.entry(launch.taskId).status.kind !== 'submitted') await workspace.remove(launch);
  }

  // Verifier jobs: in-flight states restart from queued; publishing is resolved by the backend's recovery hook.
  await (o.verifier as { sweepTemp?: () => Promise<void> }).sweepTemp?.();
  // With origin as the source of truth, a launch trailer on origin means published, whatever the job's stored status:
  // a push can land while its record is not yet durable. See specs/crash-recovery "Origin lookup before commit lost".
  const lookup = await landedOnOrigin(o, store.listJobs({ status: UNDECIDED, applied: false }));
  if (lookup.kind === 'fetched') {
    for (const [jobId, sha] of lookup.landed) await recordLanded(o, store.getJob(jobId) as VerifierJob, sha);
  } else if (lookup.kind === 'unreachable') {
    o.log.warn('recovery: origin could not be fetched; undecided verifier jobs stay queued until it answers', { err: lookup.error });
  }
  for (const job of store.listJobs({ status: ['checking', 'verified'] })) {
    store.updateJob(job.jobId, { status: 'queued', updatedAt: o.now() });
  }
  for (const job of store.listJobs({ status: 'publishing' })) {
    // With origin unreachable the backend decides nothing, but still undoes the job's local swap, so no later job
    // pushes the squash as a catch-up. See specs/crash-recovery "Publishing recovery while origin is unreachable".
    const resolved = await (o.verifier as { recoverPublishing?: (j: typeof job, opts?: { originUnreachable?: boolean }) => Promise<'published' | 'requeue'> }).recoverPublishing?.(job, {
      originUnreachable: lookup.kind === 'unreachable',
    });
    if (resolved === 'published') {
      store.updateJob(job.jobId, { status: 'published', publishedSha: job.squashSha, verifiedSha: job.verifiedSha, updatedAt: o.now() });
    } else {
      store.updateJob(job.jobId, { status: 'queued', updatedAt: o.now() });
    }
  }

  // A queued job whose sealed commit is not in the clone and whose trailer is not on origin is lost. An unreachable
  // origin is not an answer: the job stays queued and a later pass decides it. See specs/crash-recovery "Startup on a fresh clone".
  for (const job of store.listJobs({ status: 'queued', applied: false })) {
    if (lookup.kind === 'unreachable') o.deferredJobs.add(job.jobId);
    else await dropIfCommitLost(o, job);
  }

  // Milestone tags: re-create idempotently for submitted gated milestones lacking the marker.
  for (const [id, entry] of o.overlay()) {
    const node = o.graph().nodes.get(id);
    if (!node || node.kind !== 'milestone' || entry.status.kind !== 'submitted') continue;
    if (store.getKv(`tagged:${id}:${entry.reviewVersion}`)) continue;
    if (entry.integrationSha) {
      // Never throws: a tag held at another sha is recorded once as a conflict. See specs/integration-pipeline "Milestone tag conflicts never throw".
      const result = await tagSafely(o, id, entry.reviewVersion, entry.integrationSha);
      store.setKv(`tagged:${id}:${entry.reviewVersion}`, entry.integrationSha);
      if (result) recordTagPush(o, id, entry.reviewVersion, entry.integrationSha, result);
    }
  }

  // Sweep stray worktrees.
  const liveIds = new Set(store.listLaunches({ status: ['preparing', 'claimable', 'launching', 'live'] }).map((l) => l.launchId));
  const registered = new Set(await workspace.listWorktrees());
  for (const id of registered) {
    if (liveIds.has(id)) continue;
    const l = store.getLaunch(id);
    if (l && (await workspace.remove(l)) === false) o.pendingRemovals.add(l.launchId);
  }
  // An ended launch of a done task whose removal was cut short (a crash between publish and removal, a removal that
  // failed) may have left its directory with no registration the sweep above sees: remove it too.
  // See specs/crash-recovery "Worktrees of done tasks removed at startup".
  for (const l of store.listLaunches({ status: ['ended', 'revoked'] })) {
    if (registered.has(l.launchId) || o.entry(l.taskId).status.kind !== 'done') continue;
    if (!existsSync(l.worktree)) continue;
    if ((await workspace.remove(l)) === false) {
      o.pendingRemovals.add(l.launchId);
      o.log.warn('recovery: worktree of a done task left behind; retried on the next tick', { taskId: l.taskId, launchId: l.launchId, worktree: l.worktree });
    }
  }

  // Launches recovery ended above (a lost claim, a parked launch that could not be prepared) were in flight at the first
  // scan; their branches join the lost refs now, so a later revision does not name them.
  await scrubLostRefs(o);
}

/**
 * End a claimed launch whose worktree is gone. A running task is retried at no cost. A waiting task whose answer has
 * arrived is retried with the answer in its brief; one still unanswered stays waiting, and its answer retries it then.
 * See specs/crash-recovery "Waiting claim with a lost worktree".
 */
function endLostClaim(o: Orchestrator, launch: Launch): void {
  const entry = o.entry(launch.taskId);
  const message = `the worktree of claimed launch ${launch.launchId} is gone (a fresh clone); retried without waiting for lease expiry`;
  let outcome = 'retried' as 'retried' | 'retriedWithAnswer' | 'waitingForAnswer';
  o.store.transaction(() => {
    o.endLaunch(launch, 'worktreeLost', { workerId: launch.worker?.id });
    if (entry.status.kind === 'running') {
      o.fail(launch.taskId, { kind: 'worktreeLost', message, detail: { launchId: launch.launchId, workerId: launch.worker?.id } }, 'orchestrator', 'worktreeLost');
    } else if (entry.status.kind === 'waiting' && entry.status.answer !== undefined) {
      const { question, answer } = entry.status;
      o.transition(launch.taskId, { kind: 'blocked', reason: { ...question, answer } }, 'orchestrator', 'maxWaitOrDead');
      o.unblock(launch.taskId, { answer });
      outcome = 'retriedWithAnswer';
    } else if (entry.status.kind === 'waiting') {
      outcome = 'waitingForAnswer';
    }
  });
  o.log.warn(
    outcome === 'waitingForAnswer'
      ? 'recovery: claimed launch lost its worktree; the task keeps waiting, and its answer retries it'
      : 'recovery: claimed launch lost its worktree; task retried',
    { taskId: launch.taskId, launchId: launch.launchId, outcome },
  );
}

/** Fail a parked launch's task at no cost when its worktree cannot be prepared again: its base is not in the clone, or preparing threw. */
function failUnpreparable(o: Orchestrator, launch: Launch, baseLost: boolean, error: string | undefined): void {
  const message = baseLost
    ? `base commit ${launch.baseSha} of parked launch ${launch.launchId} is not in the clone (lost with the previous clone); retried from the current integration head without spending an attempt`
    : `the worktree of parked launch ${launch.launchId} could not be prepared again (${error ?? 'unknown error'}); retried without spending an attempt`;
  const detail = { launchId: launch.launchId, baseSha: launch.baseSha, ...(baseLost ? { baseLost: true } : {}), ...(error !== undefined ? { error } : {}) };
  o.store.transaction(() => {
    o.endLaunch(launch, baseLost ? 'baseLost' : 'prepareFailed', detail);
    o.fail(launch.taskId, { kind: 'worktreeLost', message, detail }, 'orchestrator', 'worktreeLost');
  });
  o.log.warn('recovery: parked launch could not be prepared again; task retried', { taskId: launch.taskId, ...detail });
}

/**
 * Find the launch branches and context commits the clone lacks (a fresh clone: launch branches live only in the clone)
 * and rewrite every stored attempt context that names one, recording each rewrite as `recovery.workLost`. The refs found
 * stay in `o.lostRefs`, so a context composed later (a reopen's revision) does not name them either. Only a git
 * workspace is inspected. See specs/crash-recovery "Context naming lost work".
 */
async function scrubLostRefs(o: Orchestrator): Promise<void> {
  if (!(o.workspace instanceof GitWorkspace)) return;
  const repo = o.workspace.repo;
  const heads = await git(repo, ['for-each-ref', '--format=%(refname)', 'refs/heads'], { allowFail: true });
  if (heads.code !== 0) return;
  const present = new Set(heads.stdout.split('\n').map((l) => l.trim()).filter(Boolean));
  // A launch still in flight gets its branch made again when it is prepared; only an ended launch's branch is lost.
  const inFlight = new Set(o.store.listLaunches({ status: ['preparing', 'claimable', 'launching', 'live'] }).map((l) => l.branch));
  for (const l of o.store.listLaunches({})) {
    if (!inFlight.has(l.branch) && !present.has(`refs/heads/${l.branch}`)) o.lostRefs.add(l.branch);
  }
  const carried = [...o.overlay()].filter(([, e]) => e.carry);
  const shas = new Set<string>();
  for (const [, e] of carried) {
    const c = e.carry!;
    for (const sha of [c.interrupted?.headSha, c.interrupted?.wipCommit, c.revision?.priorPublishedSha]) if (sha) shas.add(sha);
  }
  for (const sha of shas) if (await commitMissing(repo, sha)) o.lostRefs.add(sha);
  if (!o.lostRefs.size) return;
  for (const [id, e] of carried) {
    const { carry, lost } = scrubCarry(e.carry, (ref) => o.lostRefs.has(ref));
    if (!lost) continue;
    o.store.transaction(() => {
      o.store.setEntry(id, { ...o.entry(id), carry, updatedAt: o.now() });
      for (const part of lost) o.store.appendEvent({ kind: 'recovery.workLost', taskId: id, payload: { ...part } }, o.now());
    });
    o.log.warn('recovery: context named work lost with the previous clone; rewritten', { taskId: id, lost });
  }
}
