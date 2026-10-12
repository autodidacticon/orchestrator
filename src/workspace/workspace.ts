/**
 * Workspace: the repository side of a launch. Real implementation uses git
 * worktrees (git.ts); FakeWorkspace is for logic tests.
 */
import type { Id } from '../graph/model.js';
import type { Launch, StoredReport } from '../state/store.js';

export type SealResult = { ok: true; sealedSha: string } | { ok: false; dirty: string[] };

export interface FallbackReport {
  launchId: string;
  seq: number;
  kind: 'submit' | 'fail' | 'block';
  body: Record<string, unknown>;
}

export interface BriefInput {
  launch: Launch;
  node: { id: Id; kind: string; payload: Record<string, unknown>; deps: readonly Id[] };
  depReports: Array<{ taskId: Id; report: StoredReport | undefined; cancelled?: { reason: string } }>;
  carry?: Record<string, unknown>;
  apiBaseUrl: string;
  retryWindowMs: number;
  checkCommand: string;
  integrationBranch: string;
}

export interface Workspace {
  integrationHead(): Promise<string>;
  /** Create the worktree for a launch at baseSha and write the brief. */
  prepare(launch: Launch, brief: BriefInput): Promise<void>;
  /** Clean check plus head sha. */
  seal(launch: Launch): Promise<SealResult>;
  /** Read and remove the fallback report file if present. */
  readFallback(launch: Launch): Promise<FallbackReport | undefined>;
  remove(launch: Launch): Promise<void>;
  /** Launch ids that currently have a worktree. */
  listWorktrees(): Promise<string[]>;
  tagMilestone(id: Id, version: number, sha: string): Promise<void>;
}
