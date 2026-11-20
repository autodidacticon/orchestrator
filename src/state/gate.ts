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

export const RUNNER_METHODS = ['spawn', 'alive', 'liveness', 'reap', 'reapAll', 'killByLaunchId', 'readUsage', 'readFailure'] as const satisfies ReadonlyArray<keyof AgentRunner>;

export const VERIFIER_METHODS = ['run', 'recoverPublishing', 'foreignCommits', 'sweepTemp'] as const satisfies ReadonlyArray<keyof VerifierBackend>;

/** The status report's store fields. */
export function storeLag(store: Store): { storeLagMs: number; storePendingBatches: number } {
  const d = store.durability();
  return { storeLagMs: d.lagMs, storePendingBatches: d.pendingBatches };
}

/** Thrown while waiting for durability when the store went fatal: the waiting effect must not happen. */
export class StoreFatalError extends Error {
  constructor() {
    super('the store is fatal; the effect waiting for durability does not happen');
    this.name = 'StoreFatalError';
  }
}

/** The journal's fatal condition, when the store is a journal that went fatal. */
export function storeFatal(store: Store): unknown {
  return (store as { fatalReason?: () => unknown }).fatalReason?.();
}

/**
 * Wait until everything committed so far is durable. A journal that went fatal never resolves `durable()`, so a
 * fatal journal throws StoreFatalError: at once when it is fatal already (with or without pending batches), or as
 * soon as it turns fatal during the wait. See specs/state-backend "Durability before effects".
 */
export async function waitDurable(store: Store): Promise<void> {
  if (storeFatal(store)) throw new StoreFatalError();
  if (store.durability().pendingBatches === 0) return;
  const done = store.durable().then(() => true);
  for (;;) {
    if (storeFatal(store)) throw new StoreFatalError();
    let timer: NodeJS.Timeout | undefined;
    const ok = await Promise.race([done, new Promise<false>((r) => (timer = setTimeout(() => r(false), 100)))]);
    clearTimeout(timer);
    if (ok) {
      if (storeFatal(store)) throw new StoreFatalError();
      return;
    }
  }
}

/**
 * A view of `target` whose `methods` first wait for durability (`waitDurable`). Methods are looked up on every
 * access, so a method replaced on the target later is still gated, and an absent optional method stays
 * absent. Other properties pass through. With nothing pending the call runs at once, unchanged; on a fatal journal
 * it rejects at once with StoreFatalError and the method does not run.
 */
export function gateOnDurable<T extends object>(store: Store, target: T, methods: readonly string[]): T {
  const gated = new Set(methods);
  return new Proxy(target, {
    get(t, prop, receiver) {
      const value = Reflect.get(t, prop, receiver) as unknown;
      if (typeof prop !== 'string' || !gated.has(prop) || typeof value !== 'function') return value;
      const fn = value as (...args: unknown[]) => unknown;
      return (...args: unknown[]) => {
        if (storeFatal(store)) return Promise.reject(new StoreFatalError());
        if (store.durability().pendingBatches === 0) return fn.apply(t, args);
        return waitDurable(store).then(() => fn.apply(t, args));
      };
    },
  });
}
