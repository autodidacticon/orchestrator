/**
 * The five tick phases, in the order the stall property depends on:
 *   1 reconcile leases and launches
 *   2 drain verification
 *   3 complete due milestones to a fixed point
 *   4 admit resumables, then validate briefs and launch
 *   5 evaluate
 */
import { crashPoint } from '../crash.js';
import * as q from '../graph/query.js';
import { spawnLaunch, startLaunch } from '../launch/launch.js';
import type { Id } from '../graph/model.js';
import type { AttemptContext, Entry, FailedKind } from '../state/status.js';
import type { Launch, VerifierJob } from '../state/store.js';
import type { Orchestrator } from './orchestrator.js';
import { admit } from './schedule.js';
import { ceilingUsd, checkTimeBudget, runCostUsd } from '../health/budgets.js';
import { observeFingerprint, recordSignal } from '../health/progress.js';
import { checkStuck } from '../health/stuck.js';

export async function runTick(o: Orchestrator): Promise<void> {
  await o.loadGraph();
  if (!o.hasGraph()) return;

  await reconcile(o);
  crashPoint('tick.afterPhase1');

  drainVerification(o);
  crashPoint('tick.afterPhase2');

  await completeMilestones(o);
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
  const now = o.now();
  for (const launch of o.store.listLaunches({ status: 'live' })) {
    const entry = o.entry(launch.taskId);
    const owns = entry.lease?.launchId === launch.launchId;
    const active = owns && (entry.status.kind === 'running' || entry.status.kind === 'waiting');

    if (entry.status.kind === 'cancelled' || (!active && !owns)) {
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
      if (cur.status.kind === 'running' && cur.lease?.launchId === launch.launchId && cur.lease.expiresAt <= now) {
        await o.recordUsage(launch);
        o.fail(launch.taskId, { kind: 'leaseExpired', message: `no contact from worker for ${o.config.leaseTtlMs}ms` }, 'orchestrator', 'deadOrExpired');
        o.endLaunch(launch, 'leaseExpired');
        await o.workspace.remove(launch);
      }
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
    if (fb.kind === 'submit') {
      const seal = await o.workspace.seal(launch);
      if (seal.ok) fb.body = { ...fb.body, __sealedSha: seal.sealedSha };
    }
    o.applyFallback(launch, fb);
  } else if (entry.status.kind === 'waiting') {
    o.transition(launch.taskId, { kind: 'blocked', reason: { ...entry.status.question, answer: entry.status.answer } }, 'orchestrator', 'maxWaitOrDead');
    if (entry.status.answer !== undefined) o.unblock(launch.taskId, { answer: entry.status.answer });
  } else if (entry.status.kind === 'running') {
    o.fail(launch.taskId, { kind: 'exitedWithoutReport', message: 'process exited without a report' }, 'orchestrator', 'deadOrExpired');
  }
  o.endLaunch(launch, fb ? `fallback:${fb.kind}` : 'exited');
  const after = o.entry(launch.taskId);
  if (after.status.kind !== 'submitted') await o.workspace.remove(launch);
}

/** Phase 2: apply terminal job results, then start the worker if idle. */
export function drainVerification(o: Orchestrator): void {
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
        } else if (job.status === 'failed') {
          o.fail(job.taskId, { kind: (job.failureKind as FailedKind | undefined) ?? 'checkFailed', message: job.failureKind, output: job.output }, 'verifier', 'verificationFailed');
        }
      }
      o.store.updateJob(job.jobId, { applied: true, updatedAt: o.now() });
    });
    const launch = o.store.getLaunch(job.launchId);
    if (launch && launch.status === 'live') {
      // The agent has nothing more to do; its process exits on its own and reconcile ends the launch.
      void o.workspace.remove(launch).catch(() => undefined);
    } else if (launch) {
      void o.workspace.remove(launch).catch(() => undefined);
    }
  }
  o.startVerifierIfIdle();
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
      await o.workspace.tagMilestone(c.id, entry.reviewVersion, c.integrationSha ?? head);
      crashPoint('milestone.afterTag');
      o.store.setKv(`tagged:${c.id}:${entry.reviewVersion}`, c.integrationSha ?? head);
      o.store.appendEvent({ kind: 'milestone.tagged', taskId: c.id, payload: { version: entry.reviewVersion, sha: c.integrationSha } }, o.now());
    }
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
  const admission = admit(resumables, q.ready(g, overlay), {
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
    const e = o.entry(id);
    if (e.status.kind !== 'waiting' || e.status.answer === undefined || !e.lease) continue;
    const { seq, answer } = e.status;
    const launchId = e.lease.launchId;
    o.store.transaction(() => {
      o.transition(id, { kind: 'running' }, 'orchestrator', 'resumed', { lease: e.lease });
      const l = o.store.getLaunch(launchId);
      const now = o.now();
      const waited = l?.waitingSince !== undefined ? now - l.waitingSince : 0;
      o.store.updateLaunch(launchId, { pendingAnswer: { seq, answer }, waitedMs: (l?.waitedMs ?? 0) + waited, waitingSince: undefined });
      if (l) recordSignal(o, { ...l, waitedMs: (l.waitedMs ?? 0) + waited }, 'resumed');
      // A claimed launch's lease starts fresh at admission; a spawned one is renewed by liveness anyway.
      if (l) o.renewLease(l);
      o.store.putDedup(launchId, seq, { status: 200, body: { answer } });
    });
    o.resolveWaiters(launchId, { status: 200, body: { answer } });
  }

  for (const id of admission.launches) {
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
            await startLaunch(o, id);
            continue;
          }
          o.transition(id, { kind: 'blocked', reason: { kind: 'needsDecision', message: `remediation candidate for: ${v.missing.join(', ')}`, missing: v.missing, candidate } }, 'orchestrator', 'briefValidationFailed');
          continue;
        }
      }
      o.transition(id, { kind: 'blocked', reason: { kind: 'insufficientSpec', message: `missing: ${v.missing.join(', ')}`, missing: v.missing } }, 'orchestrator', 'briefValidationFailed');
      continue;
    }
    await startLaunch(o, id);
  }
}

/** Spawn parked launches whose claim window elapsed: zero in spawn, claimWindowMs in mixed, never in pull. */
export async function spawnDueLaunches(o: Orchestrator): Promise<void> {
  const mode = o.effectiveMode();
  if (mode === 'pull') return;
  const window = mode === 'mixed' ? o.config.runner.claimWindowMs : 0;
  for (const launch of o.store.listLaunches({ status: 'claimable' })) {
    if (o.now() - (launch.claimableAt ?? launch.createdAt) < window) continue;
    const entry = o.entry(launch.taskId);
    if (entry.status.kind !== 'running' || entry.lease?.launchId !== launch.launchId) continue;
    await spawnLaunch(o, launch);
  }
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
