/**
 * Stuck detection: flag, nudge, then fail. See specs/health-monitoring
 * "Stuck detection and escalation" and "Stuck diagnosis hook".
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Id } from '../graph/model.js';
import { logPath } from '../runner/subprocess.js';
import type { Launch } from '../state/store.js';
import type { Orchestrator } from '../loop/orchestrator.js';
import type { AwakeClock } from './gaps.js';
import { headOf } from './progress.js';

export interface StuckContext {
  task: Id;
  launch: Launch;
  idleMs: number;
  logTail: string;
  diffStat: string;
}

export interface StuckDiagnosis {
  action: 'wait' | 'nudge' | 'fail';
  message?: string;
}

/** Same shape as the remediation hook: a model may answer later; the default leaves it to a human. */
export interface StuckDiagnoser {
  diagnose(ctx: StuckContext): Promise<StuckDiagnosis>;
}

export const humanDiagnoser: StuckDiagnoser = { diagnose: async () => ({ action: 'wait' }) };

/** Awake time since the last progress (or the spawn, or the creation): gaps in the daemon's clock are left out. See specs/health-monitoring "Gap in the daemon's clock". */
export function idleMsOf(launch: Launch, now: number, clock: AwakeClock): number {
  return clock.awakeMs(launch.progressAt ?? launch.spawnedAt ?? launch.createdAt, now);
}

/** Whether a launch idle for `idleMs` is failed under `health.stuckFailAfterMs` = `limit`; 0 disables it. Shared by the check and the configuration guard. */
export function exceedsStuckFail(idleMs: number, limit: number): boolean {
  return limit > 0 && idleMs > limit;
}

/** Reap, record usage, fail with reason `stuck`, end the launch, remove the worktree. */
export async function failStuck(o: Orchestrator, launch: Launch, message: string): Promise<void> {
  await o.runner.reap(launch);
  await o.recordUsage(launch);
  o.fail(launch.taskId, { kind: 'stuck', message }, 'orchestrator', 'stuck');
  o.endLaunch(launch, 'stuck');
  await o.workspace.remove(launch);
}

/** Returns true when the launch was ended. Only for `running` tasks whose process is alive. */
export async function checkStuck(o: Orchestrator, launch: Launch): Promise<boolean> {
  const { stuckAfterMs, stuckFailAfterMs } = o.effective().config.health;
  // A sleep during the awaits before this check is a gap, left out of the idle time.
  o.noteClock();
  const now = o.now();
  const cur = o.store.getLaunch(launch.launchId) ?? launch;
  const idleMs = idleMsOf(cur, now, o);
  if (exceedsStuckFail(idleMs, stuckFailAfterMs)) {
    await failStuck(o, cur, `no progress for ${Math.round(idleMs / 1000)}s`);
    return true;
  }
  if (stuckAfterMs > 0 && idleMs > stuckAfterMs && cur.stuckSince === undefined) {
    const message = `No progress observed for ${Math.round(idleMs / 1000)}s (last signal: ${cur.lastSignal ?? 'none'}). Commit or report what you have, or ask a question.`;
    o.store.transaction(() => {
      o.store.updateLaunch(cur.launchId, { stuckSince: now, notices: [...(cur.notices ?? []), { kind: 'stuck', idleMs, message }] });
      o.store.appendEvent({ kind: 'launch.stuck', taskId: cur.taskId, launchId: cur.launchId, payload: { idleMs, lastSignal: cur.lastSignal } }, now);
    });
    const diagnosis = await o.stuckDiagnoser.diagnose({ task: cur.taskId, launch: cur, idleMs, logTail: await logTail(o, cur), diffStat: await diffStat(o, cur) }).catch(() => ({ action: 'wait' as const }));
    if (diagnosis.action === 'nudge') {
      o.queueNotice(cur.launchId, { kind: 'nudge', message: diagnosis.message ?? message, source: 'diagnoser' });
    } else if (diagnosis.action === 'fail') {
      await failStuck(o, o.store.getLaunch(cur.launchId) ?? cur, diagnosis.message ?? `diagnoser: no progress for ${Math.round(idleMs / 1000)}s`);
      return true;
    }
  }
  return false;
}

async function logTail(o: Orchestrator, launch: Launch): Promise<string> {
  const text = await readFile(logPath(path.join(o.config.dataDir, 'logs'), launch.launchId), 'utf8').catch(() => '');
  return text.length > 4000 ? text.slice(text.length - 4000) : text;
}

async function diffStat(o: Orchestrator, launch: Launch): Promise<string> {
  const head = headOf(launch.fingerprint);
  if (!head || head === launch.baseSha) return '';
  return o.workspace.diffStat(launch.baseSha, head).catch(() => '');
}
