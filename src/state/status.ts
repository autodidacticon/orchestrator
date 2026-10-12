/**
 * Node status, overlay entries, and leases. See specs/task-lifecycle.
 */
import type { Id } from '../graph/model.js';

export type StatusKind =
  | 'unstarted'
  | 'running'
  | 'waiting'
  | 'submitted'
  | 'done'
  | 'failed'
  | 'blocked'
  | 'cancelled';

export const STATUS_KINDS: readonly StatusKind[] = [
  'unstarted',
  'running',
  'waiting',
  'submitted',
  'done',
  'failed',
  'blocked',
  'cancelled',
];

export type BlockedKind =
  | 'needsDecision'
  | 'needsAccess'
  | 'impossible'
  | 'dependencyCancelled'
  | 'outOfScope'
  | 'insufficientSpec'
  | 'milestoneRejected';

export const BLOCKED_KINDS: readonly BlockedKind[] = [
  'needsDecision',
  'needsAccess',
  'impossible',
  'dependencyCancelled',
  'outOfScope',
  'insufficientSpec',
  'milestoneRejected',
];

/** A question an agent asks while blocking (live or via fallback). */
export interface Question {
  kind: BlockedKind;
  message: string;
  options?: string[];
}

export interface BlockedReason extends Question {
  /** Human answer, present once answered (carried into the next brief). */
  answer?: string;
  /** For insufficientSpec: the missing slots. */
  missing?: string[];
  /** For needsDecision from remediation: the candidate payload overlay. */
  candidate?: Record<string, unknown>;
  /** For milestoneRejected: the reviewer's note. */
  note?: string;
}

export type FailedKind =
  | 'agentFail'
  | 'exitedWithoutReport'
  | 'leaseExpired'
  | 'checkFailed'
  | 'checkTimeout'
  | 'emptySubmission'
  | 'missingAcceptanceEvidence'
  | 'integrationCapExceeded'
  | 'reaped'
  | 'malformedReport';

export interface FailedReason {
  kind: FailedKind;
  message?: string;
  /** Agent fail report body or verifier output. */
  detail?: Record<string, unknown>;
  output?: string;
}

export type Status =
  | { kind: 'unstarted' }
  | { kind: 'running' }
  | { kind: 'waiting'; question: Question; answer?: string; askedAt: number; seq: number }
  | { kind: 'submitted' }
  | { kind: 'done' }
  | { kind: 'failed'; reason: FailedReason }
  | { kind: 'blocked'; reason: BlockedReason }
  | { kind: 'cancelled'; reason: string; releasesDependents: boolean };

export const UNSTARTED: Status = { kind: 'unstarted' };

export interface Lease {
  launchId: string;
  token: string;
  claimedAt: number;
  spawnedAt?: number;
  expiresAt: number;
  baseSha: string;
  graphRev: string;
}

export interface Entry {
  status: Status;
  /** Failure budget. Reset on human unblock/reopen/uncancel. */
  attempts: number;
  /** Rebase conflict counter. Reset with attempts. */
  integrationRetries: number;
  /** Monotone process counter. Never reset. Names branches and worktrees. */
  launches: number;
  lease?: Lease;
  updatedAt: number;
  /** Milestones only. */
  reviewVersion: number;
  integrationSha?: string;
  /** Milestones only: accepted {sha, version}. */
  accepted?: { sha: string; version: number };
  /** Context for the next launch's brief; cleared when the launch goes live. */
  carry?: AttemptContext;
}

export function defaultEntry(now = 0): Entry {
  return {
    status: UNSTARTED,
    attempts: 0,
    integrationRetries: 0,
    launches: 0,
    updatedAt: now,
    reviewVersion: 0,
  };
}

export type Overlay = ReadonlyMap<Id, Entry>;

export function entryOf(overlay: Overlay, id: Id): Entry {
  return overlay.get(id) ?? defaultEntry();
}

export function statusOf(overlay: Overlay, id: Id): Status {
  return entryOf(overlay, id).status;
}

export const TERMINAL_KINDS: readonly StatusKind[] = ['done', 'cancelled'];

export function isTerminal(status: Status): boolean {
  return status.kind === 'done' || status.kind === 'cancelled';
}

/** "Started" for the reopen guard and reload compatibility. */
export function isStarted(status: Status): boolean {
  return (
    status.kind === 'running' ||
    status.kind === 'waiting' ||
    status.kind === 'submitted' ||
    status.kind === 'done'
  );
}

/** A dependency counts as satisfied when done, or cancelled with release. */
export function isSatisfied(status: Status): boolean {
  return status.kind === 'done' || (status.kind === 'cancelled' && status.releasesDependents);
}

/** Conflict details carried into the next launch's brief. */
export interface ConflictContext {
  files: string[];
  /** Tasks published since this task's base. */
  since: Id[];
  previousBranch: string;
}

/** Attempt context composed into the next brief, then cleared at launch. */
export interface AttemptContext {
  priorFailure?: FailedReason;
  verifierOutput?: string;
  conflict?: ConflictContext;
  question?: Question;
  answer?: string;
}
