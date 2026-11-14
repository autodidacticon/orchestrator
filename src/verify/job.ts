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
}

export interface VerifierBackend {
  run(job: VerifierJob, ctx: VerifierContext): Promise<VerifierOutcome>;
  /** Resolve a job found in `publishing` after a restart by inspecting the integration branch. */
  recoverPublishing?(job: VerifierJob, opts?: { originUnreachable?: boolean }): Promise<'published' | 'requeue'>;
  /** Commits on the integration branch without an Orchestrator-Launch trailer. */
  foreignCommits?(): Promise<string[]>;
  /** Remove temporary verification worktrees left by a crash. Called at recovery. */
  sweepTemp?(): Promise<void>;
}
