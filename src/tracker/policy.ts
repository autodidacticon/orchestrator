/**
 * Tracker mirroring policy: when effects are derived and for which nodes.
 * See specs/tracker-sync "Tracker policy".
 */
import type { Config } from '../config.js';
import type { GraphNode } from '../graph/model.js';
import { runIdOf, type Store, trackerOf } from '../state/store.js';

export function trackerEnabled(config: Config, store: Store): boolean {
  switch (config.tracker.enabled) {
    case 'never':
      return false;
    case 'always':
      return true;
    default:
      return trackerOf(store) !== undefined;
  }
}

/** A node mirrors to a tracker only when its payload carries a tracker identity. */
export function hasTrackerIdentity(node: GraphNode): boolean {
  if (node.kind === 'external') return false;
  const url = node.payload['url'];
  const state = node.payload['trackerState'];
  return (typeof url === 'string' && url.length > 0) || typeof state === 'string';
}

/** What a drainer needs to know, returned with pending effects. */
export function policyReport(config: Config, store: Store): Record<string, unknown> {
  const t = config.tracker;
  return {
    enabled: trackerEnabled(config, store),
    mode: t.enabled,
    doneAt: t.doneAt,
    parentInProgress: t.parentInProgress,
    commentOnDone: t.commentOnDone,
    commentOnFail: t.commentOnFail,
    answersFromComments: t.answersFromComments,
    maxAttempts: t.maxAttempts,
    runId: runIdOf(store),
    tracker: trackerOf(store),
  };
}
