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
import type { AgentRunner } from '../runner/runner.js';
import {
  type AttemptContext,
  type BlockedReason,
  defaultEntry,
  type Entry,
  type FailedReason,
  type Overlay,
  type Question,
  type Status,
  type StatusKind,
} from '../state/status.js';
import type { Launch, Store, VerifierJob } from '../state/store.js';
import { type Actor, applyTransition } from '../state/transitions.js';
import type { VerifierBackend } from '../verify/job.js';
import type { BriefInput, FallbackReport, Workspace } from '../workspace/workspace.js';
import type { Logger, OrchestratorCore } from './core.js';
import { fifoPolicy, type Policy } from './schedule.js';
import { runTick } from './tick.js';

export const questionSchema = z.object({
  kind: z.enum(['needsDecision', 'needsAccess', 'impossible', 'dependencyCancelled', 'outOfScope', 'insufficientSpec', 'milestoneRejected']),
  message: z.string().min(1),
  options: z.array(z.string()).optional(),
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
});

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
  clock?: () => number;
  log?: Logger;
  apiBaseUrl?: string;
}

export interface StatusReport {
  finished: boolean;
  stalled: boolean;
  paused: boolean;
  graphRev: string | undefined;
  graphRejected: { reasons: string[] } | undefined;
  byStatus: Record<StatusKind, Id[]>;
  stallRoots: Id[];
  awaitingReview: Id[];
  openQuestions: Id[];
  liveLaunches: Array<{ launchId: string; taskId: Id; pid?: number }>;
  foreignCommits: string[];
}

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
  readonly log: Logger;
  readonly graphSource: GraphSource;
  apiBaseUrl: string;
  foreignCommits: string[] = [];

  private readonly clock: () => number;
  private _graph: Graph | undefined;
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
    this.policy = deps.policy ?? fifoPolicy;
    this.briefValidator = deps.briefValidator ?? alwaysValid;
    this.remediator = deps.remediator ?? noRemediation;
    this.clock = deps.clock ?? (() => Date.now());
    this.log = deps.log ?? silentLog;
    this.apiBaseUrl = deps.apiBaseUrl ?? 'http://127.0.0.1:0';
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

  overlay(): Overlay {
    return this.store.allEntries();
  }

  recordTransition(id: Id, from: StatusKind, to: StatusKind, actor: Actor, trigger: string, extra: Record<string, unknown> = {}): void {
    this.store.appendEvent({ kind: 'transition', taskId: id, payload: { from, to, actor, trigger, ...extra } }, this.now());
    this.log.info(`transition ${id}: ${from} -> ${to} (${actor}/${trigger})`, extra);
  }

  /** Effective payload: node payload merged with any remediation overlay for the current rev. */
  payloadOf(node: GraphNode): Record<string, unknown> {
    const overlay = this.store.getPayloadOverlay(node.id, this.graphRev());
    return overlay ? { ...node.payload, ...overlay } : { ...node.payload };
  }

  briefInput(launch: Launch): BriefInput {
    const node = this.requireNode(launch.taskId);
    const entry = this.entry(launch.taskId);
    const depReports = node.deps.map((d) => {
      const ds = this.entry(d).status;
      return {
        taskId: d,
        report: this.store.getCompletionReport(d),
        cancelled: ds.kind === 'cancelled' ? { reason: ds.reason } : undefined,
      };
    });
    return {
      launch,
      node: { id: node.id, kind: node.kind, payload: this.payloadOf(node), deps: node.deps },
      depReports,
      carry: entry.carry as Record<string, unknown> | undefined,
      apiBaseUrl: this.apiBaseUrl,
      retryWindowMs: this.config.retryWindowMs,
      checkCommand: this.config.checkCommand,
      integrationBranch: this.config.integrationBranch,
    };
  }

  agentEnv(launch: Launch): Record<string, string> {
    return {
      ORCH_LAUNCH_ID: launch.launchId,
      ORCH_TOKEN: launch.token,
      ORCH_API: this.apiBaseUrl,
      ORCH_TASK_ID: launch.taskId,
      ORCH_WORKTREE: launch.worktree,
    };
  }

  // ---- transitions ----

  /** Apply a transition inside a store transaction and record the event. */
  transition(id: Id, next: Status, actor: Actor, trigger: string, patch?: Partial<Entry>): Entry {
    return this.store.transaction(() => {
      const node = this.requireNode(id);
      const prev = this.entry(id);
      const out = applyTransition(prev, next, { nodeId: id, nodeKind: node.kind, actor, trigger, now: this.now(), patch });
      this.store.setEntry(id, out);
      this.recordTransition(id, prev.status.kind, next.kind, actor, trigger);
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
      return this.transition(id, { kind: 'blocked', reason: blocked }, 'orchestrator', 'exhausted');
    });
  }

  endLaunch(launch: Launch, endReason: string): void {
    if (launch.status === 'ended' || launch.status === 'revoked') return;
    this.store.updateLaunch(launch.launchId, { status: 'ended', endedAt: this.now(), endReason });
    this.store.appendEvent({ kind: 'launch.ended', taskId: launch.taskId, launchId: launch.launchId, payload: { endReason } }, this.now());
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
    if (this._graph) {
      const cls = classifyReload(this._graph, polled.graph, this.overlay());
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
    this.store.appendEvent({ kind: 'graph.loaded', payload: { rev: polled.graph.rev } }, this.now());
  }

  // ---- agent API (transport independent) ----

  private authenticate(launchId: string, token: string): Launch | undefined {
    const launch = this.store.getLaunch(launchId);
    if (!launch || launch.token !== token) return undefined;
    if (launch.status !== 'live' && launch.status !== 'launching') return undefined;
    return launch;
  }

  private renewLease(launch: Launch): void {
    const e = this.entry(launch.taskId);
    if ((e.status.kind === 'running' || e.status.kind === 'waiting') && e.lease?.launchId === launch.launchId) {
      this.store.setEntry(launch.taskId, { ...e, lease: { ...e.lease, expiresAt: this.now() + this.config.leaseTtlMs } });
    }
  }

  async agentCall(launchId: string, token: string, op: AgentOp, body: Record<string, unknown> = {}): Promise<ApiResponse> {
    const launch = this.authenticate(launchId, token);
    if (!launch) return { status: 401, body: { error: 'unauthorized' } };
    this.renewLease(launch);
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

    const seal = await this.workspace.seal(launch);
    if (!seal.ok) return { status: 409, body: { error: 'dirtyWorktree', files: seal.dirty } };

    const res = this.store.transaction((): ApiResponse => {
      const cur = this.entry(launch.taskId);
      if (cur.status.kind !== 'running') return { status: 409, body: { error: 'notRunning', status: cur.status.kind } };
      this.store.appendEvent({ kind: 'agent.report', taskId: launch.taskId, launchId: launch.launchId, payload: { kind: 'submit', seq, sealedSha: seal.sealedSha } }, this.now());
      const outcome = this.acceptSubmission(launch, parsed.data, seal.sealedSha);
      this.store.putDedup(launch.launchId, seq, outcome);
      return outcome;
    });
    crashPoint('api.afterEventCommit');
    this.wake();
    return res;
  }

  /** Structural checks, then submitted + verifier job. Runs inside a transaction. */
  acceptSubmission(launch: Launch, report: z.infer<typeof submitBodySchema>, sealedSha: string): ApiResponse {
    const node = this.requireNode(launch.taskId);
    this.store.putReport({ launchId: launch.launchId, taskId: launch.taskId, kind: 'submit', body: report, sealedSha, createdAt: this.now() });
    // The agent's claim is recorded as submitted; structural checks are the verifier's first step.
    this.transition(launch.taskId, { kind: 'submitted' }, 'agent', 'submit');
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
      this.store.appendEvent({ kind: 'agent.fallback', taskId: launch.taskId, launchId: launch.launchId, payload: { kind: fb.kind, seq: fb.seq } }, this.now());
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

  reopen(taskId: Id): { ok: true } | { ok: false; reason: string; blockers?: Id[] } {
    const r = q.revocable(this.graph(), this.overlay(), taskId);
    if (!r.ok) return { ok: false, reason: r.reason, blockers: r.blockers };
    const entry = this.entry(taskId);
    this.store.transaction(() => {
      this.operatorEvent('reopen', taskId, {});
      this.transition(taskId, { kind: 'unstarted' }, 'human', entry.status.kind === 'done' ? 'reopen' : 'uncancel', { carry: undefined, accepted: undefined });
    });
    this.wake();
    return { ok: true };
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
      this.transition(id, { kind: 'done' }, 'human', 'accept', { accepted: { sha, version } });
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
      this.transition(id, { kind: 'blocked', reason: { kind: 'milestoneRejected', message: note, note } }, 'human', 'reject');
    });
    return { ok: true };
  }

  pause(): void {
    this.operatorEvent('pause', undefined, {});
    this.store.setKv('paused', '1');
  }

  resume(): void {
    this.operatorEvent('resume', undefined, {});
    this.store.setKv('paused', '0');
    this.wake();
  }

  isPaused(): boolean {
    return this.store.getKv('paused') === '1';
  }

  status(): StatusReport {
    const g = this.graph();
    const o = this.overlay();
    const byStatus: Record<StatusKind, Id[]> = { unstarted: [], running: [], waiting: [], submitted: [], done: [], failed: [], blocked: [], cancelled: [] };
    for (const id of g.nodes.keys()) byStatus[this.entry(id).status.kind].push(id);
    const live = new Set<Id>([...byStatus.running, ...byStatus.waiting]);
    return {
      finished: q.finished(g, o),
      stalled: q.stalled(g, o, live),
      paused: this.isPaused(),
      graphRev: g.rev,
      graphRejected: this._graphRejected,
      byStatus,
      stallRoots: q.stallRoots(g, o),
      awaitingReview: q.awaitingReview(g, o),
      openQuestions: q.openQuestions(g, o),
      liveLaunches: this.store.listLaunches({ status: 'live' }).map((l) => ({ launchId: l.launchId, taskId: l.taskId, pid: l.pid })),
      foreignCommits: this.foreignCommits,
    };
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
    });
    return this.ticking;
  }

  verifierBusy(): boolean {
    return this.verifierInFlight !== undefined;
  }

  /** Start the verifier worker on the oldest queued job if idle. */
  startVerifierIfIdle(): void {
    if (this.verifierInFlight) return;
    const [job] = this.store.listJobs({ status: 'queued' });
    if (!job) return;
    crashPoint('verify.afterQueued');
    this.verifierInFlight = this.runVerifierJob(job)
      .catch((err) => {
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
      progress: (patch) => this.store.updateJob(job.jobId, { ...patch, updatedAt: this.now() }),
      publishedSince: async (baseSha) => this.publishedSince(baseSha),
    });
    if (outcome.kind === 'published') {
      this.store.updateJob(job.jobId, { status: 'published', publishedSha: outcome.publishedSha, verifiedSha: outcome.verifiedSha, updatedAt: this.now() });
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
        await this.runner.reap(l);
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
