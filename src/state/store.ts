/**
 * Store interface. Synchronous on purpose: better-sqlite3 is synchronous, which
 * makes a claim, a dedup write, or a transition one transaction.
 */
import type { Id } from '../graph/model.js';
import type { Entry } from './status.js';

export type LaunchStatus = 'preparing' | 'launching' | 'live' | 'ended' | 'revoked';

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
  endedAt?: number;
  endReason?: string;
  createdAt: number;
  /** Last answered block, for replay after disconnect. */
  pendingAnswer?: { seq: number; answer: string };
  /** Notices for the agent's inbox (pull). */
  notices?: Array<{ kind: string; [k: string]: unknown }>;
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
  listEvents(filter?: { kind?: string; taskId?: Id; launchId?: string }): StoredEvent[];

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

  close(): void;
}
