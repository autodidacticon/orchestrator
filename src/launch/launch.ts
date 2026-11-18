/**
 * Launch sequence with durable records around each external effect:
 *   row(preparing) -> worktree -> row(launching) -> spawn -> pid -> row(live)
 * See specs/crash-recovery "Launch lifecycle records".
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { composeBrief } from '../brief/compose.js';
import { crashPoint } from '../crash.js';
import type { Id } from '../graph/model.js';
import type { Lease } from '../state/status.js';
import type { Launch, RunnerMode } from '../state/store.js';
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
 * Create the launch for a task and prepare its worktree and brief. For a fresh
 * attempt this performs unstarted -> running. For `sameAttempt` the task stays
 * running and only the launch counter advances. The row is left `preparing`.
 */
export async function prepareLaunch(core: OrchestratorCore, taskId: Id, opts: StartLaunchOptions = {}): Promise<Launch> {
  const { store, config, workspace } = core;
  const now = core.now();
  const node = core.requireNode(taskId);
  const baseSha = await workspace.integrationHead();
  const launchId = randomUUID();
  const token = randomBytes(24).toString('hex');
  // Fixed here for the life of the launch; a later override reaches launches prepared afterwards. See specs/model-selection "Resolution fixed at preparation".
  const { runner, model, effort, effortRequested } = core.selectionFor(taskId);
  const commitPolicy = core.commitPolicyFor(runner);
  // Fixed on the row for its life. A remote launch gets no worktree: its brief is kept on the row. See specs/remote-workspace.
  const access = config.runner.access;

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
      worktree: access === 'remote' ? '' : worktreePath(config.dataDir, launchId),
      baseSha,
      graphRev: lease.graphRev,
      createdAt: now,
      interruptions: entry.interruptions ?? 0,
      runner,
      model,
      effort,
      commitPolicy,
      access,
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
    store.appendEvent({ kind: 'launch.created', taskId, launchId, payload: { attempt, launchNo, sameAttempt: Boolean(opts.sameAttempt), runner, model, effort, commitPolicy, access, ...(effortRequested ? { effortRequested } : {}) } }, now);
    return row;
  });
  crashPoint('launch.afterRow');

  if (access === 'remote') {
    const brief = remoteBrief(core, launch);
    store.updateLaunch(launchId, brief);
    return { ...launch, ...brief };
  }
  await workspace.prepare(launch, core.briefInput(launch));
  return launch;
}

/** The brief of a remote launch, composed as for a worktree and kept on the row. See specs/remote-workspace "Brief on the launch row". */
export function remoteBrief(core: OrchestratorCore, launch: Launch): { briefMarkdown: string; briefJson: Record<string, unknown> } {
  // No worktree holds a fallback file or tells whether the repository has an openspec root: the paths are relative to the worker's checkout.
  // The URL a remote worker reaches the daemon at is apiBaseUrl, which startup requires on a remote run; never the bind address.
  const input = core.briefInput(launch);
  const apiBaseUrl = core.config.apiBaseUrl ? core.config.apiBaseUrl.replace(/\/+$/, '') : input.apiBaseUrl;
  const { markdown, json } = composeBrief({ ...input, apiBaseUrl }, {
    fallbackPath: path.join('.orchestrator', 'report.json'),
    openspec: existsSync(path.join(core.config.repoPath, 'openspec')),
  });
  return { briefMarkdown: markdown, briefJson: json as unknown as Record<string, unknown> };
}

/** Spawn a prepared launch: launching -> process -> live with a pid. */
export async function spawnLaunch(core: OrchestratorCore, launch: Launch): Promise<Launch> {
  const { store, runner } = core;
  const { launchId, taskId } = launch;
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

/**
 * Prepare a launch, then spawn it in `spawn` mode or park it as `claimable`
 * for a worker in `pull` and `mixed` modes. See specs/pull-runner "Runner modes".
 */
export async function startLaunch(core: OrchestratorCore, taskId: Id, opts: StartLaunchOptions = {}): Promise<Launch> {
  const launch = await prepareLaunch(core, taskId, opts);
  // With a prepare command set, it runs off the tick; the tick parks or spawns the launch once it succeeded.
  // See specs/pull-runner "Prepare command".
  if (core.startPrepareCommand(launch)) return launch;
  const mode = core.effectiveMode();
  if (mode === 'spawn') return spawnLaunch(core, launch);
  return parkLaunch(core, launch, mode);
}

/** Park a prepared launch as `claimable` for a worker. */
export function parkLaunch(core: OrchestratorCore, launch: Launch, mode: RunnerMode = core.effectiveMode()): Launch {
  const { taskId } = launch;
  const claimableAt = core.now();
  core.store.transaction(() => {
    core.store.updateLaunch(launch.launchId, { status: 'claimable', claimableAt });
    core.store.appendEvent({ kind: 'launch.claimable', taskId, launchId: launch.launchId, payload: { mode } }, claimableAt);
  });
  crashPoint('launch.afterClaimable');
  return { ...launch, status: 'claimable', claimableAt };
}
