/**
 * Durability before effects: a wrapper whose listed methods wait for `store.durable()` before they
 * run, so no outside effect happens before the record that caused it is durable.
 * See specs/state-backend "Durability before effects".
 */
import type { AgentRunner } from '../runner/runner.js';
import type { VerifierBackend } from '../verify/job.js';
import type { Workspace } from '../workspace/workspace.js';
import type { Store } from './store.js';

export const WORKSPACE_METHODS = [
  'integrationHead',
  'prepare',
  'seal',
  'readFallback',
  'remove',
  'listWorktrees',
  'tagMilestone',
  'diffStat',
  'fingerprint',
  'exists',
  'preserve',
] as const satisfies ReadonlyArray<keyof Workspace>;

export const RUNNER_METHODS = ['spawn', 'alive', 'liveness', 'reap', 'killByLaunchId', 'readUsage', 'readFailure'] as const satisfies ReadonlyArray<keyof AgentRunner>;

export const VERIFIER_METHODS = ['run', 'recoverPublishing', 'foreignCommits', 'sweepTemp'] as const satisfies ReadonlyArray<keyof VerifierBackend>;

/** The status report's store fields. */
export function storeLag(store: Store): { storeLagMs: number; storePendingBatches: number } {
  const d = store.durability();
  return { storeLagMs: d.lagMs, storePendingBatches: d.pendingBatches };
}

/**
 * A view of `target` whose `methods` first await `store.durable()`. Methods are looked up on every
 * access, so a method replaced on the target later is still gated, and an absent optional method stays
 * absent. Other properties pass through. With nothing pending the call runs at once, unchanged.
 */
export function gateOnDurable<T extends object>(store: Store, target: T, methods: readonly string[]): T {
  const gated = new Set(methods);
  return new Proxy(target, {
    get(t, prop, receiver) {
      const value = Reflect.get(t, prop, receiver) as unknown;
      if (typeof prop !== 'string' || !gated.has(prop) || typeof value !== 'function') return value;
      const fn = value as (...args: unknown[]) => unknown;
      return (...args: unknown[]) => {
        if (store.durability().pendingBatches === 0) return fn.apply(t, args);
        return store.durable().then(() => fn.apply(t, args));
      };
    },
  });
}
