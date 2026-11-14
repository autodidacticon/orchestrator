/**
 * Backoff and refusal counting for publication pushes, kept in the store's key-value table per verifier job (a new
 * launch has a new job, so its count starts at zero). See specs/integration-pipeline "Push failures are classified".
 */
import type { Store } from '../state/store.js';

export interface PushRetryState {
  /** Pushes origin refused (a hook, a protected branch, missing permission, foreign commits held back). */
  refusals: number;
  /** Fetches or pushes that did not reach origin or timed out. Never counted against the limit. */
  failures: number;
  /** The job is not started again before this time. */
  retryAt: number;
  /** The last refusal or failure, as git reported it. */
  last: string;
}

export interface PushRetrySettings {
  pushRefusalLimit: number;
  pushRetryBackoffMs: number;
}

/** The longest wait, as a multiple of the base backoff. */
const MAX_BACKOFF_FACTOR = 32;

const key = (jobId: string) => `pushRetry:${jobId}`;

/** The job failure kind of a push refused `git.pushRefusalLimit` times; drained as a block, not a failure. */
export const PUSH_REFUSED = 'pushRefused';

export function readPushRetry(store: Pick<Store, 'getKv'>, jobId: string): PushRetryState | undefined {
  const raw = store.getKv(key(jobId));
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as PushRetryState;
  } catch {
    return undefined;
  }
}

/** False while the job waits out its backoff. */
export function pushRetryDue(store: Pick<Store, 'getKv'>, jobId: string, now: number): boolean {
  const state = readPushRetry(store, jobId);
  return !state || state.retryAt <= now;
}

/**
 * Count one refused or unreachable push and set the next retry time: the base backoff doubled per earlier retry of
 * the job, capped. `blocked` once refusals reach the limit.
 */
export function recordPushRetry(
  store: Pick<Store, 'getKv' | 'setKv'>,
  jobId: string,
  retry: { kind: 'refused' | 'unreachable'; message: string },
  settings: PushRetrySettings,
  now: number,
): { state: PushRetryState; blocked: boolean; delayMs: number } {
  const prev = readPushRetry(store, jobId) ?? { refusals: 0, failures: 0, retryAt: 0, last: '' };
  const tries = prev.refusals + prev.failures;
  const delayMs = settings.pushRetryBackoffMs * Math.min(2 ** tries, MAX_BACKOFF_FACTOR);
  const state: PushRetryState = {
    refusals: prev.refusals + (retry.kind === 'refused' ? 1 : 0),
    failures: prev.failures + (retry.kind === 'unreachable' ? 1 : 0),
    retryAt: now + delayMs,
    last: retry.message,
  };
  store.setKv(key(jobId), JSON.stringify(state));
  return { state, blocked: state.refusals >= settings.pushRefusalLimit, delayMs };
}
