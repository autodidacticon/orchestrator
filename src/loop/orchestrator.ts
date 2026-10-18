/**
 * The orchestrator: sole writer of the overlay. Agents and humans submit intents
 * (agentCall / operator methods); the tick applies transitions and drives launches.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { alwaysValid, type BriefValidator, noRemediation, type Remediator } from '../brief/validate.js';
import { checkSubmission } from '../agent/seal.js';
import { crashPoint } from '../crash.js';
import type { Config } from '../config.js';
import { classifyReload, type ReloadReason } from '../graph/diff.js';
import { GraphValidationError, parseGraph } from '../graph/load.js';
import type { Graph, GraphNode, Id } from '../graph/model.js';
import * as q from '../graph/query.js';
import type { GraphSource } from '../graph/source.js';
import type { AgentRunner, TokenUsage, Usage } from '../runner/runner.js';
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
import { type Attachment, commitPolicyOf, type Launch, type RunnerMode, runIdOf, runnerOf, setRunId, type Store, type TrackerRecord, trackerOf, type VerifierJob } from '../state/store.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { CascadeStep } from '../graph/query.js';
import type { ReloadClassification } from '../graph/diff.js';
import { type Actor, applyTransition } from '../state/transitions.js';
import type { VerifierBackend } from '../verify/job.js';
import type { BriefInput, FallbackReport, SealResult, Workspace } from '../workspace/workspace.js';
import type { Logger, OrchestratorCore } from './core.js';
import { chainPolicy, type Deferral, type Policy } from './schedule.js';
import { pidAlive } from '../runner/subprocess.js';
import { runTick } from './tick.js';
import { deriveEffects } from '../tracker/effects.js';
import { budgetOverrides, ceilingUsd, costByTask, elapsedMs, priceFor, priceUsage, runCostUsd, tokensOf, unpricedLaunches } from '../health/budgets.js';
import { recordSignal } from '../health/progress.js';
import { humanDiagnoser, idleMsOf, type StuckDiagnoser } from '../health/stuck.js';
import { applyOverridePatch, type ConfigReport, configSummary, type OverridableKey, readOverrides, reportOf, type Resolved, resolveLayers, type SetConfigResult, START_ONLY_KEYS } from '../runs/resolve.js';
import { type CommitPolicy, defaultCodexCommit, EFFORT_FALLBACK, type Effort, isEffort, isEffortFor, isModelName, isRunnerKind, RUNNER_KINDS, type RunnerKind, type Selection } from '../runner/selection.js';
import { isolationEnv } from '../runs/childEnv.js';
import type { ShutdownCaller } from '../runs/runDir.js';
import type { ToolchainRecord } from '../toolchain/detect.js';

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

const count = z.number().int().nonnegative();

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
  latestSeq: number;
  /** Pending agent proposals awaiting a human. See specs/operator-control "Status report: proposals". */
  proposals: Array<{ id: string; taskId: Id; title: string }>;
  /** Pull runner: the mode in force, parked launches in claim order, and the workers holding launches. See specs/operator-control "Status report: workers". */
  runner: { mode: RunnerMode; claimWindowMs: number };
  claimable: Id[];
  /** Parked launches per runner kind, so a worker can tell whether any of them is for a CLI it runs. */
  claimableByKind: Record<RunnerKind, number>;
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
  private readonly heldJobsLogged = new Set<string>();
  /** Models already warned about as having tokens but no price. */
  private readonly unpricedModelsLogged = new Set<string>();

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
  private stopping = false;
  private ticking: Promise<void> | undefined;

  constructor(deps: OrchestratorDeps) {
    this.store = deps.store;
    this.config = deps.config;
    this.runner = deps.runner;
    this.workspace = deps.workspace;
    this.verifier = deps.verifier;
    this.graphSource = deps.graphSource;
    this.policy = deps.policy ?? chainPolicy(this.config);
    this.briefValidator = deps.briefValidator ?? alwaysValid;
    this.remediator = deps.remediator ?? noRemediation;
    this.stuckDiagnoser = deps.stuckDiagnoser ?? humanDiagnoser;
    this.clock = deps.clock ?? (() => Date.now());
    this.log = deps.log ?? silentLog;
    this.apiBaseUrl = deps.apiBaseUrl ?? 'http://127.0.0.1:0';
    this.boot = deps.resolved ?? resolveLayers({ base: this.config });
    this.startedAt = this.now();
    this.lastActivityAt = this.startedAt;
    if (!runIdOf(this.store)) setRunId(this.store, randomUUID().slice(0, 16));
  }

  // ---- idle exit (specs/operator-control "Idle exit") ----

  /** Nothing a tick would act on: no launch preparing, launching, live, or due to spawn; no verifier job unapplied; no pending cascade. */
  quiescent(): boolean {
    if (this.store.listLaunches({ status: ['preparing', 'launching', 'live'] }).length) return false;
    // In spawn and mixed modes a parked launch will be spawned by a tick, now or after the window; in pull mode it waits for a worker and is durable.
    if (this.effectiveMode() !== 'pull' && this.store.listLaunches({ status: 'claimable' }).length) return false;
    if (this.store.listJobs({ applied: false }).length) return false;
    if (this.pendingCascade()) return false;
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
    return Math.max(0, this.now() - this.lastActivityAt);
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

  /** End every live attachment whose chain contains any of the pids (a session end posts its ancestry). */
  endAttachmentsByPids(pids: number[], reason: string): string[] {
    const ended: string[] = [];
    for (const a of this.store.listAttachments()) {
      if (a.ended || !a.pids.some((p) => pids.includes(p))) continue;
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
  setConfig(patch: unknown): SetConfigResult {
    // The flat model and effort bind to the kind in force once the patch applies. See specs/toolchain-discovery "Runtime overrides and start-only keys".
    const parsed = applyOverridePatch(this.boot.inputs, readOverrides(this.store), patch ?? {});
    if (!parsed.ok) return { ok: false, status: 400, key: parsed.key, error: `${parsed.key || 'config'}: ${parsed.error}` };
    // Applied keys are named as the caller sent them: a flat model stays `model` though it is stored under its kind.
    const doc = (patch ?? {}) as Record<string, unknown>;
    const keys = Object.keys(doc).filter((k) => doc[k] !== undefined) as OverridableKey[];
    const startOnly = keys.filter((k) => START_ONLY_KEYS.includes(k));
    if (startOnly.length) return { ok: false, status: 409, startOnly, error: `${startOnly.join(', ')} is start-only: pass it to start, which applies it when the daemon is spawned` };
    const next = parsed.next;
    this.store.transaction(() => {
      this.operatorEvent('config', undefined, { patch: parsed.patch, overrides: next });
      this.store.setKv('config.overrides', JSON.stringify(next));
    });
    const report = this.configReport();
    this.store.appendEvent({ kind: 'config.resolved', payload: configSummary(report) }, this.now());
    this.onConfigChanged?.(report);
    this.wake();
    return { ok: true, applied: keys, report };
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
    const payload = this.payloadOf(this.requireNode(taskId));
    const eff = this.effective();
    const runner: RunnerKind = isRunnerKind(payload['runner']) ? payload['runner'] : eff.kind.value;
    const defaults = runner === 'codex' ? eff.config.runner.codex : eff.config.runner.claude;
    const requested: Effort = isEffort(payload['effort']) ? payload['effort'] : defaults.effort;
    const fallback = EFFORT_FALLBACK[runner]?.[requested];
    const effort: Effort = isEffortFor(runner, requested) ? requested : fallback !== undefined && isEffortFor(runner, fallback) ? fallback : defaults.effort;
    return {
      runner,
      model: isModelName(payload['model']) ? payload['model'] : defaults.model,
      effort,
      ...(effort !== requested ? { effortRequested: requested } : {}),
    };
  }

  commitPolicyFor(kind: RunnerKind): CommitPolicy {
    const eff = this.effective();
    return kind === 'codex' ? eff.config.runner.codex.commit ?? defaultCodexCommit(eff.config.runner.codex.sandbox) : eff.config.runner.claude.commit;
  }

  /**
   * Seal a submission under the launch's commit policy: `agent` refuses a dirty
   * worktree, `daemon` commits it as the orchestrator with the report summary as
   * the message. See specs/agent-protocol "Submission sealing".
   */
  async sealSubmission(launch: Launch, summary: unknown): Promise<SealResult> {
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
      carry: entry.carry as Record<string, unknown> | undefined,
      apiBaseUrl: this.apiBaseUrl,
      retryWindowMs: this.config.retryWindowMs,
      checkCommand: eff.config.checkCommand,
      integrationBranch: this.config.integrationBranch,
      // Only a launch the daemon spawns gets the list; in pull mode every launch is claimed and the worker runs under its own permissions.
      // The list is a Claude Code permission flag, so a launch of another kind never gets it. See specs/worker-runners.
      allowedTools: eff.allowedTools.applied && this.effectiveMode() !== 'pull' && runnerOf(launch) === 'claude-code' ? eff.allowedTools.value : undefined,
      // The brief's commit sentences key off the policy fixed on the row; the sandbox is the codex one in force. See specs/worker-runners "Sandbox and commit policy".
      runner: { kind: runnerOf(launch), commitPolicy: commitPolicyOf(launch), ...(runnerOf(launch) === 'codex' ? { sandbox: eff.config.runner.codex.sandbox } : {}) },
    };
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
  }

  // ---- graph ----

  async loadGraph(): Promise<void> {
    if (!this._graph) {
      const snap = this.store.getSnapshot();
      if (snap) this._graph = parseGraph(snap.content);
    }
    let polled: { content: string; graph: Graph } | undefined;
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

  /** Every API call is progress; a heartbeat with new text is progress with the text kept. */
  private recordProgress(launch: Launch, op: AgentOp, body: Record<string, unknown>): void {
    const cur = this.store.getLaunch(launch.launchId);
    if (!cur) return;
    const text = body['progress'];
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
    const parsed = workerUsageBodySchema.safeParse(body);
    if (!parsed.success) return { status: 400, body: { ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') } };
    const { workerId, usage } = parsed.data;
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

  async agentCall(launchId: string, token: string, op: AgentOp, body: Record<string, unknown> = {}): Promise<ApiResponse> {
    const launch = this.authenticate(launchId, token);
    if (!launch) return { status: 401, body: { error: 'unauthorized' } };
    this.renewLease(launch);
    this.recordProgress(launch, op, body);
    switch (op) {
      case 'heartbeat':
        this.store.appendEvent({ kind: 'agent.heartbeat', taskId: launch.taskId, launchId, payload: body }, this.now());
        return { status: 200, body: { ok: true } };
      case 'inbox': {
        const notices = launch.notices ?? [];
        if (notices.length) this.store.updateLaunch(launchId, { notices: [] });
        return { status: 200, body: { notices } };
      }
      case 'log': {
        const seq = typeof body['seq'] === 'number' ? (body['seq'] as number) : undefined;
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

  private seqOf(body: Record<string, unknown>): number | undefined {
    const s = body['seq'];
    return typeof s === 'number' && Number.isInteger(s) && s >= 0 ? s : undefined;
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

    const seal = await this.sealSubmission(launch, parsed.data.summary);
    if (!seal.ok) return { status: 409, body: { error: 'dirtyWorktree', files: seal.dirty } };

    const res = this.store.transaction((): ApiResponse => {
      const cur = this.entry(launch.taskId);
      if (cur.status.kind !== 'running') return { status: 409, body: { error: 'notRunning', status: cur.status.kind } };
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
    this.store.transaction(() => {
      this.operatorEvent('cancel', taskId, { reason, releasesDependents });
      this.transition(taskId, { kind: 'cancelled', reason, releasesDependents }, 'human', 'cancel');
      for (const job of this.store.listJobs({ taskId, status: 'queued' })) {
        this.store.updateJob(job.jobId, { status: 'dropped', applied: true, updatedAt: this.now() });
      }
    });
    for (const l of this.store.listLaunches({ taskId, status: 'live' })) {
      this.resolveWaiters(l.launchId, { status: 200, body: { timeout: true, reason: 'cancelled' } });
    }
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
      priorBranch: prior.branch,
      ...(published?.publishedSha ? { priorPublishedSha: published.publishedSha } : {}),
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
    if (access === 'remote') return { status: 501, body: { error: 'access remote is reserved for a later change; only local workers are supported', access } };
    if (access !== 'local') return { status: 400, body: { error: `unknown access ${access}` } };
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
    // A baseline fingerprint so a release can tell whether the worker touched the tree.
    try {
      this.store.updateLaunch(launch.launchId, { fingerprint: await this.workspace.fingerprint(launch) });
    } catch {
      /* no worktree in logic tests */
    }
    const claimed = this.store.getLaunch(launch.launchId) ?? launch;
    this.wake();
    return { status: 200, body: await this.claimResponse(claimed, false) };
  }

  private async claimResponse(launch: Launch, repeated: boolean): Promise<Record<string, unknown>> {
    const dir = path.join(launch.worktree, '.orchestrator');
    let brief: unknown;
    try {
      brief = JSON.parse(await readFile(path.join(dir, 'brief.json'), 'utf8'));
    } catch {
      brief = undefined;
    }
    const entry = this.entry(launch.taskId);
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
      model: launch.model,
      effort: launch.effort,
      ...(pending ? { pending } : {}),
    };
  }

  /**
   * Hand a claimed launch back. Without progress the task returns to unstarted at no
   * cost; with progress it is a failed attempt, unless `keep` and the task's kept
   * releases are under the bound: then the work is preserved on the branch and the
   * task returns to unstarted with an `interrupted` context. See specs/pull-runner "Release".
   */
  async release(launchId: string, reason: string, opts: { keep?: boolean; reasonCode?: string } = {}): Promise<ApiResponse> {
    const launch = this.store.getLaunch(launchId);
    if (!launch || launch.status !== 'live' || !launch.worker) {
      return { status: 409, body: { ok: false, reason: `launch ${launchId} is not a live claimed launch` } };
    }
    const entry = this.entry(launch.taskId);
    if (entry.lease?.launchId !== launchId || (entry.status.kind !== 'running' && entry.status.kind !== 'waiting')) {
      return { status: 409, body: { ok: false, reason: `launch ${launchId} is superseded; task is ${entry.status.kind}` } };
    }
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
    const now = this.now();
    const liveLaunches = this.store.listLaunches({ status: 'live' }).map((l) => ({
      launchId: l.launchId,
      taskId: l.taskId,
      pid: l.pid,
      elapsedMs: elapsedMs(l, now),
      progressAt: l.progressAt,
      lastSignal: l.lastSignal,
      idleMs: idleMsOf(l, now),
      stuck: l.stuckSince !== undefined,
      costUsd: l.costUsd,
      tokens: l.tokens,
      interruptions: l.interruptions ?? 0,
      runner: runnerOf(l),
      model: l.model,
      effort: l.effort,
    }));
    const claimable = [...this.store.listLaunches({ status: 'claimable' })].sort((a, b) => (a.claimableAt ?? a.createdAt) - (b.claimableAt ?? b.createdAt));
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
      openQuestions: q.openQuestions(g, o),
      liveLaunches,
      stuck: liveLaunches.filter((l) => l.stuck).map((l) => l.taskId),
      pausedReason: this.pausedReason(),
      cost: { runUsd: runCostUsd(this.store), byTask: costByTask(this.store), ceilingUsd: ceilingUsd(this.config, this.store), overrides: budgetOverrides(this.store), unpricedLaunches: unpricedLaunches(this.store) },
      tokens: tokensOf(this.store),
      budgets: {
        maxLaunchMs: this.config.budgets.maxLaunchMs,
        maxRunCostUsd: this.config.budgets.maxRunCostUsd,
        stuckAfterMs: this.config.health.stuckAfterMs,
        stuckFailAfterMs: this.config.health.stuckFailAfterMs,
      },
      foreignCommits: this.foreignCommits,
      runDir: this.config.runDir ?? this.config.dataDir,
      graphPath: this.config.graphPath,
      daemonPid: process.pid,
      daemonUrl: this.apiBaseUrl,
      latestSeq: this.store.latestEventSeq(),
      proposals: this.store.listProposals({ status: 'pending' }).map((p) => ({ id: p.id, taskId: p.taskId, title: p.payload.title })),
      runner: { mode: this.effectiveMode(), claimWindowMs: this.config.runner.claimWindowMs },
      claimable: claimable.map((l) => l.taskId),
      claimableByKind: countByKind(claimable),
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
    const checkCommand = this.effective().config.checkCommand;
    const job = this.store.listJobs({ status: 'queued' }).find((j) => {
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
    this.verifierInFlight = this.runVerifierJob(job)
      .catch((err) => {
        if (err instanceof JobDroppedError) {
          this.log.info('verifier job dropped mid-flight', { jobId: job.jobId });
          return;
        }
        this.log.error('verifier job crashed', { jobId: job.jobId, err: String(err) });
        this.store.updateJob(job.jobId, { status: 'failed', failureKind: 'checkFailed', output: String(err), updatedAt: this.now() });
      })
      .finally(() => {
        this.verifierInFlight = undefined;
        this.wake();
      });
  }

  private async runVerifierJob(job: VerifierJob): Promise<void> {
    const report = this.store.getReport(job.launchId);
    const summary = String(report?.body['summary'] ?? job.taskId);
    const noChanges = Boolean(report?.body['noChanges']);
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
    });
    const current = this.store.getJob(job.jobId);
    if (!current || current.status === 'dropped' || current.applied) {
      this.log.info('verifier outcome discarded; job no longer live', { jobId: job.jobId });
      return;
    }
    if (outcome.kind === 'published') {
      this.store.updateJob(job.jobId, { status: 'published', publishedSha: outcome.publishedSha, verifiedSha: outcome.verifiedSha, changedFiles: outcome.changedFiles, updatedAt: this.now() });
    } else if (outcome.kind === 'requeue') {
      this.store.appendEvent({ kind: 'verify.requeued', taskId: job.taskId, launchId: job.launchId, payload: { jobId: job.jobId } }, this.now());
      this.store.updateJob(job.jobId, { status: 'queued', expectedHead: undefined, rebasedSha: undefined, verifiedSha: undefined, squashSha: undefined, updatedAt: this.now() });
    } else if (outcome.kind === 'failed') {
      this.store.updateJob(job.jobId, { status: 'failed', failureKind: outcome.reason.kind, output: outcome.reason.output ?? outcome.reason.message, updatedAt: this.now() });
    } else {
      this.store.updateJob(job.jobId, { status: 'conflict', conflictFiles: outcome.files, conflictSince: outcome.since, updatedAt: this.now() });
    }
  }

  /** Tasks published since a base sha, from the job log (order of publication). */
  publishedSince(baseSha: string): Id[] {
    const published = this.store.listJobs({ status: 'published' });
    const idx = published.findIndex((j) => j.publishedSha === baseSha);
    return published.slice(idx + 1).map((j) => j.taskId);
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
    await this.loadGraph();
    const { recover } = await import('../launch/recovery.js');
    await recover(this);
    this.stopping = false;
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
    this.wake();
    if (this.ticking) await this.ticking;
    if (this.verifierInFlight) await this.verifierInFlight;
    if (opts.reap) {
      for (const l of this.store.listLaunches({ status: 'live' })) {
        if (l.worker) continue; // the daemon cannot terminate a worker; its lease governs it
        await this.runner.reap(l);
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
}

/** Launches per runner kind, every kind present (zero when none). */
function countByKind(launches: readonly Launch[]): Record<RunnerKind, number> {
  const out = Object.fromEntries(RUNNER_KINDS.map((k) => [k, 0])) as Record<RunnerKind, number>;
  for (const l of launches) out[runnerOf(l)] += 1;
  return out;
}

/** A launch row or a runner's read counts as usage through any of cost, turns, duration, or tokens. */
function hasUsage(u: Pick<Usage, 'costUsd' | 'turns' | 'durationMs' | 'tokens'>): boolean {
  return u.costUsd !== undefined || u.turns !== undefined || u.durationMs !== undefined || u.tokens !== undefined;
}
