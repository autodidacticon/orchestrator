/**
 * Budgets: wall time per launch and cost per run. See specs/health-monitoring
 * "Launch time budget", "Usage accounting", and "Run cost budget".
 */
import type { Config, Price } from '../config.js';
import type { Id } from '../graph/model.js';
import type { TokenUsage } from '../runner/runner.js';
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

/** Launches that recorded tokens but no cost: their price is unknown and they are outside the run cost. */
export function unpricedLaunches(store: Store): number {
  let n = 0;
  for (const l of store.listLaunches()) if (l.tokens && l.costUsd === undefined) n++;
  return n;
}

export function tokensOf(store: Store): { run: TokenUsage; byTask: Record<Id, TokenUsage> } {
  const run: TokenUsage = { input: 0, output: 0 };
  const byTask: Record<Id, TokenUsage> = {};
  for (const l of store.listLaunches()) {
    if (!l.tokens) continue;
    addTokens(run, l.tokens);
    addTokens((byTask[l.taskId] ??= { input: 0, output: 0 }), l.tokens);
  }
  return { run, byTask };
}

function addTokens(into: TokenUsage, t: TokenUsage): void {
  into.input += t.input;
  into.output += t.output;
  for (const k of ['cachedInput', 'cacheWriteInput', 'reasoningOutput'] as const) if (t[k] !== undefined) into[k] = (into[k] ?? 0) + t[k];
}

/**
 * The USD cost of a launch's tokens at one model's rates per million tokens:
 *   (input - cachedInput) at inputPerMTok
 *   + cachedInput at cachedInputPerMTok (fallback inputPerMTok)
 *   + cacheWriteInput at cacheWriteInputPerMTok (fallback inputPerMTok)
 *   + output at outputPerMTok
 *   + reasoningOutput at reasoningOutputPerMTok (fallback outputPerMTok)
 * rounded to 1e-6. Assumed, unverified: cachedInput is part of input, and reasoningOutput is not part of output.
 */
export function priceUsage(tokens: TokenUsage, price: Price): number {
  const cached = tokens.cachedInput ?? 0;
  const usd =
    Math.max(0, tokens.input - cached) * price.inputPerMTok +
    cached * (price.cachedInputPerMTok ?? price.inputPerMTok) +
    (tokens.cacheWriteInput ?? 0) * (price.cacheWriteInputPerMTok ?? price.inputPerMTok) +
    tokens.output * price.outputPerMTok +
    (tokens.reasoningOutput ?? 0) * (price.reasoningOutputPerMTok ?? price.outputPerMTok);
  return round(usd / 1_000_000);
}

/** The configured price for a model, own keys only. */
export function priceFor(config: Config, model: string | undefined): Price | undefined {
  const prices = config.budgets.prices;
  return model !== undefined && Object.hasOwn(prices, model) ? prices[model] : undefined;
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
