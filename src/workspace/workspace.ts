/**
 * Workspace: the repository side of a launch. Real implementation uses git
 * worktrees (git.ts); FakeWorkspace is for logic tests.
 */
import type { Id } from '../graph/model.js';
import type { CodexSandbox, CommitPolicy, OpenCodePermission, RunnerKind } from '../runner/selection.js';
import type { Launch, StoredReport } from '../state/store.js';

/** `committed` when the daemon committed a dirty worktree under the `daemon` commit policy. */
export type SealResult = { ok: true; sealedSha: string; committed?: true } | { ok: false; dirty: string[] };

export interface SealOptions {
  /** Commit a dirty worktree (minus `.orchestrator/`) as the orchestrator instead of refusing it. See specs/agent-protocol "Submission sealing". */
  autoCommit?: { message: string };
}

export interface FallbackReport {
  launchId: string;
  seq: number;
  kind: 'submit' | 'fail' | 'block';
  body: Record<string, unknown>;
}

export interface BriefInput {
  launch: Launch;
  node: { id: Id; kind: string; payload: Record<string, unknown>; deps: readonly Id[] };
  depReports: Array<{ taskId: Id; report: StoredReport | undefined; cancelled?: { reason: string }; external?: { done: boolean; title?: string } }>;
  carry?: Record<string, unknown>;
  apiBaseUrl: string;
  retryWindowMs: number;
  /** Absent while no check command is configured. */
  checkCommand?: string;
  integrationBranch: string;
  /** The Bash rules in force for a launch the daemon spawns; absent when the runner command carries its own list. */
  allowedTools?: string[];
  /** The kind the launch was prepared for; the brief writes kind-specific text from it. Absent: the Claude Code text under the `agent` policy. See specs/worker-runners "Sandbox and commit policy". */
  runner?: BriefRunner;
}

/** The launch's runner kind and commit policy; `sandbox` only for codex, `permission` (with the derived bash patterns) only for opencode. */
export interface BriefRunner {
  kind: RunnerKind;
  commitPolicy: CommitPolicy;
  sandbox?: CodexSandbox;
  permission?: { mode: OpenCodePermission; bashPatterns?: string[] };
}

export interface Workspace {
  integrationHead(): Promise<string>;
  /** Create the worktree for a launch at baseSha and write the brief. */
  prepare(launch: Launch, brief: BriefInput): Promise<void>;
  /** Clean check plus head sha; with `autoCommit`, a dirty worktree is committed first. */
  seal(launch: Launch, opts?: SealOptions): Promise<SealResult>;
  /** Read and remove the fallback report file if present. */
  readFallback(launch: Launch): Promise<FallbackReport | undefined>;
  remove(launch: Launch): Promise<void>;
  /** Launch ids that currently have a worktree. */
  listWorktrees(): Promise<string[]>;
  tagMilestone(id: Id, version: number, sha: string): Promise<void>;
  /** `git diff --stat from..to`, or an empty string when unavailable. */
  diffStat(from: string, to: string): Promise<string>;
  /** Progress fingerprint: the worktree head sha, a colon, and a hash of its status and diff. */
  fingerprint(launch: Launch): Promise<string>;
  /** Whether the launch's worktree and brief are present. */
  exists(launch: Launch): Promise<boolean>;
  /** Commit uncommitted changes as a work-in-progress commit on the launch branch; the head afterwards. See specs/pull-runner "Release". */
  preserve(launch: Launch): Promise<{ headSha: string; wipCommit?: string }>;
}
