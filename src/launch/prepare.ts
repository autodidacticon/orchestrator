/**
 * The prepare command: a configured command the daemon runs in each worktree it prepares for a launch, off the tick,
 * before the launch is parked or spawned. The command's callback only records its outcome and wakes the loop; the tick
 * applies it. See specs/pull-runner "Prepare command", "Prepare failure" and "Prepare command and a task that left".
 */
import type { Id } from '../graph/model.js';
import type { Orchestrator } from '../loop/orchestrator.js';
import { abandonSpawn, removeOrRetryLater } from '../loop/tick.js';
import { StoreFatalError } from '../state/gate.js';
import type { Launch } from '../state/store.js';
import { runCheck } from '../verify/verifier.js';
import { parkLaunch, spawnLaunch } from './launch.js';

/** What a run of the prepare command gives back; the shape of `runCheck`'s result. */
export interface PrepareRunResult {
  code: number | null;
  timedOut: boolean;
  aborted?: boolean;
  spawnError?: boolean;
  output: string;
}

export type PrepareRunner = (command: string, cwd: string, opts: { timeoutMs: number; label: string; signal: AbortSignal }) => Promise<PrepareRunResult>;

/** The output tail kept from a run, as for the check command; the whole tail goes to the daemon log. */
export const PREPARE_OUTPUT_BYTES = 64 * 1024;
/** The output tail a `launch.prepareFailed` event carries. */
export const PREPARE_EVENT_OUTPUT_CHARS = 4096;
/** How long a command the daemon killed may take to close before its outcome is recorded anyway. */
export const PREPARE_CLOSE_WAIT_MS = 2000;
/** Dirty paths named in a `dirty` failure. */
export const PREPARE_DIRTY_NAMED = 10;

export type PrepareFailureReason = 'exit' | 'timeout' | 'killed' | 'spawn' | 'dirty';

export interface PrepareFailure {
  reason: PrepareFailureReason;
  exitCode: number | null;
  durationMs: number;
  output: string;
  dirty?: string[];
  error?: string;
}

export type PrepareOutcome = { kind: 'success'; durationMs: number; output: string } | { kind: 'failure'; failure: PrepareFailure } | { kind: 'aborted' };

/** The daemon's in-memory record of one running prepare command. */
export interface PrepareJob {
  launchId: string;
  taskId: Id;
  command: string;
  /** Fixed when the command starts: spawn for a `launching` row or `spawn` mode, park otherwise. */
  next: 'spawn' | 'park';
  startedAt: number;
  abort: AbortController;
  /** Resolves when the runner has been called, or the job reached its aborted outcome without a call. Never rejects. */
  started: Promise<void>;
  /** Resolves when the outcome is stored. Never rejects. */
  done: Promise<void>;
  outcome?: PrepareOutcome;
  /** The success was applied and the next step is spawn: the spawn pass spawns it. */
  ready?: boolean;
}

/** The outer shell's `$0`, so `killByLaunchId` finds the command by its launch id after a crash. */
export function prepareLabel(launchId: string): string {
  return `orch-prepare-${launchId}`;
}

/** Runs the command like the check command: `runCheck` in the worktree, killed by process group, bounded wait after a kill. */
export function defaultPrepareRunner(dataDir: string): PrepareRunner {
  return (command, cwd, opts) => runCheck(command, cwd, opts.timeoutMs, PREPARE_OUTPUT_BYTES, dataDir, { label: opts.label, signal: opts.signal, closeWaitMs: PREPARE_CLOSE_WAIT_MS });
}

/**
 * Start the prepare command for a launch whose worktree was just prepared. False when no command is set. Once `stop()`
 * has run it does nothing and returns true: the row stays for the next start. Otherwise, in one synchronous step, the
 * next step is fixed, `launch.prepareStarted` appended and the job recorded; the command runs without being awaited.
 */
export function startPrepareCommand(o: Orchestrator, launch: Launch): boolean {
  const command = o.config.prepareCommand;
  if (command === undefined) return false;
  if (o.stopping) return true;
  const { launchId, taskId } = launch;
  const next = launch.status === 'launching' || o.effectiveMode() === 'spawn' ? 'spawn' : 'park';
  const timeoutMs = o.config.prepareTimeoutMs;
  const startedAt = o.now();
  o.store.appendEvent({ kind: 'launch.prepareStarted', taskId, launchId, payload: { command, timeoutMs } }, startedAt);
  let markStarted: () => void = () => undefined;
  const job: PrepareJob = {
    launchId,
    taskId,
    command,
    next,
    startedAt,
    abort: new AbortController(),
    started: new Promise<void>((resolve) => (markStarted = resolve)),
    done: Promise.resolve(),
  };
  o.prepareJobs.set(launchId, job);
  job.done = runJob(o, job, launch.worktree, timeoutMs, markStarted);
  return true;
}

/** The command's own run. It touches only the job, the log and `wake()`: the tick applies the outcome. */
async function runJob(o: Orchestrator, job: PrepareJob, cwd: string, timeoutMs: number, markStarted: () => void): Promise<void> {
  const signal = job.abort.signal;
  try {
    // The row and the prepareStarted event are durable before anything runs in the worktree.
    await o.waitDurable();
    if (signal.aborted) {
      job.outcome = { kind: 'aborted' };
      return;
    }
    const run = o.prepareRunner(job.command, cwd, { timeoutMs, label: prepareLabel(job.launchId), signal });
    markStarted();
    const result = await run;
    const durationMs = o.now() - job.startedAt;
    o.log.info('prepare command ended', { taskId: job.taskId, launchId: job.launchId, code: result.code, timedOut: result.timedOut, aborted: Boolean(result.aborted || signal.aborted), durationMs, output: result.output });
    job.outcome = signal.aborted || result.aborted ? { kind: 'aborted' } : outcomeOf(result, durationMs);
  } catch (err) {
    if (err instanceof StoreFatalError || signal.aborted) {
      job.outcome = { kind: 'aborted' };
    } else {
      const error = err instanceof Error ? err.message : String(err);
      o.log.warn('prepare command could not be started', { taskId: job.taskId, launchId: job.launchId, err: error });
      job.outcome = { kind: 'failure', failure: { reason: 'spawn', exitCode: null, durationMs: o.now() - job.startedAt, output: '', error } };
    }
  } finally {
    markStarted();
    o.wake();
  }
}

function outcomeOf(r: PrepareRunResult, durationMs: number): PrepareOutcome {
  if (r.code === 0 && !r.timedOut && !r.spawnError) return { kind: 'success', durationMs, output: tailOf(r.output ?? '') };
  const reason: PrepareFailureReason = r.timedOut ? 'timeout' : r.spawnError ? 'spawn' : r.code === null ? 'killed' : 'exit';
  return { kind: 'failure', failure: { reason, exitCode: r.code, durationMs, output: tailOf(r.output ?? '') } };
}

function tailOf(text: string): string {
  return text.length > PREPARE_EVENT_OUTPUT_CHARS ? text.slice(text.length - PREPARE_EVENT_OUTPUT_CHARS) : text;
}

function inFlight(row: Launch | undefined): row is Launch {
  return row !== undefined && (row.status === 'preparing' || row.status === 'launching');
}

/** Whether the launch's task still runs on it. */
function runsOn(o: Orchestrator, row: Launch): boolean {
  const entry = o.entry(row.taskId);
  return entry.status.kind === 'running' && entry.lease?.launchId === row.launchId;
}

/**
 * One pass over the prepare jobs, by the tick, before admission. Each job is handled on its own: an error is logged and
 * the pass goes on, and the job is tried again on the next tick.
 */
export async function settlePrepareJobs(o: Orchestrator): Promise<void> {
  if (!o.prepareJobs.size) return;
  for (const job of [...o.prepareJobs.values()]) {
    try {
      await settleJob(o, job);
    } catch (err) {
      o.log.error('a prepare job could not be handled; tried again on the next tick', { taskId: job.taskId, launchId: job.launchId, err: String(err) });
    }
  }
}

async function settleJob(o: Orchestrator, job: PrepareJob): Promise<void> {
  const row = o.store.getLaunch(job.launchId);
  if (!inFlight(row)) {
    job.abort.abort();
    o.prepareJobs.delete(job.launchId);
    return;
  }
  if (!runsOn(o, row)) {
    // Cancelled, reset by a cascade, or superseded: the command is killed by its own handle, and once it has ended the
    // launch is ended and its worktree removed. No prepare failure is recorded.
    if (!job.abort.signal.aborted) job.abort.abort();
    if (!job.outcome) return;
    endLeftLaunch(o, row);
    o.prepareJobs.delete(job.launchId);
    await removeOrRetryLater(o, row);
    return;
  }
  // Applied already and waiting for the spawn pass (a paused run, a hold): nothing is tested or appended again.
  if (job.ready) return;
  if (!job.outcome) return;
  // Stopped, or the store went fatal: nothing is recorded, and the next start recovers the row.
  if (job.outcome.kind === 'aborted') return;
  if (job.outcome.kind === 'failure') {
    await abandonPrepare(o, row, job.outcome.failure);
    return;
  }
  const { durationMs, output } = job.outcome;
  // The worktree must be clean outside `.orchestrator/`: an install tree the repository does not ignore would be committed.
  let dirty: string[] | undefined;
  let error: string | undefined;
  try {
    const sealed = await o.workspace.seal(row);
    if (!sealed.ok) dirty = sealed.dirty.slice(0, PREPARE_DIRTY_NAMED);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  // The task can leave during the test: the next pass ends the launch.
  const current = o.store.getLaunch(job.launchId);
  if (!inFlight(current) || !runsOn(o, current) || o.prepareJobs.get(job.launchId) !== job) return;
  if (dirty !== undefined || error !== undefined) {
    await abandonPrepare(o, current, { reason: 'dirty', exitCode: 0, durationMs, output,...(dirty !== undefined ? { dirty } : {}), ...(error !== undefined ? { error } : {}) });
    return;
  }
  o.store.appendEvent({ kind: 'launch.prepared', taskId: job.taskId, launchId: job.launchId, payload: { command: job.command, durationMs } }, o.now());
  if (job.next === 'park') {
    parkLaunch(o, current);
    o.prepareJobs.delete(job.launchId);
    return;
  }
  job.ready = true;
}

/** End a launch whose task left it while its command ran: `cancelled` for a cancelled task, else `superseded`. */
function endLeftLaunch(o: Orchestrator, row: Launch): void {
  o.store.transaction(() => {
    const current = o.store.getLaunch(row.launchId);
    if (!current) return;
    o.endLaunch(current, o.entry(row.taskId).status.kind === 'cancelled' ? 'cancelled' : 'superseded');
  });
}

/**
 * Spawn the launches whose command succeeded and whose next step is spawn. Not during a pause or a hold. A launch whose
 * task left it stays in the map, and the next settle pass ends it. The lease is renewed for a full TTL first.
 */
export async function spawnPreparedLaunches(o: Orchestrator): Promise<void> {
  for (const job of [...o.prepareJobs.values()]) {
    if (!job.ready) continue;
    try {
      o.noteClock();
      if (o.inHold() || o.isPaused()) return;
      const row = o.store.getLaunch(job.launchId);
      if (!inFlight(row) || !runsOn(o, row)) continue;
      o.prepareJobs.delete(job.launchId);
      o.renewLease(row);
      try {
        await spawnLaunch(o, row);
      } catch (err) {
        await abandonSpawn(o, row, 'spawn', err);
      }
    } catch (err) {
      o.log.error('a prepared launch could not be spawned; tried again on the next tick', { taskId: job.taskId, launchId: job.launchId, err: String(err) });
    }
  }
}

/**
 * A prepare failure: the launch is ended with `prepareCommandFailed`, `launch.prepareFailed` appended, and the task
 * returned to `unstarted` with its attempts and carry unchanged, all in one transaction before any await. Killing what
 * is left of the command and removing the worktree are best effort; a worktree left behind is retried on later ticks.
 */
export async function abandonPrepare(o: Orchestrator, launch: Launch, failure: PrepareFailure): Promise<void> {
  const { launchId, taskId } = launch;
  const ended = o.store.transaction((): boolean => {
    const current = o.store.getLaunch(launchId);
    if (!current || current.status === 'ended' || current.status === 'revoked') return false;
    o.store.appendEvent({ kind: 'launch.prepareFailed', taskId, launchId, payload: { ...failure } }, o.now());
    o.endLaunch(current, 'prepareCommandFailed', { reason: failure.reason });
    const entry = o.entry(taskId);
    if (entry.status.kind === 'running' && entry.lease?.launchId === launchId) {
      o.transition(taskId, { kind: 'unstarted' }, 'orchestrator', 'prepareFailed', undefined, { launchId, reason: failure.reason });
    }
    return true;
  });
  o.prepareJobs.delete(launchId);
  if (!ended) return;
  const { output: _output, ...logged } = failure;
  o.log.warn('the prepare command failed; the launch is ended and the task launched again without spending an attempt', { taskId, launchId, ...logged });
  try {
    await o.runner.killByLaunchId(launchId);
  } catch (killErr) {
    o.log.warn('kill after a failed prepare command failed', { launchId, err: String(killErr) });
  }
  await removeOrRetryLater(o, launch);
}

/** Abort every prepare job and wait for each command to end, for no longer than `waitMs` in all. Nothing is applied. */
export async function stopPrepareJobs(o: Orchestrator, waitMs: number): Promise<void> {
  const jobs = [...o.prepareJobs.values()];
  if (!jobs.length) return;
  for (const job of jobs) job.abort.abort();
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([Promise.all(jobs.map((j) => j.done)), new Promise<void>((resolve) => (timer = setTimeout(resolve, waitMs)))]);
  clearTimeout(timer);
}
