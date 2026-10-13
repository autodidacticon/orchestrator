/**
 * Budgets: wall time per launch and cost per run. See specs/health-monitoring
 * "Launch time budget", "Usage accounting", and "Run cost budget".
 */
import type { Config } from '../config.js';
import type { Id } from '../graph/model.js';
import type { Launch, Store } from '../state/store.js';
import type { Orchestrator } from '../loop/orchestrator.js';

/** Wall time since spawn, excluding time the task spent waiting on questions. */
export function elapsedMs(launch: Launch, now: number): number {
  const start = launch.spawnedAt ?? launch.createdAt;
  const waiting = launch.waitingSince !== undefined ? now - launch.waitingSince : 0;
  return Math.max(0, now - start - (launch.waitedMs ?? 0) - waiting);
}

/** Returns true when the launch was ended for exceeding `budgets.maxLaunchMs`. */
export async function checkTimeBudget(o: Orchestrator, launch: Launch): Promise<boolean> {
  const max = o.config.budgets.maxLaunchMs;
  if (!max) return false;
  const elapsed = elapsedMs(launch, o.now());
  if (elapsed < max) return false;
  await o.runner.reap(launch);
  await o.recordUsage(launch);
  o.fail(launch.taskId, { kind: 'timeBudget', message: `launch ran ${Math.round(elapsed / 1000)}s, budget ${Math.round(max / 1000)}s` }, 'orchestrator', 'timeBudget');
  o.endLaunch(launch, 'timeBudget');
  await o.workspace.remove(launch);
  return true;
}

export function runCostUsd(store: Store): number {
  let total = 0;
  for (const l of store.listLaunches()) if (typeof l.costUsd === 'number') total += l.costUsd;
  return round(total);
}

export function costByTask(store: Store): Record<Id, number> {
  const out: Record<Id, number> = {};
  for (const l of store.listLaunches()) if (typeof l.costUsd === 'number') out[l.taskId] = round((out[l.taskId] ?? 0) + l.costUsd);
  return out;
}

export function budgetOverrides(store: Store): number {
  return Number(store.getKv('budgetOverrides') ?? 0);
}

/** The run cost ceiling: the budget times one plus the overrides, or undefined when unlimited. */
export function ceilingUsd(config: Config, store: Store): number | undefined {
  const budget = config.budgets.maxRunCostUsd;
  if (!budget) return undefined;
  return round(budget * (1 + budgetOverrides(store)));
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
