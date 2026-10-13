/**
 * Startup recovery, run before the first tick. Idempotent. See specs/crash-recovery.
 */
import type { Orchestrator } from '../loop/orchestrator.js';
import { startLaunch } from './launch.js';

export async function recover(o: Orchestrator): Promise<void> {
  if (!o.hasGraph()) return;
  const { store, runner, workspace } = o;

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

  for (const launch of store.listLaunches({ status: 'live' })) {
    const entry = o.entry(launch.taskId);
    const owns = entry.lease?.launchId === launch.launchId;
    if (!owns || (entry.status.kind !== 'running' && entry.status.kind !== 'waiting')) continue;
    const liveness = await runner.liveness(launch);
    if (liveness === 'alive') {
      // Adopt, and renew first: an outage longer than the TTL must not fail a surviving agent.
      o.renewLease(launch);
      continue;
    }
    if (liveness === 'unknown') continue; // adopt; the lease bounds its silence
    await o.recordUsage(launch);
    const fb = await workspace.readFallback(launch);
    if (fb && entry.status.kind === 'running') {
      if (fb.kind === 'submit') {
        const seal = await workspace.seal(launch);
        if (seal.ok) fb.body = { ...fb.body, __sealedSha: seal.sealedSha };
      }
      o.applyFallback(launch, fb);
    } else if (entry.status.kind === 'waiting') {
      o.transition(launch.taskId, { kind: 'blocked', reason: { ...entry.status.question, answer: entry.status.answer } }, 'orchestrator', 'maxWaitOrDead');
      if (entry.status.answer !== undefined) o.unblock(launch.taskId, { answer: entry.status.answer });
    } else {
      o.fail(launch.taskId, { kind: 'exitedWithoutReport', message: 'process gone at recovery' }, 'orchestrator', 'deadOrExpired');
    }
    o.endLaunch(launch, 'recovered-dead');
    if (o.entry(launch.taskId).status.kind !== 'submitted') await workspace.remove(launch);
  }

  // Verifier jobs: in-flight states restart from queued; publishing is resolved by the backend's recovery hook.
  await (o.verifier as { sweepTemp?: () => Promise<void> }).sweepTemp?.();
  for (const job of store.listJobs({ status: ['checking', 'verified'] })) {
    store.updateJob(job.jobId, { status: 'queued', updatedAt: o.now() });
  }
  for (const job of store.listJobs({ status: 'publishing' })) {
    const resolved = await (o.verifier as { recoverPublishing?: (j: typeof job) => Promise<'published' | 'requeue'> }).recoverPublishing?.(job);
    if (resolved === 'published') {
      store.updateJob(job.jobId, { status: 'published', publishedSha: job.squashSha, verifiedSha: job.verifiedSha, updatedAt: o.now() });
    } else {
      store.updateJob(job.jobId, { status: 'queued', updatedAt: o.now() });
    }
  }

  // Milestone tags: re-create idempotently for submitted gated milestones lacking the marker.
  for (const [id, entry] of o.overlay()) {
    const node = o.graph().nodes.get(id);
    if (!node || node.kind !== 'milestone' || entry.status.kind !== 'submitted') continue;
    if (store.getKv(`tagged:${id}:${entry.reviewVersion}`)) continue;
    if (entry.integrationSha) {
      await workspace.tagMilestone(id, entry.reviewVersion, entry.integrationSha);
      store.setKv(`tagged:${id}:${entry.reviewVersion}`, entry.integrationSha);
    }
  }

  // Sweep stray worktrees.
  const liveIds = new Set(store.listLaunches({ status: ['preparing', 'launching', 'live'] }).map((l) => l.launchId));
  for (const id of await workspace.listWorktrees()) {
    if (liveIds.has(id)) continue;
    const l = store.getLaunch(id);
    if (l) await workspace.remove(l);
  }
}
