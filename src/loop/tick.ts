/**
 * The five tick phases, in the order the stall property depends on:
 *   1 reconcile leases and launches
 *   2 drain verification
 *   3 complete due milestones to a fixed point
 *   4 admit resumables, then validate briefs and launch
 *   5 evaluate
 */
import { existsSync } from 'node:fs';
import { crashPoint } from '../crash.js';
import * as q from '../graph/query.js';
import { spawnLaunch, startLaunch } from '../launch/launch.js';
import { prepareRetryDue, settlePrepareJobs, spawnPreparedLaunches } from '../launch/prepare.js';
import type { Id } from '../graph/model.js';
import type { AttemptContext, Entry, FailedKind } from '../state/status.js';
import type { Launch, VerifierJob } from '../state/store.js';
import type { TagPushResult } from '../workspace/workspace.js';
import type { Orchestrator } from './orchestrator.js';
import { admit } from './schedule.js';
import { clearPushRetry, PUSH_REFUSED } from '../verify/push-retry.js';
import { expireVerifyLeases } from '../verify/claims.js';
import { ceilingUsd, checkTimeBudget, runCostUsd } from '../health/budgets.js';
import { observeFingerprint, recordSignal } from '../health/progress.js';
import { checkStuck } from '../health/stuck.js';

export async function runTick(o: Orchestrator): Promise<void> {
  // A gap noted since the last tick is written first. See specs/health-monitoring "Gap in the daemon's clock".
  o.noteClock();
  o.recordGaps();
  await o.loadGraph();
  if (!o.hasGraph()) return;

  await reconcile(o);
  // Outcomes of prepare commands are applied here, never by their callbacks. See specs/pull-runner "Prepare command".
  await settlePrepareJobs(o);
  crashPoint('tick.afterPhase1');

  await drainVerification(o);
  crashPoint('tick.afterPhase2');

  await completeMilestones(o);
  await pushMilestoneTags(o);
  crashPoint('tick.afterPhase3');

  await admitAndLaunch(o);
  crashPoint('tick.afterPhase4');

  await o.sweepForeignCommits();
  evaluate(o);
  crashPoint('tick.afterPhase5');
}

/**
 * Apply a recorded cascade plan, dependents first, one transaction per node.
 * Idempotent: nodes already reset are skipped; a publishing node is deferred.
 * See specs/task-lifecycle "Cascade reopen" and specs/crash-recovery "Cascade is resumable".
 */
export async function applyPendingCascade(o: Orchestrator): Promise<void> {
  const pending = o.pendingCascade();
  if (!pending) return;
  let deferred = false;
  for (const step of pending.plan) {
    const node = o.graph().nodes.get(step.id);
    if (!node) continue;
    const entry = o.entry(step.id);
    const kind = entry.status.kind;
    if (node.kind === 'milestone') {
      if (kind === 'done' || kind === 'submitted') o.resetMilestone(step.id, 'upstreamReopened', pending.target);
      continue;
    }
    const isTarget = step.id === pending.target;
    if (kind === 'unstarted' || kind === 'failed' || kind === 'blocked') continue;
    if (kind === 'cancelled' && !isTarget) continue;
    if (kind === 'submitted' && o.store.listJobs({ taskId: step.id, status: 'publishing' }).length) {
      deferred = true;
      continue;
    }
    const live = o.store.listLaunches({ taskId: step.id, status: ['live', 'claimable'] }).filter((l) => entry.lease?.launchId === l.launchId);
    for (const l of live) {
      await o.runner.reap(l);
      await o.recordUsage(l);
    }
    o.store.transaction(() => {
      for (const j of o.store.listJobs({ taskId: step.id, status: ['queued', 'checking', 'verified'] })) o.store.dropJob(j.jobId);
      for (const l of live) o.endLaunch(l, 'cascade');
      const revision = o.revisionContext(step.id, isTarget ? 'reopened' : 'upstreamReopened', isTarget ? undefined : pending.target);
      const trigger = isTarget ? (kind === 'cancelled' ? 'uncancel' : 'reopen') : 'cascade';
      o.transition(step.id, { kind: 'unstarted' }, 'human', trigger, { carry: revision ? { revision } : undefined, accepted: undefined, integrationSha: undefined }, { cascade: pending.target });
    });
    for (const l of live) await o.workspace.remove(l);
  }
  if (!deferred) o.clearPendingCascade();
}

/** Phase 1. */
export async function reconcile(o: Orchestrator): Promise<void> {
  await applyPendingCascade(o);
  // Sessions that died or ended hand their claimed launches back with keep. See specs/operator-control "Session attachments".
  await o.sweepAttachments();
  // A sleep during the awaits above is written, and the leases renewed, before any lease is tested against this clock.
  // See specs/pull-runner "Lease renewal after a gap".
  o.noteClock();
  o.recordGaps();
  const now = o.now();
  for (const launch of o.store.listLaunches({ status: 'live' })) {
    const entry = o.entry(launch.taskId);
    const owns = entry.lease?.launchId === launch.launchId;
    const active = owns && (entry.status.kind === 'running' || entry.status.kind === 'waiting');

    if (entry.status.kind === 'cancelled' || (!active && !owns)) {
      // A submitted task's process writes its usage only when it exits: leave it for the report grace. See specs/health-monitoring "Usage accounting".
      const reported = entry.status.kind === 'submitted' || entry.status.kind === 'done';
      if (reported && launch.reportedAt !== undefined && now - launch.reportedAt < o.config.health.reportGraceMs && (await o.runner.alive(launch))) continue;
      // Cancelled, or superseded: reap and end.
      if (await o.runner.alive(launch)) await o.runner.reap(launch);
      await o.recordUsage(launch);
      o.endLaunch(launch, entry.status.kind === 'cancelled' ? 'cancelled' : entry.status.kind === 'submitted' || entry.status.kind === 'done' ? 'reported' : 'superseded');
      await o.workspace.remove(launch);
      continue;
    }

    if (launch.worker && launch.pid === undefined) {
      // A claimed launch has no process: its lease is the only bound on silence, renewed by API calls and worktree progress. See specs/task-lifecycle "Claimable launches".
      if (!active) continue;
      const observed = entry.status.kind === 'running' ? await observeFingerprint(o, launch) : launch;
      if (observed.progressAt !== launch.progressAt) o.renewLease(launch);
      if (entry.status.kind === 'running') {
        if (await checkTimeBudget(o, observed)) continue;
        if (await checkStuck(o, observed)) continue;
      }
      const cur = o.entry(launch.taskId);
      // Expiry with progress in the worktree is a kept release; without it, a failed attempt. See specs/pull-runner "Lease expiry".
      if (cur.status.kind === 'running' && cur.lease?.launchId === launch.launchId && cur.lease.expiresAt <= now) await o.expireClaim(launch);
      continue;
    }

    const liveness = await o.runner.liveness(launch);
    if (liveness === 'dead') {
      await handleDeadLaunch(o, launch, entry);
      continue;
    }
    if (!active) {
      // Task left running/waiting (submitted/done/failed/blocked) while the process lingers; nothing to do.
      continue;
    }
    if (liveness === 'alive') {
      // An observed process keeps its lease; silence is a health matter, not a failure. See specs/health-monitoring.
      o.renewLease(launch);
      if (entry.status.kind === 'running') {
        const observed = await observeFingerprint(o, launch);
        if (await checkTimeBudget(o, observed)) continue;
        await checkStuck(o, observed);
      }
      continue;
    }
    // Unknown liveness: the lease TTL is the only bound on silence.
    if (entry.status.kind === 'running' && entry.lease && entry.lease.expiresAt <= now) {
      await o.runner.reap(launch);
      await o.recordUsage(launch);
      o.fail(launch.taskId, { kind: 'leaseExpired', message: `no contact for ${o.config.leaseTtlMs}ms` }, 'orchestrator', 'deadOrExpired');
      o.endLaunch(launch, 'leaseExpired');
      await o.workspace.remove(launch);
      continue;
    }
  }

  // Parked launches whose task was cancelled or superseded are ended and their worktrees removed.
  for (const launch of o.store.listLaunches({ status: 'claimable' })) {
    const entry = o.entry(launch.taskId);
    const owns = entry.lease?.launchId === launch.launchId && entry.status.kind === 'running';
    if (owns) continue;
    o.endLaunch(launch, entry.status.kind === 'cancelled' ? 'cancelled' : 'superseded');
    await o.workspace.remove(launch);
  }

  // maxWait: waiting tasks past the limit degrade to blocked, question preserved.
  for (const [id, entry] of o.overlay()) {
    if (entry.status.kind !== 'waiting') continue;
    if (entry.status.askedAt + o.config.maxWaitMs > now) continue;
    const { question, answer } = entry.status;
    o.transition(id, { kind: 'blocked', reason: { ...question, answer } }, 'orchestrator', 'maxWaitOrDead');
    if (entry.lease) o.resolveWaiters(entry.lease.launchId, { status: 200, body: { timeout: true, reason: 'maxWait' } });
    if (answer !== undefined) {
      // The answer arrived but admission never happened in time: carry it into a cold retry.
      o.unblock(id, { answer });
    }
  }
}

async function handleDeadLaunch(o: Orchestrator, launch: Launch, entry: Entry): Promise<void> {
  await o.recordUsage(launch);
  const fb = await o.workspace.readFallback(launch);
  if (fb && entry.status.kind === 'running') {
    await o.sealFallback(launch, fb);
    o.applyFallback(launch, fb);
  } else if (entry.status.kind === 'waiting') {
    o.transition(launch.taskId, { kind: 'blocked', reason: { ...entry.status.question, answer: entry.status.answer } }, 'orchestrator', 'maxWaitOrDead');
    if (entry.status.answer !== undefined) o.unblock(launch.taskId, { answer: entry.status.answer });
  }
  let runnerFailure: unknown;
  if (!fb && entry.status.kind === 'running') {
    // The runner's diagnosis goes into the failure (and so the next brief) and the launch.ended event.
    const reason = await o.exitedWithoutReport(launch, 'process exited without a report');
    runnerFailure = reason.detail?.['runnerFailure'];
    o.failExited(launch, reason, 'deadOrExpired');
  }
  o.endLaunch(launch, fb ? `fallback:${fb.kind}` : 'exited', runnerFailure ? { runnerFailure } : {});
  const after = o.entry(launch.taskId);
  if (after.status.kind !== 'submitted') await o.workspace.remove(launch);
}

/**
 * Phase 2: apply terminal job results, remove the worktrees of their launches (awaited, retried on later ticks while
 * left behind), then start the worker if idle. See specs/integration-pipeline "Worktree removal on publish".
 */
export async function drainVerification(o: Orchestrator): Promise<void> {
  try {
    expireVerifyLeases(o);
    await retryPendingRemovals(o);
    await applyJobs(o);
  } finally {
    o.startVerifierIfIdle();
  }
}

async function applyJobs(o: Orchestrator): Promise<void> {
  for (const job of o.store.listJobs({ applied: false })) {
    if (job.status === 'queued' || job.status === 'checking' || job.status === 'verified' || job.status === 'publishing') continue;
    const entry = o.entry(job.taskId);
    o.store.transaction(() => {
      if (entry.status.kind === 'submitted') {
        if (job.status === 'published') {
          const summary = String(o.store.getCompletionReport(job.taskId)?.body['summary'] ?? '');
          o.transition(job.taskId, { kind: 'done' }, 'verifier', 'published', { carry: undefined }, { publishedSha: job.publishedSha, summary });
          if (o.config.health.baseMovedNotice && job.publishedSha && job.publishedSha !== job.expectedHead) notifyBaseMoved(o, job);
        } else if (job.status === 'conflict') {
          if (entry.integrationRetries < o.config.integrationRetries) {
            const launch = o.store.getLaunch(job.launchId);
            const carry: AttemptContext = {
              ...(entry.carry ?? {}),
              conflict: { files: job.conflictFiles ?? [], since: job.conflictSince ?? [], previousBranch: launch?.branch ?? '' },
            };
            o.transition(job.taskId, { kind: 'unstarted' }, 'verifier', 'conflict', { carry });
          } else {
            o.fail(job.taskId, { kind: 'integrationCapExceeded', message: `conflicted ${entry.integrationRetries + 1} times`, detail: { files: job.conflictFiles } }, 'verifier', 'verificationFailed');
          }
        } else if (job.status === 'failed' && job.failureKind === PUSH_REFUSED) {
          // Origin refused the push git.pushRefusalLimit times: block with origin's text; no attempt is spent.
          const message = job.output ?? 'origin refused the publication push';
          o.transition(job.taskId, { kind: 'blocked', reason: { kind: 'pushRefused', message } }, 'verifier', 'pushRefused', undefined, { jobId: job.jobId });
        } else if (job.status === 'failed') {
          o.fail(job.taskId, { kind: (job.failureKind as FailedKind | undefined) ?? 'checkFailed', message: job.failureKind, output: job.output }, 'verifier', 'verificationFailed');
        }
      }
      o.store.updateJob(job.jobId, { applied: true, updatedAt: o.now() });
      // The job is over: its push retry state goes with it. See specs/integration-pipeline "Push retry state ends with its job".
      clearPushRetry(o.store, job.jobId);
    });
    const launch = o.store.getLaunch(job.launchId);
    // A live launch's agent has nothing more to do; its process exits on its own and reconcile ends the launch. It may
    // still be in the worktree, so it gets one attempt now and the rest on later ticks.
    if (launch) await removeOrRetryLater(o, launch, launch.status === 'live' ? { attempts: 1 } : {});
    // A done task's other ended launches (one relaunched while the task was submitted, say) keep no worktree either.
    if (o.entry(job.taskId).status.kind === 'done') {
      for (const other of o.store.listLaunches({ taskId: job.taskId, status: ['ended', 'revoked'] })) {
        if (other.launchId === job.launchId) continue;
        if (existsSync(other.worktree) || (await o.workspace.exists(other))) await removeOrRetryLater(o, other);
      }
    }
  }
}

/** Remove a launch's worktree, awaited; one left behind joins the pending set and is retried on the next tick. */
export async function removeOrRetryLater(o: Orchestrator, launch: Launch, opts: { attempts?: number } = {}): Promise<void> {
  let gone: boolean | void;
  try {
    gone = await o.workspace.remove(launch, opts);
  } catch (err) {
    o.log.warn('worktree removal failed; retried on the next tick', { taskId: launch.taskId, launchId: launch.launchId, err: String(err) });
    gone = false;
  }
  if (gone === false) {
    if (!o.pendingRemovals.has(launch.launchId)) o.log.warn('worktree left behind after removal; retried on the next tick', { taskId: launch.taskId, launchId: launch.launchId, worktree: launch.worktree });
    o.pendingRemovals.add(launch.launchId);
  } else {
    o.pendingRemovals.delete(launch.launchId);
  }
}

async function retryPendingRemovals(o: Orchestrator): Promise<void> {
  for (const launchId of [...o.pendingRemovals]) {
    const launch = o.store.getLaunch(launchId);
    // A launch that is live again or parked owns its worktree; anything else (ended, revoked, gone) is retried.
    if (!launch || launch.status === 'claimable' || launch.status === 'preparing' || launch.status === 'launching') {
      o.pendingRemovals.delete(launchId);
      continue;
    }
    await removeOrRetryLater(o, launch, launch.status === 'live' ? { attempts: 1 } : {});
  }
}

/** Tell every other live launch that the integration head moved. Runs inside the publish transaction. */
function notifyBaseMoved(o: Orchestrator, job: VerifierJob): void {
  for (const other of o.store.listLaunches({ status: 'live' })) {
    if (other.launchId === job.launchId || other.taskId === job.taskId) continue;
    const kind = o.entry(other.taskId).status.kind;
    if (kind !== 'running' && kind !== 'waiting') continue;
    o.queueNotice(other.launchId, { kind: 'baseMoved', head: job.publishedSha, files: job.changedFiles ?? [], task: job.taskId });
  }
}

/** Phase 3. */
export async function completeMilestones(o: Orchestrator): Promise<void> {
  const g = o.graph();
  const head = await o.workspace.integrationHead();
  const { completions } = q.milestoneFixedPoint(g, o.overlay(), { integrationHead: head, now: o.now() });
  for (const c of completions) {
    if (c.outcome === 'done') {
      o.transition(c.id, { kind: 'done' }, 'orchestrator', 'milestoneAuto');
    } else {
      const sha = c.integrationSha ?? head;
      const baseline = o.store.getKv('baselineHead') ?? '';
      let diffStat = '';
      if (baseline) {
        try {
          diffStat = await o.workspace.diffStat(baseline, sha);
        } catch {
          diffStat = '';
        }
      }
      const closure = [...q.closure(g, c.id)]
        .filter((t) => g.nodes.get(t)?.kind === 'task')
        .map((t) => ({
          taskId: t,
          publishedSha: o.store.listJobs({ taskId: t, status: 'published' }).at(-1)?.publishedSha,
          summary: String(o.store.getCompletionReport(t)?.body['summary'] ?? ''),
        }));
      const entry = o.transition(c.id, { kind: 'submitted' }, 'orchestrator', 'milestoneGated', { integrationSha: c.integrationSha }, { integrationSha: sha, diffStat, closure });
      const result = await tagSafely(o, c.id, entry.reviewVersion, c.integrationSha ?? head);
      crashPoint('milestone.afterTag');
      o.store.setKv(`tagged:${c.id}:${entry.reviewVersion}`, c.integrationSha ?? head);
      recordTag(o, c.id, entry.reviewVersion, c.integrationSha ?? head, result);
      o.store.appendEvent({ kind: 'milestone.tagged', taskId: c.id, payload: { version: entry.reviewVersion, sha: c.integrationSha } }, o.now());
    }
  }
}

/**
 * Phase 3: every gated milestone that is submitted or accepted has its pinned tag. With `git.pushIntegration` on, the
 * tag is on origin: a push that fails is retried on the next tick. With it off, the tag is in the clone: a tag that
 * could not be created is created on a later tick, and one created is recorded under `tagLocal:<id>:<version>`. Either
 * way a tag held at another sha is never moved and is reported once as `milestone.tagConflict`.
 * See specs/integration-pipeline "Milestone tagging" and "A failed local tag is retried".
 */
export async function pushMilestoneTags(o: Orchestrator): Promise<void> {
  const pushing = o.config.git.pushIntegration;
  for (const [id, entry] of o.overlay()) {
    const node = o.graph().nodes.get(id);
    if (!node || node.kind !== 'milestone' || !node.gated) continue;
    if (entry.status.kind !== 'submitted' && entry.status.kind !== 'done') continue;
    const sha = entry.integrationSha;
    if (!sha || entry.reviewVersion < 1) continue;
    // Pushed, or a conflict already reported: nothing more to do in either mode.
    if (o.store.getKv(`tagPushed:${id}:${entry.reviewVersion}`)) continue;
    if (!pushing && o.store.getKv(`tagLocal:${id}:${entry.reviewVersion}`)) continue;
    const result = await tagSafely(o, id, entry.reviewVersion, sha);
    if (pushing || !result) {
      if (!o.store.getKv(`tagged:${id}:${entry.reviewVersion}`)) {
        o.store.setKv(`tagged:${id}:${entry.reviewVersion}`, sha);
        o.store.appendEvent({ kind: 'milestone.tagged', taskId: id, payload: { version: entry.reviewVersion, sha } }, o.now());
      }
    }
    recordTag(o, id, entry.reviewVersion, sha, result);
  }
}

/**
 * Record what tagging a milestone did. No result means the workspace tagged in the clone and has no origin: the local
 * tag is recorded, so the pass that retries failed local tags leaves it alone.
 */
export function recordTag(o: Orchestrator, id: Id, version: number, sha: string, result: TagPushResult | void): void {
  if (result) recordTagPush(o, id, version, sha, result);
  else o.store.setKv(`tagLocal:${id}:${version}`, sha);
}

/** Tag a milestone; a workspace that throws anyway is a failed push, retried on a later tick, never a failed tick. */
export async function tagSafely(o: Orchestrator, id: Id, version: number, sha: string): Promise<TagPushResult | void> {
  try {
    return await o.workspace.tagMilestone(id, version, sha);
  } catch (err) {
    return { pushed: false, error: String(err) };
  }
}

/**
 * Record a tag outcome: landed, a conflict (in the clone or on origin) reported once and never retried, or a failure
 * left for the next tick. See specs/integration-pipeline "Milestone tag conflicts never throw".
 */
export function recordTagPush(o: Orchestrator, id: Id, version: number, sha: string, result: TagPushResult): void {
  const key = `tagPushed:${id}:${version}`;
  if (result.pushed) {
    o.store.setKv(key, sha);
  } else if (result.conflict) {
    if (o.store.getKv(key)?.startsWith('conflict:')) return;
    const where = result.conflict.where ?? 'origin';
    o.store.setKv(key, `conflict:${result.conflict.remoteSha}`);
    o.store.appendEvent({ kind: 'milestone.tagConflict', taskId: id, payload: { version, sha, remoteSha: result.conflict.remoteSha, where } }, o.now());
    o.log.error(`milestone tag exists in the ${where === 'clone' ? 'clone' : 'origin'} at another sha; not moved`, { milestone: id, version, sha, remoteSha: result.conflict.remoteSha, where });
  } else {
    o.log.warn('milestone tag or its push failed; retried on a later tick', { milestone: id, version, err: result.error });
  }
}

/** Phase 4. */
export async function admitAndLaunch(o: Orchestrator): Promise<void> {
  if (!o.isPaused()) {
    const ceiling = ceilingUsd(o.config, o.store);
    if (ceiling !== undefined) {
      const cost = runCostUsd(o.store);
      if (cost >= ceiling) o.pauseForBudget(cost, ceiling);
    }
  }
  if (o.isPaused()) {
    o.setDeferred([]);
    return;
  }
  // Nothing starts during the hold after a gap; each start below tests it again, so a sleep in the pass stops the rest.
  // See specs/health-monitoring "Hold after a gap".
  if (o.inHold()) return;
  await spawnDueLaunches(o);
  const g = o.graph();
  const overlay = o.overlay();
  let running = 0;
  let waiting = 0;
  const resumables: Id[] = [];
  // Tasks holding their scope: running, waiting, or submitted, plus any with a claimable launch. See specs/scheduling-policy "Scope filter at admission".
  const held = new Set<Id>();
  for (const [id, node] of g.nodes) {
    const e = overlay.get(id);
    if (!e) continue;
    if (e.status.kind === 'running') running++;
    if (e.status.kind === 'waiting') {
      waiting++;
      if (e.status.answer !== undefined) resumables.push(id);
    }
    if (node.kind === 'task' && (e.status.kind === 'running' || e.status.kind === 'waiting' || e.status.kind === 'submitted')) held.add(id);
  }
  for (const l of o.store.listLaunches({ status: 'claimable' })) held.add(l.taskId);
  // A task whose model or effort would come from a built-in default under the profile hold is not a candidate:
  // it takes no capacity and defers nothing. See specs/model-selection "Profile hold at admission".
  const profileCtx = { hold: o.confirmProfile(), mode: o.effectiveMode() };
  // A task waiting out a prepare retry is not a candidate either: it takes no slot until its retryAt. See specs/pull-runner "Prepare failure limit".
  const retryNow = o.now();
  const candidates = q
    .ready(g, overlay)
    .filter((id) => !o.hasHeldProfile(id, profileCtx))
    .filter((id) => o.config.prepareCommand === undefined || prepareRetryDue(o.store, id, retryNow));
  const admission = admit(resumables, candidates, {
    graph: g,
    overlay,
    // Capacity is read at each admission pass so an override applies on the next tick. See specs/toolchain-discovery "Runtime overrides and start-only keys".
    capacity: o.effective().config.capacity,
    maxWaiting: o.config.maxWaiting,
    runningCount: running,
    waitingCount: waiting,
    held: [...held],
  }, o.policy);
  o.setDeferred(admission.deferred);

  for (const id of admission.resumes) {
    if (o.inHold()) return;
    const e = o.entry(id);
    if (e.status.kind !== 'waiting' || e.status.answer === undefined || !e.lease) continue;
    const { seq, answer } = e.status;
    const launchId = e.lease.launchId;
    o.store.transaction(() => {
      o.transition(id, { kind: 'running' }, 'orchestrator', 'resumed', { lease: e.lease });
      const l = o.store.getLaunch(launchId);
      const now = o.now();
      // The wait is counted in awake time, as the elapsed time it is taken from. See specs/health-monitoring "Launch time budget".
      const waited = l?.waitingSince !== undefined ? o.awakeMs(l.waitingSince, now) : 0;
      o.store.updateLaunch(launchId, { pendingAnswer: { seq, answer }, waitedMs: (l?.waitedMs ?? 0) + waited, waitingSince: undefined });
      if (l) recordSignal(o, { ...l, waitedMs: (l.waitedMs ?? 0) + waited }, 'resumed');
      // A claimed launch's lease starts fresh at admission; a spawned one is renewed by liveness anyway.
      if (l) o.renewLease(l);
      o.store.putDedup(launchId, seq, { status: 200, body: { answer } });
    });
    o.resolveWaiters(launchId, { status: 200, body: { answer } });
  }

  for (const id of admission.launches) {
    if (o.inHold()) return;
    // A remote worker commits and pushes its own work, so a kind whose commit policy is daemon cannot run on a remote run; no launch is created. See specs/pull-runner "Remote run requirements".
    if (o.config.runner.access === 'remote') {
      const kind = o.selectionFor(id).runner;
      if (o.commitPolicyFor(kind) === 'daemon') {
        const message = `runner kind ${kind} has commit policy daemon, and a remote worker must commit and push its own work: set runner.${kind === 'claude-code' ? 'claude' : kind}.commit to agent or relabel the task`;
        o.transition(id, { kind: 'blocked', reason: { kind: 'remoteNeedsAgentCommit', message } }, 'orchestrator', 'remoteNeedsAgentCommit', undefined, { runner: kind });
        continue;
      }
    }
    const node = o.requireNode(id);
    const payload = o.payloadOf(node);
    const v = o.briefValidator.validate(node, payload);
    if (!v.ok) {
      if (o.config.onInsufficient === 'remediate') {
        const candidate = await o.remediator.remediate(node, payload, {
          missing: v.missing,
          depReports: node.deps.map((d) => ({ taskId: d, summary: o.store.getCompletionReport(d)?.body['summary'] as string | undefined })),
        });
        if (candidate) {
          if (o.config.remediateMode === 'auto') {
            o.store.setPayloadOverlay(id, g.rev, { ...(o.store.getPayloadOverlay(id, g.rev) ?? {}), ...candidate });
            await launchOrAbandon(o, id);
            continue;
          }
          o.transition(id, { kind: 'blocked', reason: { kind: 'needsDecision', message: `remediation candidate for: ${v.missing.join(', ')}`, missing: v.missing, candidate } }, 'orchestrator', 'briefValidationFailed');
          continue;
        }
      }
      o.transition(id, { kind: 'blocked', reason: { kind: 'insufficientSpec', message: `missing: ${v.missing.join(', ')}`, missing: v.missing } }, 'orchestrator', 'briefValidationFailed');
      continue;
    }
    await launchOrAbandon(o, id);
  }
}

/**
 * Start a launch at admission. One whose row was created but whose prepare or spawn threw has no agent: it is ended and
 * its attempt failed like a failed spawn of a parked launch, so the task is not left `running` on a `preparing` or
 * `launching` row until a restart. A throw before the row exists (the integration head unreadable) leaves the task
 * unstarted and propagates as before. See specs/pull-runner "Failed launch at admission".
 */
async function launchOrAbandon(o: Orchestrator, id: Id): Promise<void> {
  const before = o.entry(id).lease?.launchId;
  try {
    await startLaunch(o, id);
  } catch (err) {
    const leased = o.entry(id).lease?.launchId;
    const row = leased !== undefined && leased !== before ? o.store.getLaunch(leased) : undefined;
    if (!row || (row.status !== 'preparing' && row.status !== 'launching')) throw err;
    await abandonSpawn(o, row, row.status === 'preparing' ? 'prepare' : 'spawn', err);
  }
}

/** Spawn parked launches whose claim window elapsed: zero in spawn, claimWindowMs in mixed, never in pull. */
export async function spawnDueLaunches(o: Orchestrator): Promise<void> {
  // Launches whose prepare command succeeded and whose next step is spawn, in every mode.
  await spawnPreparedLaunches(o);
  const mode = o.effectiveMode();
  if (mode === 'pull') return;
  const window = mode === 'mixed' ? o.config.runner.claimWindowMs : 0;
  for (const listed of o.store.listLaunches({ status: 'claimable' })) {
    if (o.inHold()) return;
    if (o.now() - (listed.claimableAt ?? listed.createdAt) < window) continue;
    // The list is a snapshot, and a claim can land while an earlier launch of it is awaited: read the row and the
    // task again and move the launch to `launching` in the same synchronous step, so a claimed launch keeps its worker,
    // its worktree and its single agent. See specs/pull-runner "Spawn pass reads each launch before it spawns it".
    // Leaving `claimable` before any await also keeps a claim from landing while the brief is recomposed. The parked
    // brief was written for a worker that claims, with a lease line; a spawned launch's brief has none. A crash here
    // leaves a `launching` launch, which recovery revokes and relaunches. See specs/agent-protocol "No lease line for a spawned launch".
    const launching = o.store.transaction((): Launch | undefined => {
      const current = o.store.getLaunch(listed.launchId);
      if (current?.status !== 'claimable') return undefined;
      const entry = o.entry(current.taskId);
      if (entry.status.kind !== 'running' || entry.lease?.launchId !== current.launchId) return undefined;
      o.store.updateLaunch(current.launchId, { status: 'launching' });
      return { ...current, status: 'launching' };
    });
    if (!launching) continue;
    let stage: 'remove' | 'prepare' | 'spawn' = 'remove';
    try {
      if ((await o.workspace.remove(launching)) === false) throw new Error(`the parked worktree ${launching.worktree} could not be removed`);
      stage = 'prepare';
      await o.workspace.prepare(launching, o.briefInput(launching));
      // The prepare command runs again in the new worktree; the row stays `launching` until it succeeded.
      if (o.startPrepareCommand(launching)) continue;
      stage = 'spawn';
      await spawnLaunch(o, launching);
    } catch (err) {
      await abandonSpawn(o, launching, stage, err);
    }
  }
}

/**
 * A launch the spawn pass moved to `launching` whose worktree removal, prepare or spawn failed, or one admission created
 * whose prepare or spawn threw, has no agent: end it with
 * the stage and the error, and fail the task's attempt (charged, so a failure that repeats ends in `blocked` rather than
 * looping), which retries it with a new launch. The store work comes first, before any await; killing a half-started
 * process and removing the worktree are best effort, and a worktree left behind is retried on later ticks.
 * See specs/pull-runner "Failed spawn of a parked launch".
 */
export async function abandonSpawn(o: Orchestrator, launch: Launch, stage: 'remove' | 'prepare' | 'spawn', err: unknown): Promise<void> {
  const error = err instanceof Error ? err.message : String(err);
  const message = `launch ${launch.launchId} could not be started: ${stage} failed: ${error}`;
  o.store.transaction(() => {
    const current = o.store.getLaunch(launch.launchId);
    if (current) o.endLaunch(current, 'spawnFailed', { stage, error });
    const entry = o.entry(launch.taskId);
    if (entry.status.kind === 'running' && entry.lease?.launchId === launch.launchId) {
      o.fail(launch.taskId, { kind: 'exitedWithoutReport', message, detail: { launchId: launch.launchId, spawnFailed: true, stage, error } }, 'orchestrator', 'deadOrExpired');
    }
  });
  o.log.warn('a launch could not be started; its attempt ended', { taskId: launch.taskId, launchId: launch.launchId, stage, err: error });
  try {
    await o.runner.killByLaunchId(launch.launchId);
  } catch (killErr) {
    o.log.warn('kill after a failed launch failed', { launchId: launch.launchId, err: String(killErr) });
  }
  await removeOrRetryLater(o, launch);
}

/** Phase 5. */
const lastEvaluation = new WeakMap<Orchestrator, string>();

export function evaluate(o: Orchestrator): void {
  const s = o.status();
  const key = s.finished ? 'finished' : s.stalled ? `stalled:${s.stallRoots.join(',')}` : 'active';
  if (lastEvaluation.get(o) === key) return;
  lastEvaluation.set(o, key);
  if (s.finished) o.log.info('finished');
  else if (s.stalled) o.log.warn('stalled', { stallRoots: s.stallRoots });
  else o.log.info('active', { running: s.byStatus.running, waiting: s.byStatus.waiting, ready: s.byStatus.unstarted.length });
}
