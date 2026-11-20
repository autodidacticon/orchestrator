/**
 * The orchestrator: sole writer of the overlay. Agents and humans submit intents
 * (agentCall / operator methods); the tick applies transitions and drives launches.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { alwaysValid, type BriefValidator, noRemediation, type Remediator } from '../brief/validate.js';
import { renewEveryMsOf } from '../brief/compose.js';
import { scrubCarry } from '../brief/lost.js';
import { checkSubmission, optionalFullSha, remoteSealedSha } from '../agent/seal.js';
import { crashPoint } from '../crash.js';
import { commitPolicyOfKind, type Config, DEFAULT_CONTENDED_RETRIES, DEFAULT_GAP_AFTER_MS, DEFAULT_GAP_HOLD_MS, remoteAccessError, remoteVerifierError, RUNNER_ACCESSES, storeDurabilityWarning } from '../config.js';
import { type Gap, GapClock, noteIntervalMs } from '../health/gaps.js';
import { classifyReload, type ReloadReason } from '../graph/diff.js';
import { GraphValidationError, parseGraph } from '../graph/load.js';
import type { Graph, GraphNode, Id } from '../graph/model.js';
import * as q from '../graph/query.js';
import type { GraphSource } from '../graph/source.js';
import type { AgentRunner, RunnerFailure, TokenUsage, Usage } from '../runner/runner.js';
import {
  type AttemptContext,
  type BlockedReason,
  defaultEntry,
  type Entry,
  type FailedReason,
  type Overlay,
  type Question,
  type RevisionContext,
  type Status,
  type StatusKind,
  type InterruptedContext,
} from '../state/status.js';
import { git } from '../workspace/git.js';
import { accessOf, type Attachment, commitPolicyOf, type Launch, type RunnerMode, runIdOf, runnerOf, setRunId, type Store, type TrackerRecord, trackerOf, type VerifierJob } from '../state/store.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { CascadeStep } from '../graph/query.js';
import type { ReloadClassification } from '../graph/diff.js';
import { type Actor, applyTransition } from '../state/transitions.js';
import { NO_CLAIM, type VerifierBackend, VerifierStoppedError } from '../verify/job.js';
import { Origin, OriginConfigError, OriginFetchError } from '../workspace/origin.js';
import { RemoteWorkspace, workspaceByAccess } from '../workspace/remote-workspace.js';
import { gateOnDurable, RUNNER_METHODS, StoreFatalError, storeLag, VERIFIER_METHODS, waitDurable, WORKSPACE_METHODS } from '../state/gate.js';
import type { BriefInput, FallbackReport, SealResult, Workspace } from '../workspace/workspace.js';
import type { Logger, OrchestratorCore } from './core.js';
import { chainPolicy, type Deferral, type Policy } from './schedule.js';
import { pidAlive } from '../runner/subprocess.js';
import { runTick } from './tick.js';
import { clearPrepareRetry, defaultPrepareRunner, pendingPrepareRetries, type PrepareJob, type PrepareRunner, startPrepareCommand, stopPrepareJobs } from '../launch/prepare.js';
import { deriveEffects } from '../tracker/effects.js';
import { budgetOverrides, ceilingUsd, costByTask, elapsedMs, exceedsTimeBudget, priceFor, priceUsage, runCostUsd, tokensOf, unpricedLaunches } from '../health/budgets.js';
import { applyFingerprint, recordSignal } from '../health/progress.js';
import { FINGERPRINT_PATTERN } from '../workspace/fingerprint.js';
import { exceedsStuckFail, humanDiagnoser, idleMsOf, type StuckDiagnoser } from '../health/stuck.js';
import { applyOverridePatch, type ConfigReport, configSummary, type OverridableKey, type Overrides, readOverrides, reportOf, type Resolved, resolveLayers, type SetConfigResult, START_ONLY_KEYS, type WouldEnd } from '../runs/resolve.js';
import { codexNetworkAccess, type CommitPolicy, EFFORT_FALLBACK, type Effort, isEffort, isEffortFor, isModelNameFor, isRunnerKind, type OpenCodePermission, RUNNER_KINDS, type RunnerKind, type Selection, zeroByKind } from '../runner/selection.js';
import { isolationEnv } from '../runs/childEnv.js';
import { bashPatterns } from '../runner/opencode.js';
import { composeAllowedTools } from '../toolchain/tools.js';
import { sessionEndMatches } from '../runs/ancestry.js';
import type { ShutdownCaller } from '../runs/runDir.js';
import type { ToolchainRecord } from '../toolchain/detect.js';
import { PUSH_REFUSED, pushRetryDue, recordPushRetry } from '../verify/push-retry.js';
import { renewVerifyLeases, verifyJobChanged, wakeVerifyWaiters } from '../verify/claims.js';

/** The triggers that remove a task's prepare retry entry. See specs/pull-runner "Prepare failure limit". */
const PREPARE_RETRY_RESETS: ReadonlySet<string> = new Set(['unblock', 'reopen', 'uncancel', 'cascade']);

export const questionSchema = z.object({
  kind: z.enum(['needsDecision', 'needsAccess', 'impossible', 'dependencyCancelled', 'outOfScope', 'insufficientSpec', 'milestoneRejected']),
  message: z.string().min(1),
  options: z.array(z.string()).optional(),
});

/** A follow-up task an agent proposes; a human accepts it into the graph. See specs/agent-protocol "Proposals in the report". */
export const proposalSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  deps: z.array(z.string().min(1)).optional(),
  scope: z.array(z.string()).optional(),
  labels: z.array(z.string()).optional(),
});

export const submitBodySchema = z.object({
  summary: z.string().min(1),
  interfaces: z.array(z.string()).default([]),
  decisions: z.array(z.string()).default([]),
  deviations: z.array(z.string()).default([]),
  followUps: z.array(z.string()).default([]),
  tests: z.array(z.string()).default([]),
  acceptance: z.array(z.object({ criterion: z.string(), evidence: z.string() })).default([]),
  noChanges: z.object({ justification: z.string().min(1) }).optional(),
  proposals: z.array(proposalSchema).default([]),
});

// `.int()` admits 1e30; a count must be a safe integer. See specs/agent-protocol "Integer fields".
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/**
 * A 400 naming the field when an agent call's integer field is present and not a safe non-negative integer; undefined
 * otherwise. Checked before the call writes anything. See specs/agent-protocol "Integer fields".
 */
export function agentIntegerError(body: Record<string, unknown>): ApiResponse | undefined {
  const s = body['seq'];
  if (s === undefined) return undefined;
  if (typeof s === 'number' && Number.isSafeInteger(s) && s >= 0) return undefined;
  return { status: 400, body: { error: `seq must be a non-negative safe integer, got ${typeof s === 'number' ? String(s) : typeof s}`, field: 'seq' } };
}

/**
 * A 400 naming `fingerprint` when a remote launch's heartbeat carries one that is not `<full hex sha>:<hex hash>`;
 * undefined otherwise. Checked before the call writes anything. See specs/health-monitoring "Progress signals".
 */
export function heartbeatFingerprintError(body: Record<string, unknown>): ApiResponse | undefined {
  const fp = body['fingerprint'];
  if (fp === undefined || (typeof fp === 'string' && FINGERPRINT_PATTERN.test(fp))) return undefined;
  return { status: 400, body: { error: 'fingerprint must be a full hex head sha, a colon and a hex hash', field: 'fingerprint' } };
}

/** A 400 naming the first bad field of a worker usage body, or undefined when it parses. Checked before anything is written. */
export function workerUsageError(body: unknown): ApiResponse | undefined {
  const parsed = workerUsageBodySchema.safeParse(body);
  if (parsed.success) return undefined;
  const first = parsed.error.issues[0]!;
  return { status: 400, body: { ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), field: first.path.join('.') } };
}

/** The body of `POST /v1/launches/:id/usage`. See specs/pull-runner "Worker usage". */
export const workerUsageBodySchema = z.object({
  workerId: z.string().min(1),
  usage: z
    .object({
      tokens: z.object({ input: count, cachedInput: count.optional(), cacheWriteInput: count.optional(), output: count, reasoningOutput: count.optional() }).strict(),
      model: z.string().min(1).optional(),
      costUsd: z.number().nonnegative().optional(),
    })
    .strict(),
});

export type ReopenResult =
  | { ok: true; reset: CascadeStep[] }
  | { ok: false; reason: string; blockers?: Id[]; publishing?: Id };

/** How often a resolution pass for deferred verifier jobs is tried while origin cannot be fetched. */
const DEFERRED_RETRY_MS = 1000;
/** Failure kinds of a check run that a gap in the daemon's clock may have caused. See specs/integration-pipeline "Failed check across a gap". */
const GAP_REQUEUE_KINDS: ReadonlySet<string> = new Set(['checkFailed', 'checkTimeout']);

/**
 * The answer to a refused seal. A dirty worktree, a launch branch missing from origin, and another tip on origin than
 * the reported one answer 409; origin that cannot be fetched answers 503. See specs/agent-protocol "Submission sealing"
 * and specs/remote-workspace "Seal".
 */
export function sealRefusal(seal: Exclude<SealResult, { ok: true }>): ApiResponse {
  if ('dirty' in seal) return { status: 409, body: { error: 'dirtyWorktree', files: seal.dirty } };
  const { ok: _ok, ...detail } = seal;
  const status = seal.reason === 'branchNotPushed' || seal.reason === 'shaMismatch' ? 409 : 503;
  return { status, body: { error: seal.reason, ...detail } };
}

/** The inbox's answer to a caller that went away during its durable wait: nobody reads it, and nothing was removed. */
const INBOX_CALLER_GONE: ApiResponse = { status: 499, body: { error: 'the caller went away; the notices stay for the next read' } };

export { StoreFatalError };

/** Thrown by the verifier progress callback when its job was dropped mid-flight. */
export class JobDroppedError extends Error {
  constructor(public readonly jobId: string) {
    super(`job ${jobId} was dropped`);
    this.name = 'JobDroppedError';
  }
}

export const failBodySchema = z.object({
  tried: z.string().default(''),
  why: z.string().min(1),
  whatWouldUnblock: z.string().default(''),
});

export type AgentOp = 'heartbeat' | 'report' | 'block' | 'inbox' | 'log';

export interface ApiResponse {
  status: number;
  body: Record<string, unknown>;
}

export interface OrchestratorDeps {
  store: Store;
  config: Config;
  graphSource: GraphSource;
  runner: AgentRunner;
  workspace: Workspace;
  verifier: VerifierBackend;
  policy?: Policy;
  briefValidator?: BriefValidator;
  remediator?: Remediator;
  stuckDiagnoser?: StuckDiagnoser;
  clock?: () => number;
  log?: Logger;
  apiBaseUrl?: string;
  /** The boot-time resolution with its inputs; defaults to the config alone with no detection. See specs/toolchain-discovery. */
  resolved?: Resolved;
}

/** Where a task's model or effort comes from: its payload, or the kind's leaf. See specs/model-selection "Profile sources of a task". */
export type ProfileSource = 'task' | 'argument' | 'file' | 'default';
export type ProfileKey = 'model' | 'effort';
const PROFILE_KEYS: readonly ProfileKey[] = ['model', 'effort'];
/** At most this many task ids per `status.profiles` entry. */
const PROFILE_SAMPLE = 5;
type LeafSource = Exclude<ProfileSource, 'task'>;
interface KindFacts {
  modelSource: LeafSource;
  effortSource: LeafSource;
  modelApplied: boolean;
  effortApplied: boolean;
}
export interface ProfileContext {
  hold: boolean;
  mode: RunnerMode;
}
export interface TaskProfile {
  runner: RunnerKind;
  model: string;
  effort: Effort;
  modelSource: ProfileSource;
  effortSource: ProfileSource;
  /** The keys whose value would come from a built-in default while the hold is on; `model` before `effort`. */
  missing: ProfileKey[];
}
export interface ProfileEntry extends TaskProfile {
  held: boolean;
  tasks: number;
  sample: Id[];
}
export interface ProfileHeldEntry {
  runner: RunnerKind;
  missing: ProfileKey[];
  tasks: number;
}

export interface StatusReport {
  finished: boolean;
  stalled: boolean;
  paused: boolean;
  graphRev: string | undefined;
  graphRejected: { reasons: string[] } | undefined;
  byStatus: Record<StatusKind, Id[]>;
  external: Array<{ id: Id; done: boolean }>;
  stallRoots: Id[];
  awaitingReview: Id[];
  /** The tasks among `awaitingReview`: submitted and awaiting the verifier, not a human. */
  verifying: Id[];
  openQuestions: Id[];
  liveLaunches: Array<{
    launchId: string;
    taskId: Id;
    pid?: number;
    elapsedMs: number;
    progressAt?: number;
    lastSignal?: string;
    idleMs: number;
    stuck: boolean;
    costUsd?: number;
    tokens?: TokenUsage;
    /** Kept releases the task had absorbed when this launch was created. */
    interruptions: number;
    /** Fixed when the launch was prepared. See specs/model-selection. */
    runner: RunnerKind;
    model?: string;
    effort?: Effort;
  }>;
  /** Health: flagged tasks, why admission is paused, cost and the configured budgets. See specs/health-monitoring. */
  stuck: Id[];
  pausedReason: PausedReason | undefined;
  /** `unpricedLaunches`: launches with tokens and no cost, outside `runUsd`. See specs/health-monitoring "Run cost budget". */
  cost: { runUsd: number; byTask: Record<Id, number>; ceilingUsd: number | undefined; overrides: number; unpricedLaunches: number };
  tokens: { run: TokenUsage; byTask: Record<Id, TokenUsage> };
  budgets: { maxLaunchMs: number; maxRunCostUsd: number; stuckAfterMs: number; stuckFailAfterMs: number };
  foreignCommits: string[];
  runDir: string;
  graphPath: string;
  daemonPid: number;
  daemonUrl: string;
  /** The highest durable event sequence number, the cursor for /v1/events. See specs/state-backend "Durable cursor in the status". */
  latestSeq: number;
  /** How far the durable copy of the state trails the image. See specs/state-backend "Durability". */
  storeLagMs: number;
  storePendingBatches: number;
  /** Pending agent proposals awaiting a human. See specs/operator-control "Status report: proposals". */
  proposals: Array<{ id: string; taskId: Id; title: string }>;
  /** Pull runner: the mode in force, parked launches in claim order, and the workers holding launches. See specs/operator-control "Status report: workers". */
  runner: { mode: RunnerMode; claimWindowMs: number; confirmProfile: boolean };
  /** Every unstarted task's profile, grouped, with the hold's verdict. See specs/operator-control "Status report: profiles". */
  profiles: ProfileEntry[];
  claimable: Id[];
  /** Parked launches per runner kind, so a worker can tell whether any of them is for a CLI it runs. */
  claimableByKind: Record<RunnerKind, number>;
  /** Tasks whose launch is being prepared (`preparing` or `launching`), oldest first. See specs/operator-control "Status report: launches being prepared". */
  preparing: Id[];
  /** Unstarted tasks with a prepare retry entry, by `retryAt`, then task id. */
  prepareRetry: Array<{ taskId: Id; failures: number; retryAt: number }>;
  /** Per runner kind, the launches being prepared plus the tasks in `prepareRetry`; every kind present. */
  preparingByKind: Record<RunnerKind, number>;
  workers: Array<{ id: string; launchId: string; taskId: Id; claimedAt: number }>;
  /** Tracker sync: the recorded tracker, pending effects, and effects that failed at the retry cap. */
  tracker: TrackerRecord | undefined;
  outboxPending: number;
  trackerErrors: TrackerError[];
  /** Candidates skipped by the scope filter in the last admission pass; empty while paused. See specs/operator-control "Status report: deferred candidates". */
  deferred: Deferral[];
  /** The daemon's own life: quiescence, idle time, and the configured window. See specs/operator-control "Idle exit". */
  idle: { quiescent: boolean; idleMs: number; exitAfterMs: number };
  /** Live session attachments and the claimed launches each holds. See specs/operator-control "Session attachments". */
  attachments: Array<{ id: string; pids: number[]; since: number; launches: string[] }>;
  /** The effective configuration with provenance, the detection record, and the keys still unresolved. See specs/operator-control "Status report: configuration". */
  config: ConfigReport['config'];
  toolchain: ToolchainRecord | undefined;
  needsConfig: OverridableKey[];
}

export interface TrackerError {
  id: number;
  taskId: Id;
  kind: string;
  attempts: number;
  error: string | undefined;
}

export type PausedReason = 'operator' | 'costBudget';

const silentLog: Logger = { info() {}, warn() {}, error() {} };

interface Waiter {
  seq: number;
  resolve: (r: ApiResponse) => void;
}

export class Orchestrator implements OrchestratorCore {
  readonly store: Store;
  readonly config: Config;
  readonly runner: AgentRunner;
  readonly workspace: Workspace;
  readonly verifier: VerifierBackend;
  readonly policy: Policy;
  readonly briefValidator: BriefValidator;
  readonly remediator: Remediator;
  readonly stuckDiagnoser: StuckDiagnoser;
  readonly log: Logger;
  readonly graphSource: GraphSource;
  apiBaseUrl: string;
  foreignCommits: string[] = [];
  /** Set by the daemon entrypoint; the shutdown route calls it after responding. */
  requestShutdown: ((reason: 'idle' | 'stop', reap?: boolean, by?: ShutdownCaller) => void) | undefined;
  /** Set by the daemon entrypoint: rewrites config.json after an accepted override. */
  onConfigChanged: ((report: ConfigReport) => void) | undefined;
  /** The boot-time resolution; `effective()` re-applies the durable overrides over its inputs. */
  private readonly boot: Resolved;
  private configMemo: { key: string; resolved: Resolved } | undefined;
  /** Per-kind model and effort facts, keyed on the same override text as `configMemo`. */
  private kindFactsMemo: { key: string; facts: Map<RunnerKind, KindFacts> } | undefined;
  private readonly heldJobsLogged = new Set<string>();
  /**
   * Jobs recovery could not decide because origin could not be fetched: kept off the verifier and decided by a
   * later resolution pass. See specs/crash-recovery "Origin lookup before commit lost".
   */
  readonly deferredJobs = new Set<string>();
  /**
   * Launch ids whose worktree removal after an applied verifier job left it behind; drainVerification retries each on
   * every tick until it is gone. See specs/integration-pipeline "Worktree removal on publish".
   */
  readonly pendingRemovals = new Set<string>();
  /**
   * Launch branches and commits startup recovery found missing from the clone (a fresh clone). No brief names them.
   * See specs/crash-recovery "Context naming lost work".
   */
  readonly lostRefs = new Set<string>();
  private deferredTriedAt = Number.NEGATIVE_INFINITY;
  /** The integration branch's remote when `git.pushIntegration` is on; shared by the workspace and the verifier. */
  readonly origin: Origin | undefined;
  /** Models already warned about as having tokens but no price. */
  private readonly unpricedModelsLogged = new Set<string>();
  /** The inbox read in progress per launch; see `handleInbox`. */
  private readonly inboxReads = new Map<string, Promise<void>>();

  private readonly clock: () => number;
  private _graph: Graph | undefined;
  private _deferred: Deferral[] = [];
  /** Idle exit accounting. See specs/operator-control "Idle exit". */
  private readonly startedAt: number;
  private lastActivityAt: number;
  private inFlightRequests = 0;
  private _graphRejected: { reasons: string[] } | undefined;
  private readonly waiters = new Map<string, Waiter[]>();
  private verifierInFlight: Promise<void> | undefined;
  private wakeResolve: (() => void) | undefined;
  private timer: NodeJS.Timeout | undefined;
  /** Gaps in the daemon's clock and the hold after one. See specs/health-monitoring "Gap in the daemon's clock". */
  private readonly gapClock: GapClock;
  private noteTimer: NodeJS.Timeout | undefined;
  /** Set by `stop()` and idle exit; read by the prepare command, which starts nothing once it is set. */
  stopping = false;
  /** Prepare commands running, by launch id; memory only. See specs/pull-runner "Prepare command". */
  readonly prepareJobs = new Map<string, PrepareJob>();
  /** Runs a prepare command; tests replace it. */
  prepareRunner: PrepareRunner;
  /** How long `stop()` waits for the prepare commands it aborted, in all. */
  prepareStopWaitMs = 5000;
  private ticking: Promise<void> | undefined;

  constructor(deps: OrchestratorDeps) {
    this.store = deps.store;
    this.config = deps.config;
    // Durability before effects: every call out waits until what was committed before it is durable. See specs/state-backend.
    // Origin as the source of truth: one shared remote for the workspace and the verifier. See specs/integration-pipeline "Origin as source of truth".
    const origin = this.config.git.pushIntegration
      ? new Origin({ repo: this.config.repoPath, integrationBranch: this.config.integrationBranch, url: this.config.git.originUrl, fetchIntervalMs: this.config.git.fetchIntervalMs, remoteTimeoutMs: this.config.git.remoteTimeoutMs })
      : undefined;
    (deps.workspace as { useOrigin?: (o: Origin | undefined) => void }).useOrigin?.(origin);
    (deps.verifier as { useOrigin?: (o: Origin | undefined) => void }).useOrigin?.(origin);
    this.origin = origin;
    this.runner = gateOnDurable(this.store, deps.runner, RUNNER_METHODS);
    // Launch-side calls go to the workspace of the launch's access; the clone's own workspace keeps the integration branch. See specs/remote-workspace.
    // A remote launch is sealed through origin. See specs/remote-workspace "Seal".
    this.workspace = gateOnDurable(this.store, workspaceByAccess(deps.workspace, new RemoteWorkspace(origin)), WORKSPACE_METHODS);
    this.verifier = gateOnDurable(this.store, deps.verifier, VERIFIER_METHODS);
    this.graphSource = deps.graphSource;
    this.policy = deps.policy ?? chainPolicy(this.config);
    this.briefValidator = deps.briefValidator ?? alwaysValid;
    this.remediator = deps.remediator ?? noRemediation;
    this.stuckDiagnoser = deps.stuckDiagnoser ?? humanDiagnoser;
    this.clock = deps.clock ?? (() => Date.now());
    this.log = deps.log ?? silentLog;
    this.apiBaseUrl = deps.apiBaseUrl ?? 'http://127.0.0.1:0';
    this.boot = deps.resolved ?? resolveLayers({ base: this.config });
    this.prepareRunner = defaultPrepareRunner(this.config.dataDir);
    this.startedAt = this.now();
    this.lastActivityAt = this.startedAt;
    // The gap rule is read at start. Gaps an earlier process wrote count towards awake time from the first reading on;
    // they set no hold. Time during which no daemon process ran is not a gap.
    this.gapClock = new GapClock(this.config.health.gapAfterMs ?? DEFAULT_GAP_AFTER_MS, this.config.health.gapHoldMs ?? DEFAULT_GAP_HOLD_MS);
    if (this.gapClock.enabled) this.gapClock.load(this.store.listEvents({ kind: 'daemon.gap' }).map((e) => ({ from: Number(e.payload?.['from']), to: Number(e.payload?.['to']) })));
    if (!runIdOf(this.store)) setRunId(this.store, randomUUID().slice(0, 16));
  }

  // ---- gaps in the daemon's clock (specs/health-monitoring "Gap in the daemon's clock", "Hold after a gap") ----

  /** Take a note of the clock; memory only. Returns the gap it found, if any. */
  noteClock(): Gap | undefined {
    return this.gapClock.note(this.now());
  }

  /** The time between two instants less the parts inside gaps noted so far, written or not. */
  awakeMs(from: number, to: number): number {
    return this.gapClock.awakeMs(from, to);
  }

  /** Whether nothing may start: inside `health.gapHoldMs` after the end of the latest gap this process noted. Notes the clock first. */
  inHold(): boolean {
    const now = this.now();
    this.gapClock.note(now);
    return this.gapClock.inHold(now);
  }

  /**
   * Write the gaps noted since the last write, in one transaction: one `daemon.gap` event per gap at its end, a fresh
   * lease for every live launch holding a running or waiting task, and the latest gap's end as activity for idle exit.
   * The renewal is not progress: `progressAt`, `lastSignal`, `progressText` and `stuckSince` stay, and no other event
   * is appended. A no-op when nothing is pending. See specs/pull-runner "Lease renewal after a gap".
   */
  recordGaps(): void {
    const pending = [...this.gapClock.pending()];
    if (!pending.length) return;
    this.store.transaction(() => {
      for (const g of pending) this.store.appendEvent({ kind: 'daemon.gap', payload: { from: g.from, to: g.to, gapMs: g.gapMs, holdUntil: g.holdUntil } }, g.to);
      for (const l of this.store.listLaunches({ status: 'live' })) this.renewLease(l);
      renewVerifyLeases(this);
    });
    this.gapClock.written(pending.length);
    this.lastActivityAt = Math.max(this.lastActivityAt, pending.at(-1)!.to);
    for (const g of pending) this.log.warn('the daemon did not run for a while; the gap is left out of limits and leases', { from: g.from, to: g.to, gapMs: g.gapMs, holdUntil: g.holdUntil });
  }

  /** Arm the note timer: every second, or a quarter of `health.gapAfterMs` when shorter. A note that finds a gap wakes the loop. */
  armNoteTimer(): void {
    this.clearNoteTimer();
    if (!this.gapClock.enabled) return;
    this.noteTimer = setInterval(() => {
      if (this.noteClock()) this.wake();
    }, noteIntervalMs(this.gapClock.gapAfterMs));
    this.noteTimer.unref?.();
  }

  clearNoteTimer(): void {
    if (this.noteTimer) clearInterval(this.noteTimer);
    this.noteTimer = undefined;
  }

  // ---- idle exit (specs/operator-control "Idle exit") ----

  /** Nothing a tick would act on: no launch preparing, launching, live, or due to spawn; no verifier job unapplied; no pending cascade. */
  quiescent(): boolean {
    if (this.store.listLaunches({ status: ['preparing', 'launching', 'live'] }).length) return false;
    // In spawn and mixed modes a parked launch will be spawned by a tick, now or after the window; in pull mode it waits for a worker and is durable.
    if (this.effectiveMode() !== 'pull' && this.store.listLaunches({ status: 'claimable' }).length) return false;
    if (this.store.listJobs({ applied: false }).length) return false;
    if (this.pendingCascade()) return false;
    // A task waiting out a prepare retry will be launched by a tick, whatever its retryAt says. See specs/pull-runner "Prepare failure limit".
    if (this.config.prepareCommand !== undefined && pendingPrepareRetries(this).length) return false;
    return true;
  }

  requestBegan(): void {
    this.inFlightRequests++;
  }

  /** A probe (`GET /v1/status?probe=1`) never counts as activity. */
  requestEnded(probe: boolean): void {
    this.inFlightRequests = Math.max(0, this.inFlightRequests - 1);
    if (!probe) this.lastActivityAt = this.now();
  }

  /** After every tick: a non-quiescent tick, or an attached session while exitWhileAttached is off, is activity. */
  noteTickEnded(): void {
    if (!this.quiescent() || (this.attached() && !this.config.daemon.exitWhileAttached)) this.lastActivityAt = this.now();
  }

  idleMs(): number {
    if (this.inFlightRequests > 0 || !this.quiescent()) return 0;
    if (this.attached() && !this.config.daemon.exitWhileAttached) return 0;
    // A gap is activity, written or not, and nothing is idle while its hold is on. See specs/health-monitoring "Hold after a gap".
    if (this.inHold()) return 0;
    const since = Math.max(this.lastActivityAt, this.gapClock.lastGapEnd() ?? Number.NEGATIVE_INFINITY);
    return Math.max(0, this.now() - since);
  }

  idleExitDue(): boolean {
    const window = this.config.daemon.idleExitMs;
    return window > 0 && this.idleMs() >= window;
  }

  // ---- session attachments (specs/operator-control "Session attachments") ----

  /** Register or refresh a session's attachment; `attachment.started` on first sight or after an end. */
  attach(a: { id: string; pids: number[] }): void {
    const existing = this.store.listAttachments().find((x) => x.id === a.id);
    const now = this.now();
    this.store.transaction(() => {
      if (!existing || existing.ended) this.store.appendEvent({ kind: 'attachment.started', payload: { id: a.id, pids: a.pids } }, now);
      this.store.putAttachment({ id: a.id, pids: a.pids, since: existing && !existing.ended ? existing.since : now });
    });
  }

  endAttachment(id: string, reason: string): boolean {
    const a = this.store.listAttachments().find((x) => x.id === id);
    if (!a || a.ended) return false;
    this.store.putAttachment({ ...a, ended: { at: this.now(), reason } });
    this.wake();
    return true;
  }

  /**
   * End every live attachment that a session end's chain belongs to. `pids` is the hook's chain: its own pid, then
   * its ancestors. An attachment matches when the nearest posted pid that is also in its chain is the hook's parent or
   * grandparent (`pids[1]` or `pids[2]`); pid 1 never matches. A session nested further down the tree (under a shell
   * or another process) therefore leaves its outer session attached. See specs/operator-control "Session attachments".
   */
  endAttachmentsByPids(pids: number[], reason: string): string[] {
    const ended: string[] = [];
    for (const a of this.store.listAttachments()) {
      if (a.ended || !sessionEndMatches(pids, a.pids)) continue;
      this.store.putAttachment({ ...a, ended: { at: this.now(), reason } });
      ended.push(a.id);
    }
    if (ended.length) this.wake();
    return ended;
  }

  isLiveAttachment(id: string): boolean {
    const a = this.store.listAttachments().find((x) => x.id === id);
    return Boolean(a && !a.ended);
  }

  /** Live attachments with the claimed launches each holds. */
  attachments(): Array<{ id: string; pids: number[]; since: number; launches: string[] }> {
    const live = this.store.listLaunches({ status: 'live' });
    return this.store
      .listAttachments()
      .filter((a) => !a.ended)
      .map((a) => ({ id: a.id, pids: a.pids, since: a.since, launches: live.filter((l) => l.worker?.attachment === a.id).map((l) => l.launchId) }));
  }

  /** A session is attached while some live attachment's own process is alive. */
  attached(): boolean {
    return this.store.listAttachments().some((a) => !a.ended && a.pids[0] !== undefined && pidAlive(a.pids[0]));
  }

  /** Attachments found dead or ended: release their launches with keep, then forget them. Runs at reconcile. */
  async sweepAttachments(): Promise<void> {
    const all: Attachment[] = this.store.listAttachments();
    if (!all.length) return;
    for (const a of all) {
      if (!a.ended && !(a.pids[0] !== undefined && pidAlive(a.pids[0]))) this.endAttachment(a.id, 'processDead');
    }
    for (const a of this.store.listAttachments()) {
      if (!a.ended) continue;
      for (const l of this.store.listLaunches({ status: 'live' })) {
        if (l.worker?.attachment !== a.id) continue;
        await this.release(l.launchId, `session ended (${a.ended.reason})`, { keep: true, reasonCode: 'sessionEnded' });
      }
      this.store.transaction(() => {
        this.store.appendEvent({ kind: 'attachment.ended', payload: { id: a.id, pids: a.pids, reason: a.ended?.reason, since: a.since } }, this.now());
        this.store.deleteAttachment(a.id);
      });
    }
  }

  // ---- OrchestratorCore ----

  now(): number {
    return this.clock();
  }

  graph(): Graph {
    if (!this._graph) throw new Error('graph not loaded');
    return this._graph;
  }

  hasGraph(): boolean {
    return this._graph !== undefined;
  }

  graphRev(): string {
    return this.graph().rev;
  }

  graphRejected(): { reasons: string[] } | undefined {
    return this._graphRejected;
  }

  requireNode(id: Id): GraphNode {
    const n = this.graph().nodes.get(id);
    if (!n) throw new Error(`unknown node ${id}`);
    return n;
  }

  entry(id: Id): Entry {
    return this.store.getEntry(id) ?? defaultEntry(this.now());
  }

  /** The runner mode in force: the durable override, else the configured mode. See specs/pull-runner "Runner modes". */
  effectiveMode(): RunnerMode {
    const override = this.store.getKv('runner.mode');
    return override === 'spawn' || override === 'pull' || override === 'mixed' ? override : this.config.runner.mode;
  }

  setMode(mode: RunnerMode): void {
    this.store.transaction(() => {
      this.operatorEvent('mode', undefined, { mode });
      this.store.setKv('runner.mode', mode);
    });
    this.wake();
  }

  // ---- configuration (specs/toolchain-discovery "Runtime overrides and start-only keys") ----

  /** The effective configuration: the boot resolution with the store's override document applied; memoised until the document changes. */
  effective(): Resolved {
    const key = this.store.getKv('config.overrides') ?? '';
    if (this.configMemo?.key === key) return this.configMemo.resolved;
    const resolved = resolveLayers(this.boot.inputs, readOverrides(this.store));
    this.configMemo = { key, resolved };
    return resolved;
  }

  /** The record shape shared by `status`, `GET /v1/config`, and config.json. */
  configReport(): ConfigReport {
    return reportOf(this.effective(), this.now());
  }

  /**
   * Apply an override patch: the whole patch is validated first, a start-only key
   * refuses it whole, and the accepted document is written with its `operator.config`
   * event in one transaction, followed by `config.resolved`, the hook, and a wake.
   */
  setConfig(patch: unknown, opts: { endLive?: boolean } = {}): SetConfigResult {
    // The flat model and effort bind to the kind in force once the patch applies. See specs/toolchain-discovery "Runtime overrides and start-only keys".
    const parsed = applyOverridePatch(this.boot.inputs, readOverrides(this.store), patch ?? {});
    if (!parsed.ok) return { ok: false, status: 400, key: parsed.key, error: `${parsed.key || 'config'}: ${parsed.error}` };
    // Applied keys are named as the caller sent them: a flat model stays `model` though it is stored under its kind.
    const doc = (patch ?? {}) as Record<string, unknown>;
    const keys = Object.keys(doc).filter((k) => doc[k] !== undefined) as OverridableKey[];
    const startOnly = keys.filter((k) => START_ONLY_KEYS.includes(k));
    if (startOnly.length) return { ok: false, status: 409, startOnly, error: `${startOnly.join(', ')} is start-only: pass it to start, which applies it when the daemon is spawned` };
    const next = parsed.next;
    const endLive = opts.endLive === true;
    // A confirmation with nothing to confirm stores nothing.
    if (endLive && !keys.length) return { ok: true, applied: [], report: this.configReport() };
    if (!endLive) {
      const wouldEnd = this.wouldEnd(next);
      if (wouldEnd.length) {
        const named = wouldEnd.map((w) => (w.limit === 'budgets.maxLaunchMs' ? `${w.taskId} (launch ${w.launchId}, ${w.elapsedMs}ms elapsed, budgets.maxLaunchMs ${w.value})` : `${w.taskId} (launch ${w.launchId}, ${w.idleMs}ms idle, health.stuckFailAfterMs ${w.value})`));
        return {
          ok: false,
          status: 409,
          wouldEnd,
          error: `this change would end the live launch of ${named.join('; ')} on the next tick, spending an attempt and losing uncommitted work; nothing was applied: send it again with endLive true (configure endLive, orchestrator-ctl config --end-live) to end them, or choose a value they are within`,
        };
      }
    }
    // Built after every refusal, so a refused patch tells no worker anything.
    const notices = this.limitNotices(next);
    this.store.transaction(() => {
      this.operatorEvent('config', undefined, { patch: parsed.patch, overrides: next, ...(endLive ? { endLive: true } : {}) });
      this.store.setKv('config.overrides', JSON.stringify(next));
      // Written with the document: no worker is told of a limit that is not in force.
      for (const n of notices) this.queueNotice(n.launchId, n.notice);
    });
    const report = this.configReport();
    this.store.appendEvent({ kind: 'config.resolved', payload: configSummary(report) }, this.now());
    this.onConfigChanged?.(report);
    this.wake();
    return { ok: true, applied: keys, report };
  }

  /**
   * The `nudge` notices with `source: 'config'` that a change of the three runtime limits sends, one per affected launch:
   * a `live` or `launching` launch that holds the lease of a `running` or `waiting` task, and a `claimable` launch, whose
   * brief was written before the change. Values in force are compared, not patch keys, so a patch that changes none of
   * the three sends nothing. See specs/agent-protocol "Limit change notice".
   */
  private limitNotices(next: Overrides): Array<{ launchId: string; notice: { kind: string; [k: string]: unknown } }> {
    const values = (c: Config) => ({ 'budgets.maxLaunchMs': c.budgets.maxLaunchMs, 'health.stuckAfterMs': c.health.stuckAfterMs, 'health.stuckFailAfterMs': c.health.stuckFailAfterMs });
    const was = values(this.effective().config);
    const will = values(resolveLayers(this.boot.inputs, next).config);
    const changed = (Object.keys(will) as Array<keyof typeof will>).filter((k) => will[k] !== was[k]);
    if (!changed.length) return [];
    const limits = { budgets: { maxLaunchMs: will['budgets.maxLaunchMs'] }, health: { stuckAfterMs: will['health.stuckAfterMs'], stuckFailAfterMs: will['health.stuckFailAfterMs'] } };
    // The elapsed time leaves out a sleep since the last tick, as the time budget check does.
    this.noteClock();
    const now = this.now();
    const affected = this.store.listLaunches({ status: ['live', 'launching', 'claimable'] }).filter((l) => {
      if (l.status === 'claimable') return true;
      const entry = this.entry(l.taskId);
      return (entry.status.kind === 'running' || entry.status.kind === 'waiting') && entry.lease?.launchId === l.launchId;
    });
    return affected.map((l) => {
      const elapsed = elapsedMs(l, now, this);
      const lines = changed.map((k) => `${k} ${was[k]}ms -> ${will[k]}ms${k === 'budgets.maxLaunchMs' ? ` (this launch has run ${elapsed}ms of it)` : ''}`);
      const message = `The operator changed a limit of this run: ${lines.join('; ')}. 0 means the limit is off. This replaces what your brief states for ${changed.join(' and ')}.`;
      return { launchId: l.launchId, notice: { kind: 'nudge', source: 'config', message, changed, limits } };
    });
  }

  /**
   * The live launches of running tasks that the limits under `next` end now and the limits in force do not, once per
   * limit. Reads the store only, through the comparisons the checks use. See specs/operator-control "Configuration
   * route: a change that would end a live launch".
   */
  private wouldEnd(next: Overrides): WouldEnd[] {
    const before = this.effective().config;
    const after = resolveLayers(this.boot.inputs, next).config;
    const was = { budget: before.budgets.maxLaunchMs, fail: before.health.stuckFailAfterMs };
    const will = { budget: after.budgets.maxLaunchMs, fail: after.health.stuckFailAfterMs };
    // Only these two limits end a launch; a changed health.stuckAfterMs only flags one.
    if (was.budget === will.budget && was.fail === will.fail) return [];
    // A sleep since the last tick is a gap, left out of both times, as at the checks.
    this.noteClock();
    const now = this.now();
    const out: WouldEnd[] = [];
    for (const l of this.store.listLaunches({ status: 'live' })) {
      const entry = this.entry(l.taskId);
      if (entry.status.kind !== 'running' || entry.lease?.launchId !== l.launchId) continue;
      const cur = this.store.getLaunch(l.launchId) ?? l;
      const elapsed = elapsedMs(cur, now, this);
      if (exceedsTimeBudget(elapsed, will.budget) && !exceedsTimeBudget(elapsed, was.budget)) out.push({ taskId: cur.taskId, launchId: cur.launchId, limit: 'budgets.maxLaunchMs', value: will.budget, elapsedMs: elapsed });
      const idle = idleMsOf(cur, now, this);
      if (exceedsStuckFail(idle, will.fail) && !exceedsStuckFail(idle, was.fail)) out.push({ taskId: cur.taskId, launchId: cur.launchId, limit: 'health.stuckFailAfterMs', value: will.fail, idleMs: idle });
    }
    return out;
  }

  overlay(): Overlay {
    return this.store.allEntries();
  }

  /** The last admission pass's deferrals, kept for status. */
  setDeferred(deferred: Deferral[]): void {
    this._deferred = deferred;
  }

  recordTransition(id: Id, from: StatusKind, to: StatusKind, actor: Actor, trigger: string, extra: Record<string, unknown> = {}): number {
    const seq = this.store.appendEvent({ kind: 'transition', taskId: id, payload: { from, to, actor, trigger, ...extra } }, this.now());
    this.log.info(`transition ${id}: ${from} -> ${to} (${actor}/${trigger})`, extra);
    this.deriveTrackerEffects(id, from, to, actor, trigger, seq, extra);
    return seq;
  }

  /** Tracker-bound effects for a transition, inserted in the caller's transaction. See specs/tracker-sync. */
  private deriveTrackerEffects(id: Id, from: StatusKind, to: StatusKind, actor: Actor, trigger: string, seq: number, extra: Record<string, unknown>): void {
    if (!this._graph) return;
    const node = this._graph.nodes.get(id);
    if (!node) return;
    const effects = deriveEffects(
      { graph: this._graph, store: this.store, config: this.config, runId: runIdOf(this.store) ?? 'run', now: this.now() },
      { id, node, from, to, actor, trigger, entry: this.entry(id), seq, extra },
    );
    for (const e of effects) this.store.insertOutbox(e);
  }

  /** Effective payload: node payload merged with any remediation overlay for the current rev. */
  payloadOf(node: GraphNode): Record<string, unknown> {
    const overlay = this.store.getPayloadOverlay(node.id, this.graphRev());
    return overlay ? { ...node.payload, ...overlay } : { ...node.payload };
  }

  /**
   * The task's runner selector over the run kind in force, then the model and effort selectors over that
   * kind's own defaults. The graph validated the selectors' shape at load; the effort is checked against the
   * kind's set before its fallback applies (claude-code `ultra -> max`), and `effortRequested` records the
   * value asked for when it differed. See specs/model-selection.
   */
  selectionFor(taskId: Id): Selection {
    return this.selectionOf(taskId).selection;
  }

  /** `selectionFor`, and whether its model and effort came from the task's payload. See specs/model-selection "Profile sources of a task". */
  private selectionOf(taskId: Id): { selection: Selection; modelFromTask: boolean; effortFromTask: boolean } {
    const payload = this.payloadOf(this.requireNode(taskId));
    const eff = this.effective();
    const runner: RunnerKind = isRunnerKind(payload['runner']) ? payload['runner'] : eff.kind.value;
    const defaults = runner === 'codex' ? eff.config.runner.codex : runner === 'opencode' ? eff.config.runner.opencode : eff.config.runner.claude;
    const asked = isEffort(payload['effort']);
    const requested: Effort = asked ? (payload['effort'] as Effort) : defaults.effort;
    const fallback = EFFORT_FALLBACK[runner]?.[requested];
    const fits = isEffortFor(runner, requested);
    const fallsBack = !fits && fallback !== undefined && isEffortFor(runner, fallback);
    const effort: Effort = fits ? requested : fallsBack ? fallback : defaults.effort;
    // A model of another kind's shape (a `provider/model` under claude-code or codex) is not bound; the kind's default applies.
    const modelFromTask = isModelNameFor(runner, payload['model']);
    return {
      selection: {
        runner,
        model: modelFromTask ? (payload['model'] as string) : defaults.model,
        effort,
        ...(effort !== requested ? { effortRequested: requested } : {}),
      },
      modelFromTask,
      effortFromTask: asked && (fits || fallsBack),
    };
  }

  // ---- profile hold (specs/model-selection "Profile hold at admission") ----

  /** The profile hold in force: the stored choice (kv `runner.confirmProfile` `on` or `off`), else the configured key. See specs/operator-control "Profile hold key". */
  confirmProfile(): boolean {
    const stored = this.store.getKv('runner.confirmProfile');
    return stored === 'on' ? true : stored === 'off' ? false : this.config.runner.confirmProfile;
  }

  /** The sources and slots of one kind's model and effort leaves; memoised on the override document, like `effective()`. */
  private kindFacts(kind: RunnerKind): KindFacts {
    const key = this.store.getKv('config.overrides') ?? '';
    if (this.kindFactsMemo?.key !== key) this.kindFactsMemo = { key, facts: new Map() };
    let facts = this.kindFactsMemo.facts.get(kind);
    if (!facts) {
      // A stored document holds no flat model or effort, so forcing the kind reads that kind's own leaves.
      const r = resolveLayers(this.boot.inputs, { ...readOverrides(this.store), runnerKind: kind });
      facts = {
        modelSource: r.provenance.model as LeafSource,
        effortSource: r.provenance.effort as LeafSource,
        modelApplied: r.model.applied,
        effortApplied: r.effort.applied,
      };
      this.kindFactsMemo.facts.set(kind, facts);
    }
    return facts;
  }

  /** The hold and the mode, read once per view and never memoised. */
  private profileContext(): ProfileContext {
    return { hold: this.confirmProfile(), mode: this.effectiveMode() };
  }

  /** The profile a launch of the task would be prepared with, the source of each key, and the keys missing under the hold. */
  profileOf(taskId: Id, ctx: ProfileContext = this.profileContext()): TaskProfile {
    const { selection, modelFromTask, effortFromTask } = this.selectionOf(taskId);
    const facts = this.kindFacts(selection.runner);
    const modelSource: ProfileSource = modelFromTask ? 'task' : facts.modelSource;
    const effortSource: ProfileSource = effortFromTask ? 'task' : facts.effortSource;
    // A key the kind's template has no slot for does not reach a spawned agent; a claimed launch carries it, so pull and mixed ignore the slot.
    const lacks = (source: ProfileSource, applied: boolean) => ctx.hold && source === 'default' && !(ctx.mode === 'spawn' && !applied);
    const missing: ProfileKey[] = [];
    if (lacks(modelSource, facts.modelApplied)) missing.push('model');
    if (lacks(effortSource, facts.effortApplied)) missing.push('effort');
    return { runner: selection.runner, model: selection.model, effort: selection.effort, modelSource, effortSource, missing };
  }

  /** Whether the task is held at admission: the hold is on, it is unstarted, and a key is missing. */
  hasHeldProfile(taskId: Id, ctx: ProfileContext = this.profileContext()): boolean {
    if (!ctx.hold) return false;
    if (this.entry(taskId).status.kind !== 'unstarted') return false;
    return this.profileOf(taskId, ctx).missing.length > 0;
  }

  /** Every unstarted task's profile, grouped, ordered by each group's first task in graph order. See specs/operator-control "Status report: profiles". */
  profiles(): ProfileEntry[] {
    if (!this.hasGraph()) return [];
    const ctx = this.profileContext();
    const groups = new Map<string, ProfileEntry>();
    for (const node of this.graph().nodes.values()) {
      if (node.kind !== 'task' || this.entry(node.id).status.kind !== 'unstarted') continue;
      const p = this.profileOf(node.id, ctx);
      const key = JSON.stringify([p.runner, p.model, p.effort, p.modelSource, p.effortSource]);
      const entry = groups.get(key);
      if (entry) {
        entry.tasks++;
        if (entry.sample.length < PROFILE_SAMPLE) entry.sample.push(node.id);
      } else {
        groups.set(key, { ...p, held: p.missing.length > 0, tasks: 1, sample: [node.id] });
      }
    }
    return [...groups.values()];
  }

  /** The wait digest's view: one entry per runner kind with a held task. See specs/operator-mcp "Wait digest: profileHeld". */
  profileHeld(profiles: ProfileEntry[] = this.profiles()): ProfileHeldEntry[] {
    const byKind = new Map<RunnerKind, ProfileHeldEntry>();
    // A group's tasks share their missing keys, so each kind's first held group holds its first held task.
    for (const p of profiles) {
      if (!p.held) continue;
      const entry = byKind.get(p.runner) ?? { runner: p.runner, missing: [], tasks: 0 };
      entry.tasks += p.tasks;
      entry.missing = PROFILE_KEYS.filter((k) => entry.missing.includes(k) || p.missing.includes(k));
      byKind.set(p.runner, entry);
    }
    return [...byKind.values()];
  }

  commitPolicyFor(kind: RunnerKind): CommitPolicy {
    const eff = this.effective();
    // Only codex derives its policy (from the sandbox); the other kinds read their own `commit` leaf.
    return commitPolicyOfKind(eff.config, kind);
  }

  /**
   * Seal a submission under the launch's commit policy: `agent` refuses a dirty
   * worktree, `daemon` commits it as the orchestrator with the report summary as
   * the message. A remote launch is sealed against the `sealedSha` its worker reported, through origin; the commit
   * policy does not apply because the daemon holds no tree. See specs/agent-protocol "Submission sealing" and
   * specs/remote-workspace "Seal".
   */
  async sealSubmission(launch: Launch, summary: unknown, sealedSha?: string): Promise<SealResult> {
    if (accessOf(launch) === 'remote') return this.workspace.seal(launch, { sealedSha });
    if (commitPolicyOf(launch) !== 'daemon') return this.workspace.seal(launch);
    const message = typeof summary === 'string' && summary.trim() ? summary : `${launch.taskId}: work committed by the orchestrator at submit`;
    return this.workspace.seal(launch, { autoCommit: { message } });
  }

  /** Seal a fallback submit into its body before `applyFallback`, which cannot await. */
  async sealFallback(launch: Launch, fb: FallbackReport): Promise<void> {
    if (fb.kind !== 'submit') return;
    const seal = await this.sealSubmission(launch, fb.body['summary']);
    if (seal.ok) fb.body = { ...fb.body, __sealedSha: seal.sealedSha, ...(seal.committed ? { __committedByOrchestrator: true } : {}) };
  }

  briefInput(launch: Launch): BriefInput {
    const node = this.requireNode(launch.taskId);
    const entry = this.entry(launch.taskId);
    const depReports = node.deps.map((d) => {
      const dn = this.graph().nodes.get(d);
      if (dn?.kind === 'external') {
        return { taskId: d, report: undefined, cancelled: undefined, external: { done: dn.done, title: String(dn.payload['title'] ?? '') } };
      }
      const ds = this.entry(d).status;
      return {
        taskId: d,
        report: this.store.getCompletionReport(d),
        cancelled: ds.kind === 'cancelled' ? { reason: ds.reason } : undefined,
      };
    });
    // The check command and the rules are read when the brief is composed; a launch already briefed keeps its text. See specs/agent-protocol "Check command and tool rules in the brief".
    const eff = this.effective();
    return {
      launch,
      node: { id: node.id, kind: node.kind, payload: this.payloadOf(node), deps: node.deps },
      depReports,
      // Recovery already scrubbed stored carries; this catches a context composed since. See specs/crash-recovery "Context naming lost work".
      carry: scrubCarry(entry.carry, (ref) => this.lostRefs.has(ref)).carry as Record<string, unknown> | undefined,
      apiBaseUrl: this.apiBaseUrl,
      retryWindowMs: this.config.retryWindowMs,
      // Every brief states the limits in force when it is composed. See specs/agent-protocol "Brief states the limits in force".
      limits: { stuckAfterMs: eff.config.health.stuckAfterMs, stuckFailAfterMs: eff.config.health.stuckFailAfterMs, maxLaunchMs: eff.config.budgets.maxLaunchMs },
      // The lease line is for a launch a worker claims. A spawned launch's lease is renewed by the tick while its process
      // lives, so its brief carries no lease line: one composed in `spawn` mode, or recomposed when a parked launch is
      // spawned (status `launching`). See specs/agent-protocol "No lease line for a spawned launch".
      ...(this.effectiveMode() === 'spawn' || launch.status === 'launching' ? {} : { leaseTtlMs: this.config.leaseTtlMs }),
      checkCommand: eff.config.checkCommand,
      // The worktree of a launch prepared under `prepareCommand` had it run before the agent starts. See specs/agent-protocol "Prepare command in the brief".
      ...(this.config.prepareCommand ? { prepareCommand: this.config.prepareCommand } : {}),
      integrationBranch: this.config.integrationBranch,
      // Only a launch the daemon spawns gets the list; in pull mode every launch is claimed and the worker runs under its own permissions.
      // The list is a Claude Code permission flag, so a launch of another kind never gets it. See specs/worker-runners.
      allowedTools: eff.allowedTools.applied && this.effectiveMode() !== 'pull' && runnerOf(launch) === 'claude-code' ? eff.allowedTools.value : undefined,
      // The brief's commit sentences key off the policy fixed on the row; the sandbox is the codex one in force. See specs/worker-runners "Sandbox and commit policy".
      // The opencode permission names the bash patterns the runner's ruleset allows (`git *` first, as the runner writes it).
      runner: {
        kind: runnerOf(launch),
        commitPolicy: commitPolicyOf(launch),
        ...(runnerOf(launch) === 'codex'
          ? { sandbox: eff.config.runner.codex.sandbox, networkAccess: codexNetworkAccess(eff.config.runner.codex.sandbox, eff.config.runner.codex.networkAccess) }
          : {}),
        ...(runnerOf(launch) === 'opencode' ? { permission: this.openCodePermissionFor() } : {}),
      },
    };
  }

  /** The opencode permission mode and, under `derived`, the bash patterns allowed. The rules are the ones main.ts gives the OpenCode runner. */
  private openCodePermissionFor(): { mode: OpenCodePermission; bashPatterns?: string[] } {
    const eff = this.effective();
    const mode = eff.config.runner.opencode.permission;
    if (mode === 'allow') return { mode };
    return { mode, bashPatterns: [...new Set(['git *', ...bashPatterns(this.openCodeAllowedTools())])] };
  }

  /**
   * The rules the OpenCode permission ruleset is derived from: the composed allow list, else (an opencode run composes none)
   * the detected toolchain and the claude file rules. main.ts gives the OpenCode runner the same list, and a claim carries it.
   */
  openCodeAllowedTools(): string[] {
    const eff = this.effective();
    if (eff.allowedTools.value.length) return eff.allowedTools.value;
    const claude = eff.config.runner.claude;
    return composeAllowedTools({ record: eff.toolchain, deriveTools: claude.deriveTools, fileRules: claude.allowedTools, argumentRules: eff.overrides.allowedTools ?? [] }).value;
  }

  agentEnv(launch: Launch): Record<string, string> {
    return {
      // Isolation first: an isolated ORCH_HOME and no client-side daemon variables (empty values are deleted by the runner). See specs/agent-protocol "Agent environment".
      ...isolationEnv(this.config.dataDir),
      ORCH_LAUNCH_ID: launch.launchId,
      ORCH_TOKEN: launch.token,
      ORCH_API: this.apiBaseUrl,
      ORCH_RETRY_WINDOW_MS: String(this.config.retryWindowMs),
      ORCH_TASK_ID: launch.taskId,
      ORCH_WORKTREE: launch.worktree,
      // Read by the MCP shim to phrase the report tool; unset means `agent`. See specs/worker-runners "Sandbox and commit policy".
      ...(commitPolicyOf(launch) === 'daemon' ? { ORCH_COMMIT_POLICY: 'daemon' } : {}),
    };
  }

  // ---- transitions ----

  /** Apply a transition inside a store transaction and record the event. */
  transition(id: Id, next: Status, actor: Actor, trigger: string, patch?: Partial<Entry>, extra?: Record<string, unknown>): Entry {
    return this.store.transaction(() => {
      const node = this.requireNode(id);
      const prev = this.entry(id);
      const out = applyTransition(prev, next, { nodeId: id, nodeKind: node.kind, actor, trigger, now: this.now(), patch });
      this.store.setEntry(id, out);
      // The triggers that reset budgets end the count of prepare failures too; this covers both uncancel paths and every task a cascade resets.
      if (this.config.prepareCommand !== undefined && PREPARE_RETRY_RESETS.has(trigger)) clearPrepareRetry(this.store, id);
      this.recordTransition(id, prev.status.kind, next.kind, actor, trigger, extra);
      return out;
    });
  }

  /**
   * Fail a task (from running or submitted), then retry or exhaust in the same
   * transaction. See task-lifecycle "Retry and exhaustion".
   */
  fail(id: Id, reason: FailedReason, actor: Actor, trigger: string): Entry {
    return this.store.transaction(() => {
      const failed = this.transition(id, { kind: 'failed', reason }, actor, trigger);
      if (failed.attempts < this.config.maxAttempts) {
        const carry: AttemptContext = { ...(failed.carry ?? {}), priorFailure: reason, verifierOutput: reason.output };
        return this.transition(id, { kind: 'unstarted' }, 'orchestrator', 'retry', { carry });
      }
      const blocked: BlockedReason = {
        kind: 'impossible',
        message: `attempts exhausted after ${failed.attempts}: ${reason.kind}${reason.message ? `: ${reason.message}` : ''}`,
      };
      const unblock = reason.detail?.['whatWouldUnblock'];
      const extra = typeof unblock === 'string' && unblock.trim() ? { whatWouldUnblock: unblock } : {};
      return this.transition(id, { kind: 'blocked', reason: blocked }, 'orchestrator', 'exhausted', undefined, extra);
    });
  }

  endLaunch(launch: Launch, endReason: string, extra: Record<string, unknown> = {}): void {
    if (launch.status === 'ended' || launch.status === 'revoked') return;
    this.store.updateLaunch(launch.launchId, { status: 'ended', endedAt: this.now(), endReason });
    this.store.appendEvent({ kind: 'launch.ended', taskId: launch.taskId, launchId: launch.launchId, payload: { endReason, ...extra } }, this.now());
    this.resolveWaiters(launch.launchId, { status: 200, body: { timeout: true, reason: endReason } });
    // A tick's read of the launch branch tip is never used again: the branch is this launch's own.
    this.origin?.forgetBranchTip(launch.branch);
  }

  // ---- graph ----

  async loadGraph(): Promise<void> {
    if (!this._graph) {
      const snap = this.store.getSnapshot();
      if (snap) this._graph = parseGraph(snap.content);
    }
    // A stored proposal rejected earlier, by this daemon or one before it, is reported as rejected though it is not evaluated again.
    if (!this._graphRejected) this._graphRejected = this.graphSource.standingRejection?.();
    let polled: { content: string; graph: Graph; stamp?: number } | undefined;
    try {
      polled = await this.graphSource.poll(this._graph?.rev);
    } catch (err) {
      this._graphRejected = { reasons: [err instanceof GraphValidationError ? err.message : String(err)] };
      this.store.appendEvent({ kind: 'graph.rejected', payload: { reasons: this._graphRejected.reasons } }, this.now());
      return;
    }
    if (!polled) return;
    let cls: ReloadClassification | undefined;
    if (this._graph) {
      cls = classifyReload(this._graph, polled.graph, this.overlay());
      if (!cls.compatible) {
        this._graphRejected = { reasons: cls.reasons.map((r: ReloadReason) => r.message) };
        // A stored proposal stays rejected until sent again, across restarts. See specs/graph-import "Rejected proposal stays rejected".
        if (polled.stamp !== undefined) this.graphSource.rejected?.(polled.stamp, this._graphRejected.reasons);
        this.store.appendEvent({ kind: 'graph.rejected', payload: { rev: polled.graph.rev, reasons: this._graphRejected.reasons } }, this.now());
        this.log.warn('graph reload rejected', { reasons: this._graphRejected.reasons });
        return;
      }
    }
    if (this.config.validateAt === 'ingest') {
      const reasons: string[] = [];
      for (const node of polled.graph.nodes.values()) {
        if (node.kind !== 'task') continue;
        const overlay = this.store.getPayloadOverlay(node.id, polled.graph.rev);
        const v = this.briefValidator.validate(node, overlay ? { ...node.payload, ...overlay } : { ...node.payload });
        if (!v.ok) reasons.push(`${node.id}: missing ${v.missing.join(', ')}`);
      }
      if (reasons.length) {
        this._graphRejected = { reasons };
        if (polled.stamp !== undefined) this.graphSource.rejected?.(polled.stamp, reasons);
        this.store.appendEvent({ kind: 'graph.rejected', payload: { rev: polled.graph.rev, reasons } }, this.now());
        this.log.warn('graph rejected at ingest: insufficient briefs', { reasons });
        return;
      }
    }
    this._graph = polled.graph;
    this._graphRejected = undefined;
    this.store.setSnapshot(polled.graph.rev, polled.content);
    if (!this.store.getKv('baselineHead')) {
      try {
        this.store.setKv('baselineHead', await this.workspace.integrationHead());
      } catch (err) {
        this.log.warn('could not record baseline head', { err: String(err) });
      }
    }
    this.store.appendEvent({ kind: 'graph.loaded', payload: { rev: polled.graph.rev } }, this.now());
    if (cls?.compatible) {
      // Milestones hold no work: a dependency edit resets a done or submitted one. See specs/task-graph "Reload compatibility".
      for (const m of cls.milestoneDepsChanged) this.resetMilestone(m, 'depsChanged');
      // A payload edit reaches a live agent as a notice; its pinned brief stays. See specs/agent-protocol "Payload change notice".
      if (this.config.graph.payloadChangedNotice) {
        for (const id of cls.payloadChanged) {
          const e = this.entry(id);
          if ((e.status.kind !== 'running' && e.status.kind !== 'waiting') || !e.lease) continue;
          this.store.transaction(() => {
            this.queueNotice(e.lease!.launchId, { kind: 'payloadChanged', rev: polled!.graph.rev });
            this.store.appendEvent({ kind: 'graph.payloadChanged', taskId: id, launchId: e.lease!.launchId, payload: { rev: polled!.graph.rev } }, this.now());
          });
        }
      }
    }
  }

  // ---- agent API (transport independent) ----

  private authenticate(launchId: string, token: string): Launch | undefined {
    const launch = this.store.getLaunch(launchId);
    if (!launch || launch.token !== token) return undefined;
    if (launch.status !== 'live' && launch.status !== 'launching') return undefined;
    return launch;
  }

  /** Extend the lease by the TTL. Called on every agent call and, for observed-alive processes, every tick. */
  renewLease(launch: Launch): void {
    const e = this.entry(launch.taskId);
    if ((e.status.kind === 'running' || e.status.kind === 'waiting') && e.lease?.launchId === launch.launchId) {
      this.store.setEntry(launch.taskId, { ...e, lease: { ...e.lease, expiresAt: this.now() + this.config.leaseTtlMs } });
    }
  }

  /**
   * The lease of a launch's task while the launch holds it: the TTL, the absolute expiry, and the
   * longest a worker may go between calls (a third of the TTL). See specs/pull-runner "Lease facts in the claim".
   */
  leaseFacts(launch: Launch): { ttlMs: number; expiresAt: number; renewEveryMs: number } | undefined {
    const e = this.entry(launch.taskId);
    if (e.lease?.launchId !== launch.launchId) return undefined;
    const ttlMs = this.config.leaseTtlMs;
    return { ttlMs, expiresAt: e.lease.expiresAt, renewEveryMs: renewEveryMsOf(ttlMs) };
  }

  /**
   * Renew a claimed launch's lease for the loop that holds it while its agent process is alive.
   * A renewal is not a progress signal: it leaves progressAt, lastSignal and the stuck clock alone,
   * and appends no event. See specs/pull-runner "Lease renewal by the work loop".
   */
  renewClaim(launchId: string, token: string): ApiResponse {
    const launch = this.authenticate(launchId, token);
    if (!launch) return { status: 401, body: { error: 'unauthorized' } };
    if (!launch.worker || launch.pid !== undefined) return { status: 409, body: { ok: false, reason: `launch ${launchId} is not a claimed launch` } };
    const e = this.entry(launch.taskId);
    if (e.lease?.launchId !== launchId || (e.status.kind !== 'running' && e.status.kind !== 'waiting')) {
      return { status: 409, body: { ok: false, reason: `launch ${launchId} no longer holds its task; task is ${e.status.kind}` } };
    }
    this.renewLease(launch);
    return { status: 200, body: { ok: true, ...this.leaseFacts(launch) } };
  }

  /**
   * A running claimed launch whose lease expired, seen by the tick or by startup recovery. With progress in the
   * worktree since the claim (a commit on the launch branch, a changed tracked file or a staged path; an untracked
   * file alone is not progress) and the task's kept releases under
   * `daemon.maxKeptReleases`, it ends as a kept release: uncommitted work is committed on the branch,
   * the branch is kept, the attempt is not spent, and the next brief names the branch. Otherwise it is a
   * failed attempt (`leaseExpired`). See specs/pull-runner "Lease expiry".
   */
  async expireClaim(launch: Launch, opts: { awaitOrigin?: boolean } = {}): Promise<'kept' | 'failed' | 'skipped'> {
    const message = `no contact from worker for ${this.config.leaseTtlMs}ms`;
    const expired = (): boolean => {
      // A sleep since the caller read the clock (inside the tick's loop, or while git ran) renews the lease first. See specs/pull-runner "Lease renewal after a gap".
      this.noteClock();
      this.recordGaps();
      const e = this.entry(launch.taskId);
      return e.status.kind === 'running' && e.lease?.launchId === launch.launchId && e.lease.expiresAt <= this.now() && this.store.getLaunch(launch.launchId)?.status === 'live';
    };
    if (!expired()) return 'skipped';
    if (accessOf(launch) === 'remote') return this.expireRemoteClaim(launch, message, expired, opts.awaitOrigin === true);
    const bound = this.config.daemon.maxKeptReleases;
    const interruptions = this.entry(launch.taskId).interruptions ?? 0;
    let preserved: { headSha: string; wipCommit?: string } | undefined;
    if (bound === 0 || interruptions < bound) {
      try {
        // A clean tree at the base sha is left as it is, so this is also the progress test. Untracked files are not
        // progress and are not committed: a check command's artefact must not turn an idle claim into a kept release.
        preserved = await this.workspace.preserve(launch, { untracked: false });
      } catch (err) {
        // The work-in-progress commit failed (a worker holding index.lock, say). Commits already on the branch are
        // still progress: keep the branch at its head without the uncommitted part. See specs/pull-runner "Lease expiry".
        let head: string | undefined;
        try {
          head = (await this.workspace.fingerprint(launch)).split(':')[0];
        } catch {
          /* no readable head */
        }
        if (head && head !== launch.baseSha) {
          preserved = { headSha: head };
          this.log.warn('could not commit the uncommitted work of an expired claim; keeping its branch at the head', { launchId: launch.launchId, headSha: head, err: String(err) });
        } else {
          this.log.warn('could not inspect or preserve the worktree of an expired claim; failing the attempt', { launchId: launch.launchId, err: String(err) });
        }
      }
    }
    // A call that arrived while git ran renewed the lease: the launch lives on (any WIP commit stays on its branch).
    if (!expired()) return 'skipped';
    const progressed = preserved !== undefined && (preserved.wipCommit !== undefined || preserved.headSha !== launch.baseSha);
    let outcome: 'kept' | 'failed' = 'failed';
    if (progressed) {
      const entry = this.entry(launch.taskId);
      const interrupted: InterruptedContext = { priorLaunchId: launch.launchId, priorBranch: launch.branch, headSha: preserved!.headSha, ...(preserved!.wipCommit ? { wipCommit: preserved!.wipCommit } : {}), reason: 'leaseExpired', interruptions: interruptions + 1 };
      this.store.transaction(() => {
        this.store.appendEvent({ kind: 'launch.released', taskId: launch.taskId, launchId: launch.launchId, payload: { reason: message, reasonCode: 'leaseExpired', progressed: true, keep: true, kept: true, workerId: launch.worker?.id } }, this.now());
        this.transition(launch.taskId, { kind: 'unstarted' }, 'orchestrator', 'released', { carry: { ...(entry.carry ?? {}), interrupted }, interruptions: interrupted.interruptions }, { reason: 'leaseExpired' });
        this.endLaunch(launch, 'leaseExpired', { kept: true });
      });
      outcome = 'kept';
    } else {
      await this.recordUsage(launch);
      this.store.transaction(() => {
        this.fail(launch.taskId, { kind: 'leaseExpired', message }, 'orchestrator', 'deadOrExpired');
        this.endLaunch(launch, 'leaseExpired');
      });
    }
    await this.workspace.remove(launch);
    this.wake();
    return outcome;
  }

  /**
   * Lease expiry of a remote launch: no tree on this host, so the branch tip at origin (`ls-remote`) is the progress
   * test. A tip other than the base, under `daemon.maxKeptReleases`, is a kept release at that tip; no tip, or the
   * base, fails the attempt with `leaseExpired`. While origin cannot be read (or the tick's read is still running) the
   * expiry is skipped and tried on a later tick, until twice the lease TTL has passed since the lease was last renewed;
   * then the attempt fails. The tick never waits for origin beyond its short bound; startup recovery (`awaitOrigin`)
   * awaits the read in full. Nothing is preserved or removed. See specs/pull-runner "Lease expiry".
   */
  private async expireRemoteClaim(launch: Launch, message: string, expired: () => boolean, awaitOrigin: boolean): Promise<'kept' | 'failed' | 'skipped'> {
    const bound = this.config.daemon.maxKeptReleases;
    const interruptions = this.entry(launch.taskId).interruptions ?? 0;
    let tip: string | undefined;
    if (bound === 0 || interruptions < bound) {
      let unreadable: string | undefined;
      try {
        if (!this.origin) throw new OriginConfigError('git.pushIntegration is off: no origin to read the launch branch from');
        if (awaitOrigin) tip = await this.origin.branchTip(launch.branch);
        else {
          // Tagged with the expiry it decides: a read started before a lease renewal is dropped and read again.
          const read = await this.origin.branchTipFromTick(launch.branch, this.entry(launch.taskId).lease?.expiresAt);
          if (read.pending) unreadable = 'the read of the branch tip at origin is still running';
          else tip = read.tip;
        }
      } catch (err) {
        if (!(err instanceof OriginFetchError) && !(err instanceof OriginConfigError)) throw err;
        unreadable = err.message;
      }
      if (unreadable !== undefined) {
        const expiresAt = this.entry(launch.taskId).lease?.expiresAt ?? this.now();
        if (this.now() < expiresAt + this.config.leaseTtlMs) {
          this.log.warn('cannot read the branch of an expired remote claim at origin; trying again on a later tick', { launchId: launch.launchId, branch: launch.branch, err: unreadable });
          return 'skipped';
        }
        this.log.warn('origin unreadable for twice the lease TTL; failing the expired remote claim', { launchId: launch.launchId, branch: launch.branch, err: unreadable });
        this.origin?.forgetBranchTip(launch.branch);
      }
    }
    // A call that arrived while origin was read renewed the lease: the launch lives on.
    if (!expired()) return 'skipped';
    const headSha = tip?.toLowerCase();
    const progressed = headSha !== undefined && headSha !== launch.baseSha.toLowerCase();
    let outcome: 'kept' | 'failed' = 'failed';
    if (progressed) {
      const entry = this.entry(launch.taskId);
      const interrupted: InterruptedContext = { priorLaunchId: launch.launchId, priorBranch: launch.branch, headSha: headSha!, reason: 'leaseExpired', interruptions: interruptions + 1 };
      this.store.transaction(() => {
        this.store.appendEvent({ kind: 'launch.released', taskId: launch.taskId, launchId: launch.launchId, payload: { reason: message, reasonCode: 'leaseExpired', progressed: true, keep: true, kept: true, workerId: launch.worker?.id, access: 'remote', headSha } }, this.now());
        this.transition(launch.taskId, { kind: 'unstarted' }, 'orchestrator', 'released', { carry: { ...(entry.carry ?? {}), interrupted }, interruptions: interrupted.interruptions }, { reason: 'leaseExpired' });
        this.endLaunch(launch, 'leaseExpired', { kept: true });
      });
      outcome = 'kept';
    } else {
      await this.recordUsage(launch);
      this.store.transaction(() => {
        this.fail(launch.taskId, { kind: 'leaseExpired', message }, 'orchestrator', 'deadOrExpired');
        this.endLaunch(launch, 'leaseExpired');
      });
    }
    this.wake();
    return outcome;
  }

  /**
   * Every API call is progress; a heartbeat with new text is progress with the text kept. A heartbeat of a remote
   * launch that carries `fingerprint` (its worker's clone, see specs/worker-pool "Loop heartbeat") is progress only
   * when the fingerprint changed (`commit` or `worktree`) or its text did, so the loop's periodic heartbeats renew the
   * lease without hiding a stuck agent. A local launch's `fingerprint` is ignored. See specs/health-monitoring "Progress signals".
   */
  private recordProgress(launch: Launch, op: AgentOp, body: Record<string, unknown>): void {
    let cur = this.store.getLaunch(launch.launchId);
    if (!cur) return;
    const text = body['progress'];
    if (op === 'heartbeat' && accessOf(cur) === 'remote' && typeof body['fingerprint'] === 'string') {
      cur = applyFingerprint(this, cur, body['fingerprint']);
      if (typeof text === 'string' && text && text !== cur.progressText) recordSignal(this, cur, 'heartbeatText', text);
      return;
    }
    if (op === 'heartbeat' && typeof text === 'string' && text && text !== cur.progressText) {
      recordSignal(this, cur, 'heartbeatText', text);
      return;
    }
    recordSignal(this, cur, op);
  }

  /** Append a notice to a launch's inbox. See specs/agent-protocol "Inbox notices for health". */
  queueNotice(launchId: string, notice: { kind: string; [k: string]: unknown }): boolean {
    const l = this.store.getLaunch(launchId);
    if (!l) return false;
    this.store.transaction(() => {
      this.store.updateLaunch(launchId, { notices: [...(l.notices ?? []), notice] });
      this.store.appendEvent({ kind: 'launch.notice', taskId: l.taskId, launchId, payload: { kind: notice.kind } }, this.now());
    });
    return true;
  }

  /** Read and store the launch's usage once, when it is observed dead or ended. */
  /**
   * The `exitedWithoutReport` reason of a launch whose process ended without a report, with the
   * runner's diagnosis in the message and in `detail.runnerFailure` when it has one.
   * See specs/task-lifecycle "Health failure reasons".
   */
  async exitedWithoutReport(launch: Launch, message: string): Promise<FailedReason> {
    const failure = await this.runner.readFailure?.(launch).catch(() => undefined);
    if (!failure) return { kind: 'exitedWithoutReport', message };
    return {
      kind: 'exitedWithoutReport',
      message: `${message}: ${failure.reason}${failure.detail ? `: ${failure.detail}` : ''}`,
      detail: { runnerFailure: failure },
    };
  }

  /**
   * Fail a running task whose launch died without a report, recording `launch.failed` with the runner's
   * reason. A `startupContended` death is relaunched at once without charging a retry while the task has
   * had fewer than `health.contendedRetries` uncharged ones (counted from those events); later ones count.
   * See specs/task-lifecycle "Retry and exhaustion".
   */
  failExited(launch: Launch, reason: FailedReason, trigger: string): Entry {
    const failure = reason.detail?.['runnerFailure'] as RunnerFailure | undefined;
    const allowance = this.config.health.contendedRetries ?? DEFAULT_CONTENDED_RETRIES;
    return this.store.transaction(() => {
      // Counted inside the transaction that appends the event, so the allowance bound is exact.
      const uncharged =
        failure?.reason === 'startupContended' &&
        this.store.listEvents({ kind: 'launch.failed', taskId: launch.taskId }).filter((e) => e.payload?.['reason'] === 'startupContended' && e.payload['charged'] === false).length < allowance;
      const payload = { ...(failure ? { reason: failure.reason, ...(failure.detail ? { detail: failure.detail } : {}) } : {}), charged: !uncharged };
      this.store.appendEvent({ kind: 'launch.failed', taskId: launch.taskId, launchId: launch.launchId, payload }, this.now());
      if (!uncharged) return this.fail(launch.taskId, reason, 'orchestrator', trigger);
      // The `released` row leaves attempts unchanged; the next brief still names the contended death.
      const entry = this.entry(launch.taskId);
      return this.transition(launch.taskId, { kind: 'unstarted' }, 'orchestrator', 'released', { carry: { ...(entry.carry ?? {}), priorFailure: reason } }, { reason: 'startupContended' });
    });
  }

  /** Read a spawned launch's usage from its runner and store it once. A claimed launch has no log: its worker posts usage instead. */
  async recordUsage(launch: Launch): Promise<void> {
    if (!this.runner.readUsage) return;
    const cur = this.store.getLaunch(launch.launchId);
    if (!cur || cur.worker || hasUsage(cur)) return;
    const read = await this.runner.readUsage(cur).catch(() => undefined);
    if (!read || !hasUsage(read)) return;
    this.storeUsage(cur, { ...read });
  }

  /**
   * Usage a worker posts for the launch it claimed, after its agent exits. Spawned launches keep
   * the runner as the sole source; the first usage recorded wins. See specs/pull-runner "Worker usage".
   */
  recordWorkerUsage(launchId: string, body: unknown): ApiResponse {
    const bad = workerUsageError(body);
    if (bad) return bad;
    const { workerId, usage } = workerUsageBodySchema.parse(body);
    const cur = this.store.getLaunch(launchId);
    if (!cur) return { status: 404, body: { ok: false, reason: `no launch ${launchId}` } };
    if (cur.pid !== undefined || !cur.worker) return { status: 409, body: { ok: false, reason: `launch ${launchId} is not a claimed launch; its runner reports its usage` } };
    if (cur.worker.id !== workerId) return { status: 409, body: { ok: false, reason: `launch ${launchId} is held by another worker` } };
    if (cur.status !== 'live' && cur.status !== 'ended') return { status: 409, body: { ok: false, reason: `launch ${launchId} is ${cur.status}` } };
    if (hasUsage(cur)) return { status: 200, body: { ok: true, recorded: false } };
    const u = this.storeUsage(cur, { tokens: usage.tokens, ...(usage.costUsd !== undefined ? { costUsd: usage.costUsd } : {}), source: 'worker' }, usage.model);
    return { status: 200, body: { ok: true, recorded: true, costUsd: u.costUsd } };
  }

  /** Price a usage when it has tokens and no cost, then store it on the row and append `launch.usage`. */
  private storeUsage(cur: Launch, u: Usage, postedModel?: string): Usage {
    let costSource: Launch['costSource'];
    if (u.costUsd !== undefined) costSource = 'reported';
    else if (u.tokens) {
      const price = priceFor(this.config, postedModel ?? cur.model);
      if (price) {
        u.costUsd = priceUsage(u.tokens, price);
        costSource = 'priced';
      } else {
        const model = postedModel ?? cur.model ?? '(none)';
        if (!this.unpricedModelsLogged.has(model)) {
          this.unpricedModelsLogged.add(model);
          this.log.warn('launch usage has tokens but no price for its model; its cost is unknown and outside the run cost budget (set budgets.prices)', { model, launchId: cur.launchId });
        }
      }
    }
    this.store.transaction(() => {
      this.store.updateLaunch(cur.launchId, { costUsd: u.costUsd, turns: u.turns, durationMs: u.durationMs, tokens: u.tokens, usageSource: u.source, costSource });
      this.store.appendEvent({ kind: 'launch.usage', taskId: cur.taskId, launchId: cur.launchId, payload: { ...u, ...(costSource ? { costSource } : {}), ...(postedModel ? { model: postedModel } : {}) } }, this.now());
    });
    return u;
  }

  /**
   * One agent operation. `opts.connected` tells whether the caller is still there to read the answer (the HTTP route
   * passes its socket's state); without it the caller is taken to be there.
   */
  async agentCall(launchId: string, token: string, op: AgentOp, body: Record<string, unknown> = {}, opts: { connected?: () => boolean } = {}): Promise<ApiResponse> {
    const launch = this.authenticate(launchId, token);
    if (!launch) return { status: 401, body: { error: 'unauthorized' } };
    // Integer fields are checked before anything is written, the lease renewal included. See specs/agent-protocol "Integer fields".
    const bad = op === 'inbox' ? undefined : agentIntegerError(body);
    if (bad) return bad;
    const badFingerprint = op === 'heartbeat' && accessOf(launch) === 'remote' ? heartbeatFingerprintError(body) : undefined;
    if (badFingerprint) return badFingerprint;
    this.renewLease(launch);
    this.recordProgress(launch, op, body);
    switch (op) {
      case 'heartbeat':
        this.store.appendEvent({ kind: 'agent.heartbeat', taskId: launch.taskId, launchId, payload: body }, this.now());
        return { status: 200, body: { ok: true } };
      case 'inbox':
        return this.handleInbox(launchId, opts.connected ?? (() => true));
      case 'log': {
        const seq = this.seqOf(body);
        if (seq !== undefined) {
          const dup = this.store.getDedup(launchId, seq);
          if (dup) return dup as ApiResponse;
        }
        const res: ApiResponse = { status: 200, body: { ok: true } };
        this.store.transaction(() => {
          this.store.appendEvent({ kind: 'agent.log', taskId: launch.taskId, launchId, payload: { text: String(body['text'] ?? '') } }, this.now());
          if (seq !== undefined) this.store.putDedup(launchId, seq, res);
        });
        return res;
      }
      case 'report':
        return this.handleReport(launch, body);
      case 'block':
        return this.handleBlock(launch, body);
    }
  }

  /**
   * The inbox hands out only durable notices and answers only once its own writes are durable, although it is a GET.
   * The notices held now are taken, then everything committed so far (those notices' records, the lease renewal and
   * the progress signal) is awaited; only the taken notices are then removed from the row, so a notice queued during
   * the wait stays for the next call, and the removal is awaited too. A caller that went away during a wait gets
   * nothing removed: gone before the removal, the notices stay; gone after it, they are put back at the front. The
   * next read hands them out again. See specs/agent-protocol "Durable inbox" and "Inbox notices handed out once".
   */
  private handleInbox(launchId: string, connected: () => boolean): Promise<ApiResponse> {
    // One inbox read per launch at a time, so two concurrent reads never hand out the same notice.
    const prev = this.inboxReads.get(launchId) ?? Promise.resolve();
    const run = prev.then(() => this.readInbox(launchId, connected));
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.inboxReads.set(launchId, settled);
    void settled.then(() => {
      if (this.inboxReads.get(launchId) === settled) this.inboxReads.delete(launchId);
    });
    return run;
  }

  private async readInbox(launchId: string, connected: () => boolean): Promise<ApiResponse> {
    const taken = this.store.getLaunch(launchId)?.notices ?? [];
    await this.waitDurable();
    if (taken.length && !connected()) return INBOX_CALLER_GONE;
    if (taken.length) {
      const handed = new Map<string, number>();
      for (const n of taken) handed.set(JSON.stringify(n), (handed.get(JSON.stringify(n)) ?? 0) + 1);
      const cur = this.store.getLaunch(launchId)?.notices ?? [];
      const rest = cur.filter((n) => {
        const k = JSON.stringify(n);
        const left = handed.get(k) ?? 0;
        if (left <= 0) return true;
        handed.set(k, left - 1);
        return false;
      });
      const removed = cur.filter((n) => !rest.includes(n));
      if (removed.length) this.store.updateLaunch(launchId, { notices: rest });
      await this.waitDurable();
      if (!connected()) {
        // Reads of one launch are serialized and notices are only appended meanwhile, so the front is where they were.
        if (removed.length && this.store.getLaunch(launchId)) this.store.updateLaunch(launchId, { notices: [...removed, ...(this.store.getLaunch(launchId)?.notices ?? [])] });
        return INBOX_CALLER_GONE;
      }
    }
    return { status: 200, body: { notices: taken } };
  }

  private seqOf(body: Record<string, unknown>): number | undefined {
    const s = body['seq'];
    return typeof s === 'number' && Number.isSafeInteger(s) && s >= 0 ? s : undefined;
  }

  private async handleReport(launch: Launch, body: Record<string, unknown>): Promise<ApiResponse> {
    const seq = this.seqOf(body);
    if (seq === undefined) return { status: 400, body: { error: 'seq required' } };
    const dup = this.store.getDedup(launch.launchId, seq);
    if (dup) return dup as ApiResponse;
    const entry = this.entry(launch.taskId);
    if (entry.status.kind !== 'running' || entry.lease?.launchId !== launch.launchId) {
      return { status: 409, body: { error: 'notRunning', status: entry.status.kind } };
    }
    const kind = body['kind'];
    if (kind === 'fail') {
      const parsed = failBodySchema.safeParse(body);
      if (!parsed.success) return { status: 400, body: { error: 'malformed', issues: parsed.error.issues } };
      const res: ApiResponse = { status: 200, body: { accepted: true, outcome: 'failed' } };
      this.store.transaction(() => {
        this.store.putReport({ launchId: launch.launchId, taskId: launch.taskId, kind: 'fail', body: parsed.data, createdAt: this.now() });
        this.store.appendEvent({ kind: 'agent.report', taskId: launch.taskId, launchId: launch.launchId, payload: { kind: 'fail', seq } }, this.now());
        this.fail(launch.taskId, { kind: 'agentFail', message: parsed.data.why, detail: parsed.data }, 'agent', 'fail');
        this.store.putDedup(launch.launchId, seq, res);
      });
      crashPoint('api.afterEventCommit');
      this.wake();
      return res;
    }
    if (kind !== 'submit') return { status: 400, body: { error: 'kind must be submit or fail' } };
    const parsed = submitBodySchema.safeParse(body);
    if (!parsed.success) return { status: 400, body: { error: 'malformed', issues: parsed.error.issues } };
    const badDep = this.invalidProposalDep(parsed.data.proposals);
    if (badDep) {
      return { status: 400, body: { error: 'malformed', issues: [{ path: ['proposals', badDep.index, 'deps'], message: `proposal "${badDep.title}" depends on ${badDep.dep}, which is not in the graph` }] } };
    }

    // A remote submit names the tip it pushed; a local one is sealed from its worktree and any sealedSha is ignored.
    let reportedSha: string | undefined;
    if (accessOf(launch) === 'remote') {
      const s = remoteSealedSha(body['sealedSha']);
      if (!s.ok) return { status: 400, body: { error: s.error, field: s.field } };
      reportedSha = s.sealedSha;
    }

    // A refused seal records nothing (no event, no dedup), so the same seq may be sent again once the cause is fixed.
    const seal = await this.sealSubmission(launch, parsed.data.summary, reportedSha);
    if (!seal.ok) return sealRefusal(seal);

    const res = this.store.transaction((): ApiResponse => {
      // The seal awaited git: recovery or the tick may have revoked this launch and relaunched the task meanwhile.
      // A revoked launch never changes task state. See specs/crash-recovery "Fencing".
      if (!this.authenticate(launch.launchId, launch.token)) return { status: 401, body: { error: 'unauthorized' } };
      const cur = this.entry(launch.taskId);
      if (cur.status.kind !== 'running' || cur.lease?.launchId !== launch.launchId) return { status: 409, body: { error: 'notRunning', status: cur.status.kind } };
      this.store.appendEvent({ kind: 'agent.report', taskId: launch.taskId, launchId: launch.launchId, payload: { kind: 'submit', seq, sealedSha: seal.sealedSha, ...(seal.committed ? { committedByOrchestrator: true } : {}) } }, this.now());
      const outcome = this.acceptSubmission(launch, parsed.data, seal.sealedSha);
      this.store.putDedup(launch.launchId, seq, outcome);
      return outcome;
    });
    crashPoint('api.afterEventCommit');
    this.wake();
    return res;
  }

  private invalidProposalDep(proposals: z.infer<typeof proposalSchema>[]): { index: number; title: string; dep: Id } | undefined {
    for (let i = 0; i < proposals.length; i++) {
      const p = proposals[i]!;
      const dep = (p.deps ?? []).find((d) => !this.graph().nodes.has(d));
      if (dep) return { index: i, title: p.title, dep };
    }
    return undefined;
  }

  /** Structural checks, then submitted + verifier job. Runs inside a transaction. */
  acceptSubmission(launch: Launch, report: z.infer<typeof submitBodySchema>, sealedSha: string): ApiResponse {
    const node = this.requireNode(launch.taskId);
    this.store.putReport({ launchId: launch.launchId, taskId: launch.taskId, kind: 'submit', body: report, sealedSha, createdAt: this.now() });
    // Proposals are held for a human; nothing joins the graph here. See specs/agent-protocol "Proposals in the report".
    const existing = this.store.listProposals({ taskId: launch.taskId }).length;
    report.proposals.forEach((p, i) => {
      if ((p.deps ?? []).some((d) => !this.graph().nodes.has(d))) return;
      const id = `${launch.taskId}-p${existing + i + 1}`;
      this.store.createProposal({ id, taskId: launch.taskId, launchId: launch.launchId, status: 'pending', payload: p, createdAt: this.now() });
      this.store.appendEvent({ kind: 'proposal.created', taskId: launch.taskId, launchId: launch.launchId, payload: { id, title: p.title } }, this.now());
    });
    // The agent's claim is recorded as submitted; structural checks are the verifier's first step.
    this.transition(launch.taskId, { kind: 'submitted' }, 'agent', 'submit', { interruptions: 0 });
    // The process may keep running for the report grace so its usage reaches the log. See specs/health-monitoring "Usage accounting".
    this.store.updateLaunch(launch.launchId, { reportedAt: this.now() });
    const check = checkSubmission({
      sealedSha,
      baseSha: launch.baseSha,
      noChanges: Boolean(report.noChanges),
      criteria: this.acceptanceCriteria(node),
      covered: report.acceptance.map((a) => a.criterion),
    });
    if (!check.ok) {
      const detail = check.reason === 'missingAcceptanceEvidence' ? { uncovered: check.uncovered } : undefined;
      this.fail(launch.taskId, { kind: check.reason, message: check.message, detail }, 'verifier', 'verificationFailed');
      return { status: 200, body: { accepted: false, outcome: 'failed', reason: check.reason, ...(detail ?? {}) } };
    }
    const job: VerifierJob = {
      jobId: randomUUID(),
      taskId: launch.taskId,
      launchId: launch.launchId,
      sealedSha,
      baseSha: launch.baseSha,
      status: 'queued',
      applied: false,
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    this.store.createJob(job);
    return { status: 200, body: { accepted: true, outcome: 'submitted', sealedSha } };
  }

  acceptanceCriteria(node: GraphNode): string[] {
    const raw = this.payloadOf(node)['acceptanceCriteria'];
    if (Array.isArray(raw)) return raw.map(String);
    if (typeof raw === 'string' && raw.trim()) return raw.split('\n').map((s) => s.replace(/^[-*]\s*/, '').trim()).filter(Boolean);
    return [];
  }

  private async handleBlock(launch: Launch, body: Record<string, unknown>): Promise<ApiResponse> {
    const seq = this.seqOf(body);
    if (seq === undefined) return { status: 400, body: { error: 'seq required' } };
    const dup = this.store.getDedup(launch.launchId, seq);
    if (dup) return dup as ApiResponse;
    const entry = this.entry(launch.taskId);
    // Replay while still waiting: re-attach to the same question.
    if (entry.status.kind === 'waiting' && entry.status.seq === seq && entry.lease?.launchId === launch.launchId) {
      return this.waitFor(launch.launchId, seq);
    }
    if (entry.status.kind === 'running' && launch.pendingAnswer?.seq === seq) {
      return { status: 200, body: { answer: launch.pendingAnswer.answer } };
    }
    if (entry.status.kind !== 'running' || entry.lease?.launchId !== launch.launchId) {
      return { status: 409, body: { error: 'notRunning', status: entry.status.kind } };
    }
    const parsed = questionSchema.safeParse(body);
    if (!parsed.success) return { status: 400, body: { error: 'malformed', issues: parsed.error.issues } };
    const question: Question = parsed.data;
    const waitingCount = [...this.overlay().values()].filter((e) => e.status.kind === 'waiting').length;
    if (waitingCount >= this.config.maxWaiting) {
      const res: ApiResponse = { status: 200, body: { timeout: true, reason: 'waitingCapExceeded' } };
      this.store.transaction(() => {
        this.transition(launch.taskId, { kind: 'blocked', reason: { ...question } }, 'agent', 'fallbackBlock');
        this.store.appendEvent({ kind: 'agent.block', taskId: launch.taskId, launchId: launch.launchId, payload: { seq, question, capped: true } }, this.now());
        this.store.putDedup(launch.launchId, seq, res);
      });
      this.wake();
      return res;
    }
    this.store.transaction(() => {
      this.transition(launch.taskId, { kind: 'waiting', question, askedAt: this.now(), seq }, 'agent', 'block', { lease: entry.lease });
      this.store.updateLaunch(launch.launchId, { waitingSince: this.now() });
      this.store.appendEvent({ kind: 'agent.block', taskId: launch.taskId, launchId: launch.launchId, payload: { seq, question } }, this.now());
    });
    crashPoint('api.afterEventCommit');
    this.wake();
    return this.waitFor(launch.launchId, seq);
  }

  private waitFor(launchId: string, seq: number): Promise<ApiResponse> {
    return new Promise<ApiResponse>((resolve) => {
      const list = this.waiters.get(launchId) ?? [];
      list.push({ seq, resolve });
      this.waiters.set(launchId, list);
    });
  }

  resolveWaiters(launchId: string, res: ApiResponse): void {
    const list = this.waiters.get(launchId);
    if (!list) return;
    this.waiters.delete(launchId);
    for (const w of list) w.resolve(res);
  }

  hasWaiter(launchId: string): boolean {
    return (this.waiters.get(launchId)?.length ?? 0) > 0;
  }

  /** Apply a fallback report file found after the process died. */
  applyFallback(launch: Launch, fb: FallbackReport): void {
    const entry = this.entry(launch.taskId);
    if (entry.lease?.launchId !== launch.launchId || (entry.status.kind !== 'running' && entry.status.kind !== 'waiting')) return;
    this.store.transaction(() => {
      this.store.appendEvent({ kind: 'agent.fallback', taskId: launch.taskId, launchId: launch.launchId, payload: { kind: fb.kind, seq: fb.seq, ...(fb.body['__committedByOrchestrator'] ? { committedByOrchestrator: true } : {}) } }, this.now());
      if (entry.status.kind === 'waiting') {
        // Process died while waiting: degrade to blocked, keep question and answer.
        this.transition(launch.taskId, { kind: 'blocked', reason: { ...entry.status.question, answer: entry.status.answer } }, 'orchestrator', 'maxWaitOrDead');
        return;
      }
      if (fb.kind === 'submit') {
        const parsed = submitBodySchema.safeParse(fb.body);
        if (!parsed.success) {
          this.fail(launch.taskId, { kind: 'malformedReport', message: 'fallback submit malformed' }, 'orchestrator', 'deadOrExpired');
          return;
        }
        // Seal synchronously is impossible here (workspace is async); the caller pre-seals via sealForFallback.
        const sealedSha = String(fb.body['__sealedSha'] ?? '');
        if (!sealedSha) {
          this.fail(launch.taskId, { kind: 'malformedReport', message: 'fallback submit could not be sealed (dirty worktree or missing head)' }, 'orchestrator', 'deadOrExpired');
          return;
        }
        this.acceptSubmission(launch, parsed.data, sealedSha);
      } else if (fb.kind === 'fail') {
        const parsed = failBodySchema.safeParse(fb.body);
        this.store.putReport({ launchId: launch.launchId, taskId: launch.taskId, kind: 'fail', body: fb.body, createdAt: this.now() });
        this.fail(launch.taskId, { kind: 'agentFail', message: parsed.success ? parsed.data.why : 'fallback fail', detail: fb.body }, 'agent', 'fail');
      } else {
        const parsed = questionSchema.safeParse(fb.body);
        const question: Question = parsed.success ? parsed.data : { kind: 'needsDecision', message: String(fb.body['message'] ?? 'blocked') };
        this.transition(launch.taskId, { kind: 'blocked', reason: { ...question } }, 'agent', 'fallbackBlock');
      }
    });
  }

  // ---- operator API ----

  private operatorEvent(kind: string, taskId: Id | undefined, payload: Record<string, unknown>): void {
    this.store.appendEvent({ kind: `operator.${kind}`, taskId, payload }, this.now());
  }

  answer(taskId: Id, text: string): { ok: true } | { ok: false; reason: string } {
    const entry = this.entry(taskId);
    const leased = entry.lease ? this.store.getLaunch(entry.lease.launchId) : undefined;
    if (entry.status.kind === 'waiting' && (!leased || leased.status === 'ended' || leased.status === 'revoked')) {
      // Its launch ended while it waited (a claimed launch whose worktree a fresh clone lost): nothing can resume, so the
      // answer goes into a retry at no cost. See specs/crash-recovery "Waiting claim with a lost worktree".
      const { question } = entry.status;
      this.store.transaction(() => {
        this.operatorEvent('answer', taskId, { text });
        this.transition(taskId, { kind: 'blocked', reason: { ...question, answer: text } }, 'orchestrator', 'maxWaitOrDead');
        this.unblock(taskId, { answer: text });
      });
      this.wake();
      return { ok: true };
    }
    if (entry.status.kind === 'waiting') {
      this.store.transaction(() => {
        this.operatorEvent('answer', taskId, { text });
        this.store.setEntry(taskId, { ...entry, status: { ...entry.status, answer: text } as Status, updatedAt: this.now() });
      });
      this.wake();
      return { ok: true };
    }
    if (entry.status.kind === 'blocked') {
      this.store.transaction(() => {
        this.operatorEvent('answer', taskId, { text });
        const reason = (entry.status as { reason: BlockedReason }).reason;
        const carry: AttemptContext = { ...(entry.carry ?? {}), question: { kind: reason.kind, message: reason.message, options: reason.options }, answer: text };
        this.transition(taskId, { kind: 'unstarted' }, 'human', 'unblock', { carry });
      });
      this.wake();
      return { ok: true };
    }
    return { ok: false, reason: `task ${taskId} is ${entry.status.kind}; nothing to answer` };
  }

  cancel(taskId: Id, reason: string, releasesDependents = this.config.cancelReleasesDependentsDefault): { ok: true } | { ok: false; reason: string } {
    const entry = this.entry(taskId);
    if (entry.status.kind === 'done' || entry.status.kind === 'cancelled') {
      return { ok: false, reason: `task ${taskId} is ${entry.status.kind}` };
    }
    const remoteVerifier = this.config.verifier?.mode === 'remote';
    this.store.transaction(() => {
      this.operatorEvent('cancel', taskId, { reason, releasesDependents });
      this.transition(taskId, { kind: 'cancelled', reason, releasesDependents }, 'human', 'cancel');
      // Under verifier.mode remote an offered job without a stored result goes too, claimed or not; its four fields are
      // kept. See specs/task-lifecycle "Cancellation: offered verify jobs".
      const offered = remoteVerifier ? this.store.listJobs({ taskId, status: 'checking', applied: false }).filter((j) => j.offer !== undefined && j.result === undefined) : [];
      for (const job of [...this.store.listJobs({ taskId, status: 'queued' }), ...offered]) {
        this.store.updateJob(job.jobId, { status: 'dropped', applied: true, updatedAt: this.now() });
      }
    });
    for (const l of this.store.listLaunches({ taskId, status: 'live' })) {
      this.resolveWaiters(l.launchId, { status: 200, body: { timeout: true, reason: 'cancelled' } });
    }
    // The wait of a dropped offered job reads its row at once, with no tick, and ends.
    if (remoteVerifier) wakeVerifyWaiters(this);
    this.wake();
    return { ok: true };
  }

  /** Context for the next brief of a task relaunched after reopen, uncancel, or a cascade reset. */
  revisionContext(id: Id, cause: RevisionContext['cause'], upstream?: Id): RevisionContext | undefined {
    const prior = [...this.store.listLaunches({ taskId: id })].sort((a, b) => a.launchNo - b.launchNo).at(-1);
    if (!prior) return undefined;
    const published = this.store.listJobs({ taskId: id, status: 'published' }).at(-1);
    const report = this.store.getCompletionReport(id);
    return {
      cause,
      ...(upstream ? { upstream } : {}),
      priorLaunchId: prior.launchId,
      // A branch lost with a previous clone is not named. See specs/crash-recovery "Context naming lost work".
      ...(this.lostRefs.has(prior.branch) ? {} : { priorBranch: prior.branch }),
      ...(published?.publishedSha && !this.lostRefs.has(published.publishedSha) ? { priorPublishedSha: published.publishedSha } : {}),
      ...(report ? { priorReportSummary: String(report.body['summary'] ?? '') } : {}),
    };
  }

  /** Reset a done or submitted milestone to unstarted, keeping its review history. See specs/task-lifecycle "Milestone reset". */
  resetMilestone(id: Id, reason: 'upstreamReopened' | 'depsChanged', upstream?: Id): boolean {
    const entry = this.entry(id);
    if (entry.status.kind !== 'done' && entry.status.kind !== 'submitted') return false;
    this.store.transaction(() => {
      this.transition(id, { kind: 'unstarted' }, 'orchestrator', 'milestoneReset', { accepted: undefined, integrationSha: undefined }, { reason, upstream });
      this.store.appendEvent({ kind: 'milestone.reset', taskId: id, payload: { reason, upstream, from: entry.status.kind, reviewVersion: entry.reviewVersion } }, this.now());
    });
    return true;
  }

  /**
   * Reopen a done or cancelled node. Plain reopen refuses when a started task is
   * reachable through milestones; `cascade` records a plan the tick applies.
   * See specs/task-lifecycle "Reopen guard" and "Cascade reopen".
   */
  reopen(taskId: Id, opts: { cascade?: boolean } = {}): ReopenResult {
    if (opts.cascade) return this.cascadeReopen(taskId);
    const r = q.revocable(this.graph(), this.overlay(), taskId);
    if (!r.ok) return { ok: false, reason: r.reason, blockers: r.blockers };
    const entry = this.entry(taskId);
    const node = this.requireNode(taskId);
    const from = entry.status.kind;
    const resets = r.resets.map((m) => ({ id: m, from: this.entry(m).status.kind }));
    this.store.transaction(() => {
      this.operatorEvent('reopen', taskId, { cascade: false, resets: r.resets });
      const revision = node.kind === 'task' ? this.revisionContext(taskId, 'reopened') : undefined;
      this.transition(taskId, { kind: 'unstarted' }, 'human', from === 'done' ? 'reopen' : 'uncancel', { carry: revision ? { revision } : undefined, accepted: undefined, integrationSha: undefined });
      for (const m of r.resets) this.resetMilestone(m, 'upstreamReopened', taskId);
    });
    this.wake();
    return { ok: true, reset: [{ id: taskId, from }, ...resets] };
  }

  private cascadeReopen(taskId: Id): ReopenResult {
    const node = this.graph().nodes.get(taskId);
    const entry = this.entry(taskId);
    if (!node || node.kind === 'external') return { ok: false, reason: `node ${taskId} cannot be reopened` };
    if (entry.status.kind !== 'done' && entry.status.kind !== 'cancelled') return { ok: false, reason: `node ${taskId} is ${entry.status.kind}, not done or cancelled` };
    if (this.pendingCascade()) return { ok: false, reason: 'a cascade is already pending; retry after the next tick' };
    const plan = q.cascadePlan(this.graph(), this.overlay(), taskId);
    for (const step of plan) {
      if (this.store.listJobs({ taskId: step.id, status: 'publishing' }).length) {
        return { ok: false, reason: `${step.id} is publishing; retry after it settles`, publishing: step.id };
      }
    }
    this.store.transaction(() => {
      this.operatorEvent('reopen', taskId, { cascade: true, plan });
      this.store.setKv('cascade.pending', JSON.stringify({ target: taskId, plan, recordedAt: this.now() }));
    });
    crashPoint('cascade.afterPlan');
    this.wake();
    return { ok: true, reset: plan };
  }

  pendingCascade(): { target: Id; plan: CascadeStep[]; recordedAt: number } | undefined {
    const raw = this.store.getKv('cascade.pending');
    return raw ? (JSON.parse(raw) as { target: Id; plan: CascadeStep[]; recordedAt: number }) : undefined;
  }

  clearPendingCascade(): void {
    this.store.setKv('cascade.pending', '');
  }

  unblock(taskId: Id, opts: { answer?: string; acceptCandidate?: boolean } = {}): { ok: true } | { ok: false; reason: string } {
    const entry = this.entry(taskId);
    if (entry.status.kind !== 'blocked') return { ok: false, reason: `task ${taskId} is ${entry.status.kind}` };
    const reason = entry.status.reason;
    this.store.transaction(() => {
      this.operatorEvent('unblock', taskId, opts);
      if (opts.acceptCandidate && reason.candidate) {
        const existing = this.store.getPayloadOverlay(taskId, this.graphRev()) ?? {};
        this.store.setPayloadOverlay(taskId, this.graphRev(), { ...existing, ...reason.candidate });
      }
      const carry: AttemptContext | undefined = opts.answer
        ? { ...(entry.carry ?? {}), question: { kind: reason.kind, message: reason.message, options: reason.options }, answer: opts.answer }
        : entry.carry;
      this.transition(taskId, { kind: 'unstarted' }, 'human', 'unblock', { carry });
    });
    this.wake();
    return { ok: true };
  }

  acceptMilestone(id: Id, sha: string, version: number): { ok: true } | { ok: false; reason: string } {
    const node = this.requireNode(id);
    const entry = this.entry(id);
    if (node.kind !== 'milestone') return { ok: false, reason: `${id} is not a milestone` };
    if (entry.status.kind !== 'submitted') return { ok: false, reason: `${id} is ${entry.status.kind}` };
    if (entry.integrationSha !== sha || entry.reviewVersion !== version) {
      return { ok: false, reason: `stale review: current is version ${entry.reviewVersion} at ${entry.integrationSha}` };
    }
    this.store.transaction(() => {
      this.operatorEvent('accept', id, { sha, version });
      this.transition(id, { kind: 'done' }, 'human', 'accept', { accepted: { sha, version } }, { sha, version });
    });
    this.wake();
    return { ok: true };
  }

  rejectMilestone(id: Id, note: string): { ok: true } | { ok: false; reason: string } {
    const node = this.requireNode(id);
    const entry = this.entry(id);
    if (node.kind !== 'milestone') return { ok: false, reason: `${id} is not a milestone` };
    if (entry.status.kind !== 'submitted') return { ok: false, reason: `${id} is ${entry.status.kind}` };
    if (!note.trim()) return { ok: false, reason: 'a note is required' };
    this.store.transaction(() => {
      this.operatorEvent('reject', id, { note });
      this.transition(id, { kind: 'blocked', reason: { kind: 'milestoneRejected', message: note, note } }, 'human', 'reject', undefined, { note });
    });
    return { ok: true };
  }

  /** Queue a message for the task's live launch. See specs/operator-control "Nudge". */
  nudge(taskId: Id, message: string): { ok: true } | { ok: false; reason: string } {
    const entry = this.entry(taskId);
    const live = entry.lease ? this.store.getLaunch(entry.lease.launchId) : undefined;
    if (!live || live.status !== 'live' || (entry.status.kind !== 'running' && entry.status.kind !== 'waiting')) {
      return { ok: false, reason: `task ${taskId} is ${entry.status.kind}; no live launch to nudge` };
    }
    this.store.transaction(() => {
      this.operatorEvent('nudge', taskId, { message });
      this.queueNotice(live.launchId, { kind: 'nudge', message });
    });
    return { ok: true };
  }

  /**
   * Hand a parked launch to a worker. Idempotent per worker id. See specs/pull-runner
   * "Claim", "Worker identity", and "Access modes".
   */
  async claim(opts: { workerId: string; taskId?: Id; access?: string; attachment?: string; runner?: unknown }): Promise<ApiResponse> {
    const access = opts.access ?? 'local';
    if (!(RUNNER_ACCESSES as readonly string[]).includes(access)) return { status: 400, body: { error: `unknown access ${access}` } };
    // A worker of the other access cannot work this run's launches: refused before anything changes. See specs/pull-runner "Access modes".
    const runAccess = this.config.runner.access;
    if (access !== runAccess) {
      return { status: 409, body: { ok: false, reason: `this run is ${runAccess}; a worker with access ${access} cannot claim its launches`, access, runAccess } };
    }
    const workerId = String(opts.workerId ?? '').trim();
    if (!workerId) return { status: 400, body: { error: 'workerId is required' } };
    // The kinds this worker can run; absent means any. A worker never takes a launch prepared for a CLI it does not run. See specs/pull-runner "Claim".
    const kinds = opts.runner === undefined ? undefined : Array.isArray(opts.runner) ? opts.runner : [opts.runner];
    const badKind = kinds?.find((k) => !isRunnerKind(k));
    if (badKind !== undefined || kinds?.length === 0) return { status: 400, body: { error: `runner must be one of ${RUNNER_KINDS.join(', ')} or a list of them; got ${JSON.stringify(opts.runner)}` } };
    const runs = (l: Launch) => kinds === undefined || kinds.includes(runnerOf(l));
    // A worker holds a launch only while its task still runs or waits on it; a submitted launch stays live until reconcile ends it.
    const held = this.store.listLaunches({ status: 'live' }).find((l) => {
      if (l.worker?.id !== workerId) return false;
      const e = this.entry(l.taskId);
      return e.lease?.launchId === l.launchId && (e.status.kind === 'running' || e.status.kind === 'waiting');
    });
    if (held) {
      if (opts.taskId && opts.taskId !== held.taskId) {
        return { status: 409, body: { ok: false, reason: `worker ${workerId} already holds launch ${held.launchId} for ${held.taskId}`, launchId: held.launchId, taskId: held.taskId } };
      }
      return { status: 200, body: await this.claimResponse(held, true) };
    }
    if (this.isPaused()) return { status: 404, body: { error: 'the run is paused; nothing can be claimed', paused: true } };
    let launch: Launch | undefined;
    if (opts.taskId) {
      const launches = [...this.store.listLaunches({ taskId: opts.taskId })].sort((a, b) => a.launchNo - b.launchNo);
      const latest = launches.at(-1);
      if (!latest) return { status: 404, body: { error: `task ${opts.taskId} has no launch`, paused: false } };
      if (latest.status !== 'claimable') return { status: 409, body: { ok: false, reason: `launch of ${opts.taskId} is ${latest.status}`, state: latest.status, launchId: latest.launchId } };
      if (!runs(latest)) {
        return { status: 409, body: { ok: false, reason: `launch of ${opts.taskId} is for runner ${runnerOf(latest)}; this worker runs ${kinds!.join(', ')}`, runner: runnerOf(latest), launchId: latest.launchId } };
      }
      launch = latest;
    } else {
      launch = [...this.store.listLaunches({ status: 'claimable' })].filter(runs).sort((a, b) => (a.claimableAt ?? a.createdAt) - (b.claimableAt ?? b.createdAt) || a.createdAt - b.createdAt).at(0);
      if (!launch) return { status: 404, body: { error: kinds ? `nothing is claimable for runner ${kinds.join(', ')}` : 'nothing is claimable', paused: false } };
    }
    const entry = this.entry(launch.taskId);
    if (entry.status.kind !== 'running' || entry.lease?.launchId !== launch.launchId) {
      return { status: 409, body: { ok: false, reason: `launch ${launch.launchId} is superseded`, state: launch.status } };
    }
    const now = this.now();
    const lease = entry.lease;
    this.store.transaction(() => {
      this.store.updateLaunch(launch!.launchId, { status: 'live', worker: { id: workerId, claimedAt: now, ...(opts.attachment ? { attachment: opts.attachment } : {}) }, progressAt: now, lastSignal: 'claimed' });
      this.store.setEntry(launch!.taskId, { ...entry, lease: { ...lease, claimedAt: now, expiresAt: now + this.config.leaseTtlMs }, carry: undefined, updatedAt: now });
      this.store.appendEvent({ kind: 'launch.claimed', taskId: launch!.taskId, launchId: launch!.launchId, payload: { workerId, access } }, now);
    });
    crashPoint('claim.afterRecord');
    // A baseline fingerprint so a release can tell whether the worker touched the tree. A remote launch has no tree on
    // this host: it records none, and only the worker's calls show progress. See specs/pull-runner "Claim".
    if (accessOf(launch) !== 'remote') {
      try {
        this.store.updateLaunch(launch.launchId, { fingerprint: await this.workspace.fingerprint(launch) });
      } catch {
        /* no worktree in logic tests */
      }
    }
    const claimed = this.store.getLaunch(launch.launchId) ?? launch;
    this.wake();
    return { status: 200, body: await this.claimResponse(claimed, false) };
  }

  private async claimResponse(launch: Launch, repeated: boolean): Promise<Record<string, unknown>> {
    return accessOf(launch) === 'remote' ? this.remoteClaimResponse(launch, repeated) : this.localShapedResponse(launch, repeated);
  }

  /** The claim response of a local launch, read from its worktree. */
  private async localShapedResponse(launch: Launch, repeated: boolean): Promise<Record<string, unknown>> {
    const dir = path.join(launch.worktree, '.orchestrator');
    let brief: unknown;
    try {
      // A remote launch has no worktree: never read a path relative to the daemon's directory.
      brief = launch.worktree ? JSON.parse(await readFile(path.join(dir, 'brief.json'), 'utf8')) : undefined;
    } catch {
      brief = undefined;
    }
    const entry = this.entry(launch.taskId);
    const lease = this.leaseFacts(launch);
    let pending: Record<string, unknown> | undefined;
    if (entry.status.kind === 'waiting') pending = { seq: entry.status.seq, question: entry.status.question, ...(entry.status.answer !== undefined ? { answer: entry.status.answer } : {}) };
    else if (launch.pendingAnswer) pending = { seq: launch.pendingAnswer.seq, answer: launch.pendingAnswer.answer };
    return {
      ok: true,
      repeated,
      launchId: launch.launchId,
      taskId: launch.taskId,
      token: launch.token,
      worktree: launch.worktree,
      briefPath: path.join(dir, 'brief.md'),
      brief,
      baseSha: launch.baseSha,
      branch: launch.branch,
      apiUrl: this.apiBaseUrl,
      workerId: launch.worker?.id,
      runner: runnerOf(launch),
      commitPolicy: commitPolicyOf(launch),
      model: launch.model,
      effort: launch.effort,
      // The lease: a worker must not go longer than renewEveryMs between calls. See specs/pull-runner "Lease facts in the claim".
      ...(lease ? { leaseTtlMs: lease.ttlMs, leaseExpiresAt: lease.expiresAt, lease } : {}),
      // The daemon's stuck-fail threshold in force (an override applied), which a work loop takes as its silence limit (0: off). See specs/pull-runner "Silence limit in the claim" and "Claim states the limit in force".
      health: { stuckFailAfterMs: this.effective().config.health.stuckFailAfterMs },
      // A codex worker loop composes the same `codex exec` as a spawned launch: the effective runner.codex keys, the long-poll ceiling, and the agent environment. See specs/pull-runner "Claim".
      ...(runnerOf(launch) === 'codex' ? { codex: { settings: this.effective().config.runner.codex, maxWaitMs: this.config.maxWaitMs, retryWindowMs: this.config.retryWindowMs, env: this.agentEnv(launch) } } : {}),
      // An opencode loop likewise composes the same `opencode run` and per-launch config; `allowedTools` are the rules the derived permission ruleset comes from.
      ...(runnerOf(launch) === 'opencode'
        ? { opencode: { settings: this.effective().config.runner.opencode, allowedTools: this.openCodeAllowedTools(), maxWaitMs: this.config.maxWaitMs, retryWindowMs: this.config.retryWindowMs, env: this.agentEnv(launch) } }
        : {}),
      ...(pending ? { pending } : {}),
    };
  }

  /**
   * The claim response of a remote launch: every field of a local one but `worktree` and `briefPath`, plus the URL to
   * clone, the integration branch and the brief from the launch row (never read from disk). `carry` is the stored
   * brief's context when it holds `interrupted`, so a repeated claim answers the same. See specs/pull-runner "Claim".
   */
  private async remoteClaimResponse(launch: Launch, repeated: boolean): Promise<Record<string, unknown>> {
    const { worktree: _worktree, briefPath: _briefPath, brief: _brief, ...rest } = await this.localShapedResponse(launch, repeated);
    const context = launch.briefJson?.['context'] as Record<string, unknown> | undefined;
    const repoUrl = await this.workerRepoUrl();
    return {
      ...rest,
      access: 'remote',
      ...(repoUrl !== undefined ? { repoUrl } : {}),
      integrationBranch: this.config.integrationBranch,
      brief: launch.briefJson,
      briefMarkdown: launch.briefMarkdown,
      ...(context && context['interrupted'] ? { carry: context } : {}),
    };
  }

  /** The URL a remote worker clones: `git.workerOriginUrl`, else `git.originUrl`, else the clone's `origin` remote; as written. */
  async workerRepoUrl(): Promise<string | undefined> {
    const configured = this.config.git.workerOriginUrl ?? this.config.git.originUrl;
    if (configured) return configured;
    const r = await git(this.config.repoPath, ['remote', 'get-url', 'origin'], { allowFail: true });
    const url = r.stdout.trim();
    return r.code === 0 && url ? url : undefined;
  }

  /**
   * Hand a claimed launch back. Without progress the task returns to unstarted at no
   * cost; with progress it is a failed attempt, unless `keep` and the task's kept
   * releases are under the bound: then the work is preserved on the branch and the
   * task returns to unstarted with an `interrupted` context. See specs/pull-runner "Release".
   */
  async release(launchId: string, reason: string, opts: { keep?: boolean; reasonCode?: string; headSha?: unknown; wipCommit?: unknown } = {}): Promise<ApiResponse> {
    const launch = this.store.getLaunch(launchId);
    if (!launch || launch.status !== 'live' || !launch.worker) {
      return { status: 409, body: { ok: false, reason: `launch ${launchId} is not a live claimed launch` } };
    }
    const entry = this.entry(launch.taskId);
    if (entry.lease?.launchId !== launchId || (entry.status.kind !== 'running' && entry.status.kind !== 'waiting')) {
      return { status: 409, body: { ok: false, reason: `launch ${launchId} is superseded; task is ${entry.status.kind}` } };
    }
    if (accessOf(launch) === 'remote') return this.releaseRemote(launch, reason, opts);
    let fingerprint: string | undefined;
    try {
      fingerprint = await this.workspace.fingerprint(launch);
    } catch {
      fingerprint = undefined;
    }
    const touched = fingerprint !== undefined && launch.fingerprint !== undefined && fingerprint !== launch.fingerprint;
    const called = launch.lastSignal !== undefined && launch.lastSignal !== 'claimed' && launch.lastSignal !== 'spawned';
    const progressed = touched || called;
    const bound = this.config.daemon.maxKeptReleases;
    const interruptions = entry.interruptions ?? 0;
    const wantsKeep = Boolean(opts.keep) && (progressed || entry.status.kind === 'waiting');
    const underBound = bound === 0 || interruptions < bound;
    let preserved: { headSha: string; wipCommit?: string } | undefined;
    let keepError: string | undefined;
    if (wantsKeep && underBound) {
      try {
        preserved = await this.workspace.preserve(launch);
      } catch (err) {
        keepError = String(err);
        this.log.warn('could not preserve the worktree; releasing without keep', { launchId, err: keepError });
      }
    } else if (wantsKeep) {
      keepError = `kept releases exhausted (${interruptions} of ${bound})`;
    }
    const kept = preserved !== undefined;
    const interrupted: InterruptedContext | undefined = kept
      ? { priorLaunchId: launchId, priorBranch: launch.branch, headSha: preserved!.headSha, ...(preserved!.wipCommit ? { wipCommit: preserved!.wipCommit } : {}), reason: opts.reasonCode ?? reason, interruptions: interruptions + 1 }
      : undefined;
    let outcome: 'unstarted' | 'failed' | 'blocked';
    this.store.transaction(() => {
      this.store.appendEvent({ kind: 'launch.released', taskId: launch.taskId, launchId, payload: { reason, progressed, keep: Boolean(opts.keep), kept, workerId: launch.worker?.id } }, this.now());
      const keptPatch: Partial<Entry> = interrupted ? { carry: { ...(entry.carry ?? {}), interrupted }, interruptions: interrupted.interruptions } : {};
      if (entry.status.kind === 'waiting') {
        this.transition(launch.taskId, { kind: 'blocked', reason: { ...entry.status.question, answer: entry.status.answer } }, 'orchestrator', 'maxWaitOrDead', keptPatch);
        outcome = 'blocked';
      } else if (!progressed) {
        this.transition(launch.taskId, { kind: 'unstarted' }, 'orchestrator', 'released');
        outcome = 'unstarted';
      } else if (kept) {
        this.transition(launch.taskId, { kind: 'unstarted' }, 'orchestrator', 'released', keptPatch);
        outcome = 'unstarted';
      } else {
        const out = this.fail(launch.taskId, { kind: 'released', message: reason }, 'orchestrator', 'deadOrExpired');
        outcome = out.status.kind === 'blocked' ? 'blocked' : 'failed';
      }
      this.endLaunch(launch, 'released');
    });
    await this.workspace.remove(launch);
    this.wake();
    return {
      status: 200,
      body: { ok: true, launchId, taskId: launch.taskId, outcome: outcome!, progressed, kept, ...(kept ? { branch: launch.branch, headSha: preserved!.headSha, ...(preserved!.wipCommit ? { wipCommit: preserved!.wipCommit } : {}) } : {}), ...(keepError ? { keepError } : {}) },
    };
  }

  /**
   * Release a remote launch. The daemon holds no tree for it: progress is any agent API call since the claim, or a
   * reported `headSha` other than the base; the work is never fingerprinted, preserved or removed. A kept release
   * requires the branch tip at origin to equal `headSha` (fetched through origin): otherwise it answers 409
   * (`branchNotPushed`, `shaMismatch`) or 503 (`originUnreachable`, `originRefused`) and the launch stays live.
   * A keep without `headSha` cannot be kept and is released without keep, with `keepError` naming the field.
   * See specs/pull-runner "Release".
   */
  private async releaseRemote(launch: Launch, reason: string, opts: { keep?: boolean; reasonCode?: string; headSha?: unknown; wipCommit?: unknown }): Promise<ApiResponse> {
    const launchId = launch.launchId;
    const head = optionalFullSha(opts.headSha, 'headSha');
    if (!head.ok) return { status: 400, body: { error: head.error, field: head.field } };
    const wip = optionalFullSha(opts.wipCommit, 'wipCommit');
    if (!wip.ok) return { status: 400, body: { error: wip.error, field: wip.field } };
    const headSha = head.sha;
    let entry = this.entry(launch.taskId);
    const called = launch.lastSignal !== undefined && launch.lastSignal !== 'claimed' && launch.lastSignal !== 'spawned';
    const progressed = called || (headSha !== undefined && headSha !== launch.baseSha.toLowerCase());
    const bound = this.config.daemon.maxKeptReleases;
    const interruptions = entry.interruptions ?? 0;
    const wantsKeep = Boolean(opts.keep) && (progressed || entry.status.kind === 'waiting');
    const underBound = bound === 0 || interruptions < bound;
    let preserved: { headSha: string; wipCommit?: string } | undefined;
    let keepError: string | undefined;
    if (wantsKeep && underBound && headSha === undefined) {
      keepError = 'a remote release with keep needs headSha, the launch branch tip pushed to origin';
    } else if (wantsKeep && underBound) {
      // The pushed tip, fetched into the clone as a remote submit is sealed. A refusal changes nothing.
      const seal = await this.workspace.seal(launch, { sealedSha: headSha });
      if (!seal.ok) return sealRefusal(seal);
      preserved = { headSha: seal.sealedSha, ...(wip.sha ? { wipCommit: wip.sha } : {}) };
      // A call, a report or another release may have ended the launch while origin was fetched.
      const cur = this.store.getLaunch(launchId);
      entry = this.entry(launch.taskId);
      if (cur?.status !== 'live' || entry.lease?.launchId !== launchId || (entry.status.kind !== 'running' && entry.status.kind !== 'waiting')) {
        return { status: 409, body: { ok: false, reason: `launch ${launchId} is superseded; task is ${entry.status.kind}` } };
      }
    } else if (wantsKeep) {
      keepError = `kept releases exhausted (${interruptions} of ${bound})`;
    }
    const kept = preserved !== undefined;
    const interrupted: InterruptedContext | undefined = kept
      ? { priorLaunchId: launchId, priorBranch: launch.branch, headSha: preserved!.headSha, ...(preserved!.wipCommit ? { wipCommit: preserved!.wipCommit } : {}), reason: opts.reasonCode ?? reason, interruptions: interruptions + 1 }
      : undefined;
    let outcome: 'unstarted' | 'failed' | 'blocked';
    this.store.transaction(() => {
      this.store.appendEvent({ kind: 'launch.released', taskId: launch.taskId, launchId, payload: { reason, progressed, keep: Boolean(opts.keep), kept, workerId: launch.worker?.id, access: 'remote', ...(headSha ? { headSha } : {}) } }, this.now());
      const keptPatch: Partial<Entry> = interrupted ? { carry: { ...(entry.carry ?? {}), interrupted }, interruptions: interrupted.interruptions } : {};
      if (entry.status.kind === 'waiting') {
        this.transition(launch.taskId, { kind: 'blocked', reason: { ...entry.status.question, answer: entry.status.answer } }, 'orchestrator', 'maxWaitOrDead', keptPatch);
        outcome = 'blocked';
      } else if (!progressed) {
        this.transition(launch.taskId, { kind: 'unstarted' }, 'orchestrator', 'released');
        outcome = 'unstarted';
      } else if (kept) {
        this.transition(launch.taskId, { kind: 'unstarted' }, 'orchestrator', 'released', keptPatch);
        outcome = 'unstarted';
      } else {
        const out = this.fail(launch.taskId, { kind: 'released', message: reason }, 'orchestrator', 'deadOrExpired');
        outcome = out.status.kind === 'blocked' ? 'blocked' : 'failed';
      }
      this.endLaunch(launch, 'released');
    });
    // No worktree on this host: nothing is removed. See specs/remote-workspace.
    this.wake();
    return {
      status: 200,
      body: { ok: true, launchId, taskId: launch.taskId, outcome: outcome!, progressed, kept, ...(kept ? { branch: launch.branch, headSha: preserved!.headSha, ...(preserved!.wipCommit ? { wipCommit: preserved!.wipCommit } : {}) } : {}), ...(keepError ? { keepError } : {}) },
    };
  }

  pause(): void {
    this.store.transaction(() => {
      this.operatorEvent('pause', undefined, {});
      this.store.setKv('paused', '1');
      this.store.setKv('pausedReason', 'operator');
    });
  }

  /** Admission stops when the run cost reaches the ceiling. See specs/health-monitoring "Run cost budget". */
  pauseForBudget(runUsd: number, ceiling: number): void {
    this.store.transaction(() => {
      this.store.appendEvent({ kind: 'budget.exceeded', payload: { runUsd, ceilingUsd: ceiling } }, this.now());
      this.store.setKv('paused', '1');
      this.store.setKv('pausedReason', 'costBudget');
    });
    this.log.warn('run cost budget reached; admission paused', { runUsd, ceiling });
  }

  resume(opts: { overrideBudget?: boolean } = {}): { ok: true } | { ok: false; reason: string; runUsd?: number; ceilingUsd?: number } {
    const ceiling = ceilingUsd(this.config, this.store);
    const cost = runCostUsd(this.store);
    const over = ceiling !== undefined && cost >= ceiling;
    if (over && !opts.overrideBudget) {
      return { ok: false, reason: `costBudget: run cost ${cost} USD is at or above the ceiling ${ceiling} USD; resume with overrideBudget to raise it`, runUsd: cost, ceilingUsd: ceiling };
    }
    this.store.transaction(() => {
      if (over && opts.overrideBudget) {
        const overrides = budgetOverrides(this.store) + 1;
        this.store.setKv('budgetOverrides', String(overrides));
        this.store.appendEvent({ kind: 'budget.overridden', payload: { runUsd: cost, ceilingUsd: ceilingUsd(this.config, this.store), overrides } }, this.now());
      }
      this.operatorEvent('resume', undefined, { overrideBudget: Boolean(opts.overrideBudget) });
      this.store.setKv('paused', '0');
      this.store.setKv('pausedReason', '');
    });
    this.wake();
    return { ok: true };
  }

  isPaused(): boolean {
    return this.store.getKv('paused') === '1';
  }

  pausedReason(): PausedReason | undefined {
    if (!this.isPaused()) return undefined;
    return this.store.getKv('pausedReason') === 'costBudget' ? 'costBudget' : 'operator';
  }

  /** Review bundle for a submitted gated milestone. See operator-control "Review bundle". */
  async reviewBundle(id: Id): Promise<{ ok: true; bundle: Record<string, unknown> } | { ok: false; reason: string }> {
    const node = this.graph().nodes.get(id);
    if (!node || node.kind !== 'milestone') return { ok: false, reason: `${id} is not a milestone` };
    const entry = this.entry(id);
    if (entry.status.kind !== 'submitted' || !entry.integrationSha) return { ok: false, reason: `${id} is ${entry.status.kind}, not submitted` };
    const baseline = this.store.getKv('baselineHead') ?? '';
    const diffStat = baseline ? await this.workspace.diffStat(baseline, entry.integrationSha) : '';
    const closure = [...q.closure(this.graph(), id)]
      .filter((t) => this.graph().nodes.get(t)?.kind === 'task')
      .map((t) => {
        const published = this.store.listJobs({ taskId: t, status: 'published' }).at(-1);
        const report = this.store.getCompletionReport(t);
        return {
          taskId: t,
          status: this.entry(t).status.kind,
          publishedSha: published?.publishedSha,
          summary: report ? String(report.body['summary'] ?? '') : undefined,
          acceptance: report?.body['acceptance'],
        };
      });
    return {
      ok: true,
      bundle: {
        milestone: id,
        integrationSha: entry.integrationSha,
        reviewVersion: entry.reviewVersion,
        tag: `milestone/${id}/v${entry.reviewVersion}`,
        baseline,
        diffStat,
        closure,
        acceptanceCriteria: this.acceptanceCriteria(node),
      },
    };
  }

  status(): StatusReport {
    const g = this.graph();
    const o = this.overlay();
    const report = this.configReport();
    const byStatus: Record<StatusKind, Id[]> = { unstarted: [], running: [], waiting: [], submitted: [], done: [], failed: [], blocked: [], cancelled: [] };
    for (const node of g.nodes.values()) {
      if (node.kind === 'external') continue;
      byStatus[this.entry(node.id).status.kind].push(node.id);
    }
    const live = new Set<Id>([...byStatus.running, ...byStatus.waiting]);
    // Elapsed and idle time are awake time: gaps in the daemon's clock are left out.
    this.noteClock();
    const now = this.now();
    const liveLaunches = this.store.listLaunches({ status: 'live' }).map((l) => ({
      launchId: l.launchId,
      taskId: l.taskId,
      pid: l.pid,
      elapsedMs: elapsedMs(l, now, this),
      progressAt: l.progressAt,
      lastSignal: l.lastSignal,
      idleMs: idleMsOf(l, now, this),
      stuck: l.stuckSince !== undefined,
      costUsd: l.costUsd,
      tokens: l.tokens,
      interruptions: l.interruptions ?? 0,
      runner: runnerOf(l),
      model: l.model,
      effort: l.effort,
    }));
    const claimable = [...this.store.listLaunches({ status: 'claimable' })].sort((a, b) => (a.claimableAt ?? a.createdAt) - (b.claimableAt ?? b.createdAt));
    // Launches being prepared and prepare retries, from the store only. See specs/operator-control "Status report: launches being prepared".
    const preparing = [...this.store.listLaunches({ status: ['preparing', 'launching'] })].sort((a, b) => a.createdAt - b.createdAt);
    const preparingTasks = new Set(preparing.map((l) => l.taskId));
    const prepareRetry = (this.config.prepareCommand ? pendingPrepareRetries(this) : [])
      .filter((r) => !preparingTasks.has(r.taskId))
      .sort((a, b) => a.retryAt - b.retryAt || (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0));
    const preparingByKind = countByKind(preparing);
    for (const r of prepareRetry) preparingByKind[this.selectionFor(r.taskId).runner] += 1;
    return {
      finished: q.finished(g, o),
      stalled: q.stalled(g, o, live),
      paused: this.isPaused(),
      graphRev: g.rev,
      graphRejected: this._graphRejected,
      byStatus,
      external: q.externals(g),
      stallRoots: q.stallRoots(g, o),
      awaitingReview: q.awaitingReview(g, o),
      verifying: q.awaitingReview(g, o).filter((id) => g.nodes.get(id)?.kind === 'task'),
      openQuestions: q.openQuestions(g, o),
      liveLaunches,
      stuck: liveLaunches.filter((l) => l.stuck).map((l) => l.taskId),
      pausedReason: this.pausedReason(),
      cost: { runUsd: runCostUsd(this.store), byTask: costByTask(this.store), ceilingUsd: ceilingUsd(this.config, this.store), overrides: budgetOverrides(this.store), unpricedLaunches: unpricedLaunches(this.store) },
      tokens: tokensOf(this.store),
      // The limits in force, overrides applied; the run cost budget is a start-time key. See specs/operator-control "Status report: limits in force".
      budgets: {
        maxLaunchMs: this.effective().config.budgets.maxLaunchMs,
        maxRunCostUsd: this.config.budgets.maxRunCostUsd,
        stuckAfterMs: this.effective().config.health.stuckAfterMs,
        stuckFailAfterMs: this.effective().config.health.stuckFailAfterMs,
      },
      foreignCommits: this.foreignCommits,
      runDir: this.config.runDir ?? this.config.dataDir,
      graphPath: this.config.graphPath,
      daemonPid: process.pid,
      daemonUrl: this.apiBaseUrl,
      // The durable sequence number: a cursor for /v1/events that names no unflushed event. See specs/state-backend "Durable cursor in the status".
      latestSeq: this.store.durability().eventSeq,
      ...storeLag(this.store),
      proposals: this.store.listProposals({ status: 'pending' }).map((p) => ({ id: p.id, taskId: p.taskId, title: p.payload.title })),
      runner: { mode: this.effectiveMode(), claimWindowMs: this.config.runner.claimWindowMs, confirmProfile: this.confirmProfile() },
      profiles: this.profiles(),
      claimable: claimable.map((l) => l.taskId),
      claimableByKind: countByKind(claimable),
      preparing: preparing.map((l) => l.taskId),
      prepareRetry,
      preparingByKind,
      workers: this.store.listLaunches({ status: 'live' }).filter((l) => l.worker).map((l) => ({ id: l.worker!.id, launchId: l.launchId, taskId: l.taskId, claimedAt: l.worker!.claimedAt })),
      tracker: trackerOf(this.store),
      outboxPending: this.store.countOutbox('pending'),
      trackerErrors: this.trackerErrors(),
      deferred: this.isPaused() ? [] : this._deferred,
      idle: { quiescent: this.quiescent(), idleMs: this.idleMs(), exitAfterMs: this.config.daemon.idleExitMs },
      attachments: this.attachments(),
      config: report.config,
      toolchain: report.toolchain,
      needsConfig: report.needsConfig,
    };
  }

  trackerErrors(): TrackerError[] {
    return this.store.listOutbox({ status: 'failed' }).map((e) => ({ id: e.id, taskId: e.taskId, kind: e.kind, attempts: e.attempts, error: e.error }));
  }

  /** Phase 5 helper: refresh the foreign-commit list if the backend supports it. */
  async sweepForeignCommits(): Promise<void> {
    if (!this.verifier.foreignCommits) return;
    try {
      this.foreignCommits = await this.verifier.foreignCommits();
    } catch (err) {
      this.log.warn('foreign commit sweep failed', { err: String(err) });
    }
  }

  // ---- loop ----

  wake(): void {
    const r = this.wakeResolve;
    this.wakeResolve = undefined;
    r?.();
  }

  /** One tick; serialized. */
  tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    this.ticking = runTick(this).finally(() => {
      this.ticking = undefined;
      this.noteTickEnded();
    });
    return this.ticking;
  }

  verifierBusy(): boolean {
    return this.verifierInFlight !== undefined;
  }

  /**
   * Start the verifier worker on the oldest queued job if idle. While no check
   * command is configured, a job with commits ahead of its base is held `queued`
   * (the task stays `submitted`, no attempt is spent); a declared no-op, whose sealed
   * sha equals its base sha, never reaches the check and is taken up regardless.
   * See specs/integration-pipeline "Check and verified tree".
   */
  startVerifierIfIdle(): void {
    if (this.verifierInFlight) return;
    // Nothing starts during the hold after a gap: no job and no deferred-job pass. See specs/health-monitoring "Hold after a gap".
    if (this.inHold()) return;
    if (this.deferredJobs.size && this.now() - this.deferredTriedAt >= DEFERRED_RETRY_MS) {
      this.deferredTriedAt = this.now();
      this.verifierInFlight = this.resolveDeferredJobs()
        .catch((err) => this.log.error('deferred verifier jobs: resolution failed', { err: String(err) }))
        .finally(() => {
          this.verifierInFlight = undefined;
          this.wake();
        });
      return;
    }
    // Under verifier.mode remote a kept offered job resumes first, in the same slot. See specs/verifier-pool "Remote verification and restarts".
    if (this.config.verifier?.mode === 'remote') {
      const offered = this.store.listJobs({ status: 'checking', applied: false }).find((j) => j.offer !== undefined);
      if (offered) {
        this.startVerifierRun(offered);
        return;
      }
    }
    const checkCommand = this.effective().config.checkCommand;
    const job = this.store.listJobs({ status: 'queued' }).find((j) => {
      if (this.deferredJobs.has(j.jobId)) return false;
      if (!pushRetryDue(this.store, j.jobId, this.now())) return false;
      if (checkCommand !== undefined || j.sealedSha === j.baseSha) return true;
      if (!this.heldJobsLogged.has(j.jobId)) {
        this.heldJobsLogged.add(j.jobId);
        this.log.warn('verification held: no check command is configured for this repository; set it with configure or orchestrator-ctl config', { jobId: j.jobId, taskId: j.taskId });
      }
      return false;
    });
    if (!job) return;
    this.heldJobsLogged.delete(job.jobId);
    crashPoint('verify.afterQueued');
    this.startVerifierRun(job);
  }

  /** Take the single verifier slot for one run of `job` (a queued job, or a resumed offered one) and record how it ends. */
  private startVerifierRun(job: VerifierJob): void {
    // The run's start, after a note: a failed check whose run overlapped a gap is run again once. See specs/integration-pipeline "Failed check across a gap".
    this.noteClock();
    const startedAt = this.now();
    this.verifierInFlight = this.runVerifierJob(job, startedAt)
      .catch((err) => {
        if (err instanceof JobDroppedError) {
          this.log.info('verifier job dropped mid-flight', { jobId: job.jobId });
          return;
        }
        if (err instanceof VerifierStoppedError) {
          // The row stays as it is; the next start resumes the job when recovery keeps it. See specs/verifier-pool "Remote verification and restarts: stop".
          this.log.info('verifier job stopped while it waited for a result', { jobId: job.jobId });
          return;
        }
        if (err instanceof StoreFatalError) {
          // Nothing is recorded: the store takes no more work, and the job is decided at the next start.
          this.log.error('verifier job stopped before publication: the store is fatal', { jobId: job.jobId });
          return;
        }
        this.log.error('verifier job crashed', { jobId: job.jobId, err: String(err) });
        this.failVerifierJob(job, startedAt, 'checkFailed', String(err));
      })
      .finally(() => {
        this.verifierInFlight = undefined;
        this.wake();
      });
  }

  /**
   * Write a failed verifier run. A run that failed its check (`checkFailed`, `checkTimeout`, or a thrown run) and
   * overlapped a gap in the daemon's clock is put back to `queued` once per job instead: no attempt is spent, and
   * `verify.requeued` carries the reason and `gap: { failureKind, gapMs }`. A second such failure is written as
   * `failed`, gap or no gap. The clock is noted first, so a gap not yet seen by the note timer still counts.
   * See specs/integration-pipeline "Failed check across a gap".
   */
  private failVerifierJob(job: VerifierJob, startedAt: number, failureKind: string, output: string | undefined): void {
    this.noteClock();
    const endedAt = this.now();
    const gapMs = endedAt - startedAt - this.awakeMs(startedAt, endedAt);
    const current = this.store.getJob(job.jobId);
    const live = current !== undefined && current.status !== 'dropped' && !current.applied;
    if (live && gapMs > 0 && GAP_REQUEUE_KINDS.has(failureKind) && (current.gapRequeues ?? 0) < 1) {
      const reason = `check ${failureKind} after a run that overlapped a ${gapMs}ms gap in the daemon's clock; run again once without spending an attempt`;
      this.log.warn('verifier job requeued after a gap', { jobId: job.jobId, taskId: job.taskId, failureKind, gapMs });
      this.store.transaction(() => {
        this.store.appendEvent({ kind: 'verify.requeued', taskId: job.taskId, launchId: job.launchId, payload: { jobId: job.jobId, reason, gap: { failureKind, gapMs } } }, endedAt);
        this.store.updateJob(job.jobId, { status: 'queued', expectedHead: undefined, rebasedSha: undefined, verifiedSha: undefined, squashSha: undefined, ...NO_CLAIM, gapRequeues: (current.gapRequeues ?? 0) + 1, updatedAt: endedAt });
      });
      return;
    }
    this.store.updateJob(job.jobId, { status: 'failed', failureKind, output, ...NO_CLAIM, updatedAt: endedAt });
  }

  private async runVerifierJob(job: VerifierJob, startedAt: number): Promise<void> {
    const report = this.store.getReport(job.launchId);
    const summary = String(report?.body['summary'] ?? job.taskId);
    const noChanges = Boolean(report?.body['noChanges']);
    let warned = false;
    const outcome = await this.verifier.run(job, {
      summary,
      noChanges,
      progress: (patch) => {
        // A job dropped by a cascade must not advance; throwing here stops the verifier before it publishes.
        const cur = this.store.getJob(job.jobId);
        if (!cur || cur.status === 'dropped') throw new JobDroppedError(job.jobId);
        this.store.updateJob(job.jobId, { ...patch, updatedAt: this.now() });
      },
      publishedSince: async (baseSha) => this.publishedSince(baseSha),
      durable: async () => {
        await this.waitDurable();
        const cur = this.store.getJob(job.jobId);
        if (!cur || cur.status === 'dropped') throw new JobDroppedError(job.jobId);
      },
      // Under verifier.mode remote: the row is read after each change until a result is stored. See specs/verifier-pool "Remote verification run: the wait".
      awaitResult: async () => {
        for (;;) {
          // The read and the waiter's registration are one synchronous step: no change is missed between them.
          const cur = this.store.getJob(job.jobId);
          if (!cur || cur.status === 'dropped') throw new JobDroppedError(job.jobId);
          if (this.stopping) throw new VerifierStoppedError(job.jobId);
          if (cur.result !== undefined) return cur.result;
          if (!warned && cur.verifier === undefined && cur.offer !== undefined && this.now() - cur.offer.at >= this.config.leaseTtlMs) {
            warned = true;
            this.log.warn('verify job waits for a verifier', { jobId: job.jobId, taskId: job.taskId, waitedMs: this.now() - cur.offer.at });
          }
          await verifyJobChanged(this, job.jobId);
        }
      },
    });
    const current = this.store.getJob(job.jobId);
    if (!current || current.status === 'dropped' || current.applied) {
      this.log.info('verifier outcome discarded; job no longer live', { jobId: job.jobId });
      return;
    }
    if (outcome.kind === 'published') {
      this.store.updateJob(job.jobId, { status: 'published', publishedSha: outcome.publishedSha, verifiedSha: outcome.verifiedSha, changedFiles: outcome.changedFiles, ...NO_CLAIM, updatedAt: this.now() });
    } else if (outcome.kind === 'requeue') {
      // A refused or unreachable push waits a backoff; refusals up to git.pushRefusalLimit, then the task is blocked. See specs/integration-pipeline "Push failures are classified".
      const retry = outcome.retry ? recordPushRetry(this.store, job.jobId, outcome.retry, this.config.git, this.now()) : undefined;
      if (retry?.blocked && outcome.retry) {
        this.log.error('publication push refused; task blocked', { jobId: job.jobId, taskId: job.taskId, refusals: retry.state.refusals, reason: outcome.retry.message });
        this.store.updateJob(job.jobId, { status: 'failed', failureKind: PUSH_REFUSED, output: outcome.retry.message, ...NO_CLAIM, updatedAt: this.now() });
        return;
      }
      if (outcome.reason) this.log.warn('verifier job requeued', { jobId: job.jobId, taskId: job.taskId, reason: outcome.reason, ...(retry ? { retryInMs: retry.delayMs } : {}) });
      this.store.appendEvent({ kind: 'verify.requeued', taskId: job.taskId, launchId: job.launchId, payload: { jobId: job.jobId, ...(outcome.reason ? { reason: outcome.reason } : {}), ...(retry && outcome.retry ? { retry: outcome.retry.kind, retryAt: retry.state.retryAt, retryInMs: retry.delayMs, refusals: retry.state.refusals } : {}) } }, this.now());
      this.store.updateJob(job.jobId, { status: 'queued', expectedHead: undefined, rebasedSha: undefined, verifiedSha: undefined, squashSha: undefined, ...NO_CLAIM, updatedAt: this.now() });
    } else if (outcome.kind === 'failed') {
      this.failVerifierJob(job, startedAt, outcome.reason.kind, outcome.reason.output ?? outcome.reason.message);
    } else {
      this.store.updateJob(job.jobId, { status: 'conflict', conflictFiles: outcome.files, conflictSince: outcome.since, ...NO_CLAIM, updatedAt: this.now() });
    }
  }

  /**
   * Wait until everything committed so far is durable. A journal that went fatal never resolves `durable()`; this
   * notices and throws StoreFatalError so the caller stops with no outside effect. See specs/integration-pipeline "Durable publishing record".
   */
  waitDurable(): Promise<void> {
    return waitDurable(this.store);
  }

  /** Decide the jobs recovery deferred, now that origin may answer. */
  private async resolveDeferredJobs(): Promise<void> {
    const { decideJobsOnOrigin } = await import('../launch/recovery.js');
    await decideJobsOnOrigin(this, [...this.deferredJobs]);
  }

  /** Tasks published since a base sha, from the job log (order of publication). */
  publishedSince(baseSha: string): Id[] {
    const published = this.store.listJobs({ status: 'published' });
    const idx = published.findIndex((j) => j.publishedSha === baseSha);
    return published.slice(idx + 1).map((j) => j.taskId);
  }

  /** Start the configured prepare command for a launch; false when none is set. See specs/pull-runner "Prepare command". */
  startPrepareCommand(launch: Launch): boolean {
    return startPrepareCommand(this, launch);
  }

  /** Every prepare job has called its runner (or ended without a call). Tests only. */
  async prepareStarted(): Promise<void> {
    await Promise.all([...this.prepareJobs.values()].map((j) => j.started));
  }

  /** Every prepare job has stored its outcome. Tests only. */
  async prepareSettled(): Promise<void> {
    await Promise.all([...this.prepareJobs.values()].map((j) => j.done));
  }

  /** Wait for in-flight verification, then tick, until nothing is in flight. Tests only. */
  async settle(maxTicks = 20): Promise<void> {
    for (let i = 0; i < maxTicks; i++) {
      await this.tick();
      if (this.verifierInFlight) {
        await this.verifierInFlight;
        continue;
      }
      const pending = this.store.listJobs({ applied: false }).filter((j) => j.status !== 'queued' && j.status !== 'checking' && j.status !== 'verified' && j.status !== 'publishing');
      if (pending.length === 0 && this.store.listJobs({ status: 'queued' }).length === 0) return;
    }
  }

  async start(): Promise<void> {
    // Remote access needs a pull run with origin as the source of truth and no prepare command. See specs/pull-runner "Access modes".
    // The kind and its commit policy in force count, as the mode does.
    const eff = this.effective();
    const accessError = remoteAccessError({ ...this.config, runner: { ...eff.config.runner, kind: eff.kind.value, access: this.config.runner.access } }, this.effectiveMode());
    if (accessError) {
      this.log.error(accessError, { access: this.config.runner.access, mode: this.effectiveMode(), pushIntegration: this.config.git.pushIntegration, prepareCommand: this.config.prepareCommand !== undefined });
      throw new Error(accessError);
    }
    // Remote verification needs remote access. See specs/verifier-pool "Verifier mode: start refusal".
    const verifierError = remoteVerifierError(this.config);
    if (verifierError) {
      this.log.error(verifierError, { mode: this.config.verifier?.mode, access: this.config.runner.access });
      throw new Error(verifierError);
    }
    // See specs/state-backend "Postgres store without push integration".
    const durability = this.config.store && this.config.git ? storeDurabilityWarning(this.config) : undefined;
    if (durability) {
      this.log.warn(durability, { storeKind: this.config.store.kind, pushIntegration: this.config.git.pushIntegration });
      this.store.appendEvent({ kind: 'config.warning', payload: { code: 'postgresWithoutPushIntegration', message: durability } }, this.now());
    }
    await this.loadGraph();
    const { recover } = await import('../launch/recovery.js');
    // Cleared before recovery, which starts the prepare command again for a launch it relaunches.
    this.stopping = false;
    await recover(this);
    this.armNoteTimer();
    void this.loop();
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.tick();
      } catch (err) {
        this.log.error('tick failed', { err: String(err) });
      }
      if (!this.stopping && this.idleExitDue()) {
        const idleMs = this.idleMs();
        this.store.appendEvent({ kind: 'daemon.idleExit', payload: { idleMs } }, this.now());
        this.log.info('idle; exiting', { idleMs, exitAfterMs: this.config.daemon.idleExitMs });
        if (this.requestShutdown) {
          this.requestShutdown('idle', false);
          return;
        }
        this.stopping = true;
        this.clearNoteTimer();
        return;
      }
      await new Promise<void>((resolve) => {
        this.wakeResolve = resolve;
        this.timer = setTimeout(resolve, this.config.tickIntervalMs);
      });
      if (this.timer) clearTimeout(this.timer);
    }
  }

  async stop(opts: { reap?: boolean } = {}): Promise<void> {
    this.stopping = true;
    this.clearNoteTimer();
    this.wake();
    if (this.ticking) await this.ticking;
    // The reap comes before the prepare and verifier waits, so a check in flight cannot use up the shutdown deadline
    // before any launch is signalled. See specs/operator-control "Shutdown: reap before the verifier wait".
    if (opts.reap) await this.reapLive();
    // Prepare commands are aborted and nothing is applied; their rows stay for the next start. See specs/pull-runner "Prepare command and a task that left".
    await stopPrepareJobs(this, this.prepareStopWaitMs);
    // A run that waits for a verifier's result ends at once and records nothing; its row stays for the next start.
    // See specs/verifier-pool "Remote verification and restarts: stop".
    wakeVerifyWaiters(this);
    if (this.verifierInFlight) await this.verifierInFlight;
  }

  /**
   * A reaping shutdown's reap: one runner call for every live launch no worker holds (SIGTERM to all, one grace,
   * SIGKILL), then per launch, in listing order, its usage, its task and its end.
   * See specs/operator-control "Shutdown: launches reaped together".
   */
  private async reapLive(): Promise<void> {
    // the daemon cannot terminate a worker; its lease governs it
    const launches = this.store.listLaunches({ status: 'live' }).filter((l) => !l.worker);
    if (launches.length === 0) return;
    await this.runner.reapAll(launches);
    for (const l of launches) {
      await this.recordUsage(l);
      const e = this.entry(l.taskId);
      if ((e.status.kind === 'running' || e.status.kind === 'waiting') && e.lease?.launchId === l.launchId) {
        if (e.status.kind === 'waiting') {
          this.transition(l.taskId, { kind: 'blocked', reason: { ...e.status.question, answer: e.status.answer } }, 'orchestrator', 'maxWaitOrDead');
        } else {
          this.fail(l.taskId, { kind: 'reaped', message: 'daemon shutdown with --reap' }, 'orchestrator', 'deadOrExpired');
        }
      }
      this.endLaunch(l, 'reaped');
    }
  }
}

/** Launches per runner kind, every kind present (zero when none). */
function countByKind(launches: readonly Launch[]): Record<RunnerKind, number> {
  const out = zeroByKind();
  for (const l of launches) out[runnerOf(l)] += 1;
  return out;
}

/** A launch row or a runner's read counts as usage through any of cost, turns, duration, or tokens. */
function hasUsage(u: Pick<Usage, 'costUsd' | 'turns' | 'durationMs' | 'tokens'>): boolean {
  return u.costUsd !== undefined || u.turns !== undefined || u.durationMs !== undefined || u.tokens !== undefined;
}
