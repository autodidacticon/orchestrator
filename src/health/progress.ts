/**
 * Progress signals: what counts as evidence that an agent is working. See
 * specs/health-monitoring "Progress signals".
 */
import type { Launch, Store } from '../state/store.js';
import type { Workspace } from '../workspace/workspace.js';

export type SignalKind = 'spawned' | 'commit' | 'worktree' | 'heartbeat' | 'heartbeatText' | 'report' | 'block' | 'inbox' | 'log' | 'resumed';

export interface SignalSink {
  store: Store;
  now(): number;
}

/** Record progress on the launch row; clears a stuck flag and appends `launch.unstuck` when one was set. */
export function recordSignal(o: SignalSink, launch: Launch, kind: SignalKind, text?: string): void {
  const now = o.now();
  const patch: Partial<Launch> = { progressAt: now, lastSignal: kind };
  if (text !== undefined) patch.progressText = text;
  o.store.transaction(() => {
    if (launch.stuckSince !== undefined) {
      patch.stuckSince = undefined;
      o.store.appendEvent({ kind: 'launch.unstuck', taskId: launch.taskId, launchId: launch.launchId, payload: { idleMs: now - (launch.progressAt ?? now), signal: kind } }, now);
    }
    o.store.updateLaunch(launch.launchId, patch);
  });
}

export const headOf = (fingerprint: string | undefined): string | undefined => fingerprint?.split(':')[0];

/**
 * Compare the worktree fingerprint with the stored one. The first sight is a
 * baseline; afterwards a moved head is `commit` and any other change is `worktree`.
 */
export async function observeFingerprint(o: SignalSink & { workspace: Workspace; config: { tickIntervalMs: number } }, launch: Launch): Promise<Launch> {
  const now = o.now();
  // A signal newer than one tick makes the git calls redundant for this tick.
  if (launch.progressAt !== undefined && now - launch.progressAt < o.config.tickIntervalMs && launch.fingerprint) return launch;
  let fp: string;
  try {
    fp = await o.workspace.fingerprint(launch);
  } catch {
    return launch;
  }
  if (!launch.fingerprint) {
    o.store.updateLaunch(launch.launchId, { fingerprint: fp });
    return { ...launch, fingerprint: fp };
  }
  if (fp === launch.fingerprint) return launch;
  const kind: SignalKind = headOf(fp) !== headOf(launch.fingerprint) ? 'commit' : 'worktree';
  o.store.updateLaunch(launch.launchId, { fingerprint: fp });
  recordSignal(o, { ...launch, fingerprint: fp }, kind);
  return o.store.getLaunch(launch.launchId) ?? { ...launch, fingerprint: fp, progressAt: now, lastSignal: kind };
}
