/**
 * Verifier backend contract. The real backend (verifier.ts) rebases, checks,
 * squashes, and publishes with compare-and-swap. The fake scripts outcomes.
 */
import type { Id } from '../graph/model.js';
import type { FailedReason } from '../state/status.js';
import type { VerifierJob } from '../state/store.js';

export type VerifierOutcome =
  | { kind: 'published'; publishedSha: string; verifiedSha: string; changedFiles?: string[] }
  | { kind: 'failed'; reason: FailedReason }
  | { kind: 'conflict'; files: string[]; since: Id[] }
  /**
   * Compare-and-swap or lease lost: the integration head moved. The job goes back to queued. With `retry`, origin
   * refused the push or could not be reached: the job waits a backoff first, and refusals are counted against
   * `git.pushRefusalLimit`. See specs/integration-pipeline "Push failures are classified".
   */
  | { kind: 'requeue'; reason?: string; retry?: { kind: 'refused' | 'unreachable'; message: string } };

export interface VerifierProgress {
  /** Persist intermediate job state (checking, verified, publishing) durably. */
  (patch: Partial<VerifierJob>): void;
}

export interface VerifierContext {
  progress: VerifierProgress;
  /** Report summary for the squash commit message. */
  summary: string;
  /** Tasks published since the job's base, for conflict context. */
  publishedSince: (baseSha: string) => Promise<Id[]>;
  /** Submit report declared no changes. */
  noChanges: boolean;
  /**
   * Resolves when every progress record made so far is durable. Awaited once, between the `publishing` record and
   * the compare-and-swap, so publication never runs ahead of its record. Rejects (and the run stops with no effect)
   * when the store went fatal or the job was dropped while waiting. See specs/integration-pipeline "Durable publishing record".
   */
  durable?: () => Promise<void>;
  /**
   * Under `verifier.mode: remote`: resolves with the result a verifier stored for this job, reading the row after each
   * change. Rejects with `JobDroppedError` when the row is gone or dropped and with `VerifierStoppedError` when the
   * daemon stops. Optional, as `durable` is: the in-process backend never calls it. See specs/verifier-pool
   * "Remote verification run: the wait".
   */
  awaitResult?: () => Promise<NonNullable<VerifierJob['result']>>;
}

/** Thrown by `awaitResult` when the daemon stops while a remote job waits: nothing is recorded and the row stays. */
export class VerifierStoppedError extends Error {
  constructor(public readonly jobId: string) {
    super(`verifier job ${jobId} stopped while it waited for a result`);
    this.name = 'VerifierStoppedError';
  }
}

/**
 * The patch that removes a job's claim fields. Every job write that sets `queued`, `published`, `failed` or
 * `conflict` spreads it; progress records and drops keep the fields. See specs/verifier-pool
 * "Remote verification outcomes: job fields".
 */
export const NO_CLAIM = { offer: undefined, verifier: undefined, token: undefined, result: undefined } as const satisfies Partial<VerifierJob>;

export interface VerifierBackend {
  run(job: VerifierJob, ctx: VerifierContext): Promise<VerifierOutcome>;
  /** Resolve a job found in `publishing` after a restart by inspecting the integration branch. */
  recoverPublishing?(job: VerifierJob, opts?: { originUnreachable?: boolean }): Promise<'published' | 'requeue'>;
  /** Commits on the integration branch without an Orchestrator-Launch trailer. */
  foreignCommits?(): Promise<string[]>;
  /** Remove temporary verification worktrees left by a crash. Called at recovery. */
  sweepTemp?(): Promise<void>;
}
