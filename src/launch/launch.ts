/**
 * Launch sequence with durable records around each external effect:
 *   row(preparing) -> worktree -> row(launching) -> spawn -> pid -> row(live)
 * See specs/crash-recovery "Launch lifecycle records".
 */
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { crashPoint } from '../crash.js';
import type { Id } from '../graph/model.js';
import type { Lease } from '../state/status.js';
import type { Launch } from '../state/store.js';
import { applyTransition } from '../state/transitions.js';
import type { OrchestratorCore } from '../loop/core.js';

export function branchName(taskId: Id, launchNo: number): string {
  return `task/${taskId}/l${launchNo}`;
}

export function worktreePath(dataDir: string, launchId: string): string {
  return path.join(dataDir, 'worktrees', launchId);
}

export interface StartLaunchOptions {
  /** Recovery relaunch of the same attempt: no transition, launches++ only. */
  sameAttempt?: boolean;
}

/**
 * Create the launch for a task. For a fresh attempt this performs
 * unstarted -> running. For `sameAttempt` the task stays running and only the
 * launch counter advances.
 */
export async function startLaunch(core: OrchestratorCore, taskId: Id, opts: StartLaunchOptions = {}): Promise<Launch> {
  const { store, config, runner, workspace } = core;
  const now = core.now();
  const node = core.requireNode(taskId);
  const baseSha = await workspace.integrationHead();
  const launchId = randomUUID();
  const token = randomBytes(24).toString('hex');

  const launch = store.transaction((): Launch => {
    const entry = core.entry(taskId);
    const launchNo = entry.launches + 1;
    const attempt = entry.attempts + 1;
    const lease: Lease = {
      launchId,
      token,
      claimedAt: now,
      expiresAt: now + config.leaseTtlMs,
      baseSha,
      graphRev: core.graphRev(),
    };
    const row: Launch = {
      launchId,
      taskId,
      attempt,
      launchNo,
      status: 'preparing',
      token,
      branch: branchName(taskId, launchNo),
      worktree: worktreePath(config.dataDir, launchId),
      baseSha,
      graphRev: lease.graphRev,
      createdAt: now,
    };
    store.createLaunch(row);
    if (opts.sameAttempt) {
      store.setEntry(taskId, { ...entry, launches: launchNo, lease, updatedAt: now });
    } else {
      const next = applyTransition(entry, { kind: 'running' }, {
        nodeId: taskId,
        nodeKind: node.kind,
        actor: 'orchestrator',
        trigger: 'admitted',
        now,
        patch: { lease },
      });
      store.setEntry(taskId, next);
      core.recordTransition(taskId, entry.status.kind, 'running', 'orchestrator', 'admitted');
    }
    store.appendEvent({ kind: 'launch.created', taskId, launchId, payload: { attempt, launchNo, sameAttempt: Boolean(opts.sameAttempt) } }, now);
    return row;
  });
  crashPoint('launch.afterRow');

  await workspace.prepare(launch, core.briefInput(launch));
  store.updateLaunch(launchId, { status: 'launching' });
  crashPoint('launch.afterWorktree');

  const { pid } = await runner.spawn(launch, core.agentEnv(launch));
  crashPoint('launch.afterSpawn');

  const spawnedAt = core.now();
  store.transaction(() => {
    store.updateLaunch(launchId, { status: 'live', pid, spawnedAt, progressAt: spawnedAt, lastSignal: 'spawned' });
    const entry = core.entry(taskId);
    if (entry.lease?.launchId === launchId) {
      store.setEntry(taskId, { ...entry, lease: { ...entry.lease, spawnedAt }, carry: undefined, updatedAt: spawnedAt });
    }
    store.appendEvent({ kind: 'launch.live', taskId, launchId, payload: { pid } }, spawnedAt);
  });
  crashPoint('launch.afterPid');
  return { ...launch, status: 'live', pid, spawnedAt, progressAt: spawnedAt, lastSignal: 'spawned' };
}
