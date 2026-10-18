/**
 * Store interface. Synchronous on purpose: node:sqlite is synchronous, which
 * makes a claim, a dedup write, or a transition one transaction.
 */
import type { Id } from '../graph/model.js';
import type { Effort } from '../runner/selection.js';
import type { Entry } from './status.js';

export type LaunchStatus = 'preparing' | 'claimable' | 'launching' | 'live' | 'ended' | 'revoked';

export type RunnerMode = 'spawn' | 'pull' | 'mixed';

/** A session's operator MCP server registered with the daemon: its pid chain and, once ended, why. */
export interface Attachment {
  id: string;
  /** The registering process's pid followed by its ancestors. */
  pids: number[];
  since: number;
  ended?: { at: number; reason: string };
}

export interface Launch {
  launchId: string;
  taskId: Id;
  /** Failure-budget attempt number this launch belongs to (1-based). */
  attempt: number;
  /** Monotone per-task launch number (names branch and worktree). */
  launchNo: number;
  status: LaunchStatus;
  token: string;
  branch: string;
  worktree: string;
  baseSha: string;
  graphRev: string;
  pid?: number;
  spawnedAt?: number;
  /** Pull and mixed modes: when the launch was parked for a worker. See specs/pull-runner. */
  claimableAt?: number;
  /** Set when a worker claimed the launch; such a launch has no pid and is governed by its lease. */
  worker?: { id: string; claimedAt: number; attachment?: string };
  /** The task's kept releases when this launch was created. See specs/pull-runner "Release". */
  interruptions?: number;
  endedAt?: number;
  endReason?: string;
  /** When a submit was accepted; the report grace runs from here. See specs/health-monitoring "Usage accounting". */
  reportedAt?: number;
  createdAt: number;
  /** Last answered block, for replay after disconnect. */
  pendingAnswer?: { seq: number; answer: string };
  /** Notices for the agent's inbox (pull). */
  notices?: Array<{ kind: string; [k: string]: unknown }>;
  /** Health: when progress was last observed and what it was. See specs/health-monitoring. */
  progressAt?: number;
  lastSignal?: string;
  progressText?: string;
  fingerprint?: string;
  stuckSince?: number;
  /** Time spent waiting on questions, excluded from the launch time budget. */
  waitedMs?: number;
  waitingSince?: number;
  /** The worker model and effort fixed when the launch was prepared. See specs/model-selection. */
  model?: string;
  effort?: Effort;
  /** Usage read from the runner when the launch ended. */
  costUsd?: number;
  turns?: number;
  durationMs?: number;
}

export type JobStatus =
  | 'queued'
  | 'checking'
  | 'verified'
  | 'publishing'
  | 'published'
  | 'failed'
  | 'conflict'
  | 'dropped';

export interface VerifierJob {
  jobId: string;
  taskId: Id;
  launchId: string;
  sealedSha: string;
  baseSha: string;
  status: JobStatus;
  /** Integration head observed when the job started (CAS expected value). */
  expectedHead?: string;
  rebasedSha?: string;
  verifiedSha?: string;
  squashSha?: string;
  publishedSha?: string;
  /** Files the published commit touched; the base-moved notice lists them. */
  changedFiles?: string[];
  output?: string;
  /** Conflict details. */
  conflictFiles?: string[];
  conflictSince?: Id[];
  failureKind?: string;
  /** Terminal result applied to the overlay by the tick. */
  applied: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface StoredReport {
  launchId: string;
  taskId: Id;
  kind: 'submit' | 'fail' | 'block';
  body: Record<string, unknown>;
  sealedSha?: string;
  createdAt: number;
}

export type EffectKind = 'setState' | 'comment';
export type EffectStatus = 'pending' | 'applied' | 'failed';

/** A tracker-bound effect derived from a transition. See specs/tracker-sync "Durable outbox". */
export interface OutboxEffect {
  id: number;
  /** Sequence of the transition event that produced it. */
  sourceSeq: number;
  /** The issue: the node id the effect targets (a task or its parent milestone). */
  taskId: Id;
  kind: EffectKind;
  payload: Record<string, unknown>;
  status: EffectStatus;
  attempts: number;
  result?: unknown;
  error?: string;
  createdAt: number;
  appliedAt?: number;
}

export type NewOutboxEffect = Pick<OutboxEffect, 'sourceSeq' | 'taskId' | 'kind' | 'payload' | 'createdAt'>;

export interface TrackerRecord {
  kind: 'linear' | 'atlassian' | 'github';
  /** Linear workspace key, Jira site, or GitHub `owner/repo`. */
  workspace?: string;
  /** GitHub only: the label that stands for the in-progress state. See specs/graph-import "Tracker record". */
  inProgressLabel?: string;
  recordedAt: number;
}

export type ProposalStatus = 'pending' | 'accepted' | 'rejected';

/** A follow-up task an agent proposed in its report. See specs/agent-protocol "Proposals in the report". */
export interface ProposalPayload {
  title: string;
  description: string;
  acceptanceCriteria: string[];
  deps?: Id[];
  scope?: string[];
  labels?: string[];
}

export interface Proposal {
  /** `<taskId>-p<n>`. */
  id: string;
  taskId: Id;
  launchId: string;
  status: ProposalStatus;
  payload: ProposalPayload;
  /** The graph node the proposal became, once accepted. */
  nodeId?: Id;
  note?: string;
  createdAt: number;
  decidedAt?: number;
}

export interface EventInput {
  kind: string;
  taskId?: Id;
  launchId?: string;
  payload?: Record<string, unknown>;
}

export interface StoredEvent extends EventInput {
  seq: number;
  ts: number;
}

export interface Store {
  transaction<T>(fn: () => T): T;

  getEntry(id: Id): Entry | undefined;
  setEntry(id: Id, entry: Entry): void;
  allEntries(): Map<Id, Entry>;

  appendEvent(ev: EventInput, ts: number): number;
  listEvents(filter?: { kind?: string; kinds?: string[]; taskId?: Id; launchId?: string; afterSeq?: number; limit?: number }): StoredEvent[];
  latestEventSeq(): number;

  getDedup(launchId: string, seq: number): unknown | undefined;
  putDedup(launchId: string, seq: number, response: unknown): void;

  createLaunch(l: Launch): void;
  updateLaunch(launchId: string, patch: Partial<Launch>): void;
  getLaunch(launchId: string): Launch | undefined;
  getLaunchByToken(token: string): Launch | undefined;
  listLaunches(filter?: { status?: LaunchStatus | LaunchStatus[]; taskId?: Id }): Launch[];

  createJob(j: VerifierJob): void;
  updateJob(jobId: string, patch: Partial<VerifierJob>): void;
  getJob(jobId: string): VerifierJob | undefined;
  listJobs(filter?: { status?: JobStatus | JobStatus[]; taskId?: Id; applied?: boolean }): VerifierJob[];
  /** Mark a job dropped and applied; a dropped job's in-flight result is discarded. */
  dropJob(jobId: string): void;

  createProposal(p: Proposal): void;
  updateProposal(id: string, patch: Partial<Proposal>): void;
  getProposal(id: string): Proposal | undefined;
  listProposals(filter?: { status?: ProposalStatus; taskId?: Id }): Proposal[];

  putReport(r: StoredReport): void;
  getReport(launchId: string): StoredReport | undefined;
  /** Latest submit report for a task (the completion report dependents receive). */
  getCompletionReport(taskId: Id): StoredReport | undefined;

  getPayloadOverlay(taskId: Id, graphRev: string): Record<string, unknown> | undefined;
  setPayloadOverlay(taskId: Id, graphRev: string, payload: Record<string, unknown>): void;

  getSnapshot(): { rev: string; content: string } | undefined;
  setSnapshot(rev: string, content: string): void;

  getKv(key: string): string | undefined;
  setKv(key: string, value: string): void;

  /** Session attachments, kept under kv `attachment:<id>`. See specs/operator-control "Session attachments". */
  listAttachments(): Attachment[];
  putAttachment(a: Attachment): void;
  deleteAttachment(id: string): void;

  /** Insert an effect; returns the new id, or undefined when (sourceSeq, taskId, kind) already exists. */
  insertOutbox(e: NewOutboxEffect): number | undefined;
  listOutbox(filter?: { status?: EffectStatus; afterId?: number; limit?: number }): OutboxEffect[];
  getOutbox(id: number): OutboxEffect | undefined;
  /** Mark applied with the drainer's result; an applied effect is returned unchanged. */
  ackOutbox(id: number, result: unknown, now: number): OutboxEffect | undefined;
  /** Record a rejection: attempts + 1, pending below maxAttempts, failed at it. */
  nackOutbox(id: number, error: string, maxAttempts: number): OutboxEffect | undefined;
  countOutbox(status: EffectStatus): number;
  /** State of the latest setState effect recorded for an issue, whatever its status. */
  lastSetState(taskId: Id): string | undefined;

  close(): void;
}

/** Typed kv helpers shared by the daemon and its routes. */
export function trackerOf(store: Store): TrackerRecord | undefined {
  const raw = store.getKv('tracker');
  return raw ? (JSON.parse(raw) as TrackerRecord) : undefined;
}

export function setTracker(store: Store, rec: TrackerRecord): void {
  store.setKv('tracker', JSON.stringify(rec));
}

export function runIdOf(store: Store): string | undefined {
  return store.getKv('runId');
}

export function setRunId(store: Store, id: string): void {
  store.setKv('runId', id);
}
