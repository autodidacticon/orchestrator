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

export interface PreserveOptions {
  /** Whether untracked files count as progress and go into the work-in-progress commit. Default true (a release with keep). */
  untracked?: boolean;
}

export interface RemoveOptions {
  /** Removal attempts before giving up (default 3). One for a worktree whose agent may still be in it: the tick retries later. */
  attempts?: number;
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
  /** The lease TTL; the brief names the heartbeat interval from it (a third). Absent: no interval line. See specs/agent-protocol "Heartbeat interval". */
  leaseTtlMs?: number;
  /** The stuck limits and the launch time budget in force when the brief is composed (0 disables each). Absent: no limits line. See specs/agent-protocol "Brief states the limits in force". */
  limits?: BriefLimits;
  /** Absent while no check command is configured. */
  checkCommand?: string;
  integrationBranch: string;
  /** The Bash rules in force for a launch the daemon spawns; absent when the runner command carries its own list. */
  allowedTools?: string[];
  /** The kind the launch was prepared for; the brief writes kind-specific text from it. Absent: the Claude Code text under the `agent` policy. See specs/worker-runners "Sandbox and commit policy". */
  runner?: BriefRunner;
}

/** `health.stuckAfterMs`, `health.stuckFailAfterMs` and `budgets.maxLaunchMs` as the brief states them. */
export interface BriefLimits {
  stuckAfterMs: number;
  stuckFailAfterMs: number;
  maxLaunchMs: number;
}

/** The launch's runner kind and commit policy; `sandbox` only for codex, `permission` (with the derived bash patterns) only for opencode. */
export interface BriefRunner {
  kind: RunnerKind;
  commitPolicy: CommitPolicy;
  sandbox?: CodexSandbox;
  /** Set for codex only (codexNetworkAccess); false means the worker's commands cannot reach the network. */
  networkAccess?: boolean;
  permission?: { mode: OpenCodePermission; bashPatterns?: string[] };
}

/**
 * A milestone tag push to origin: landed, failed (retry later), or a conflict because the clone or origin holds the
 * tag at another sha (`remoteSha` is that sha, wherever it was found).
 */
export type TagPushResult = { pushed: true } | { pushed: false; error: string; conflict?: { remoteSha: string; where?: 'clone' | 'origin' } };

export interface Workspace {
  /** With `awaitFetch` (startup recovery), a fetch it starts is awaited in full, bounded only by git.remoteTimeoutMs; the tick waits at most a short bound. */
  integrationHead(opts?: { awaitFetch?: boolean }): Promise<string>;
  /** Create the worktree for a launch at baseSha and write the brief. */
  prepare(launch: Launch, brief: BriefInput): Promise<void>;
  /** Clean check plus head sha; with `autoCommit`, a dirty worktree is committed first. */
  seal(launch: Launch, opts?: SealOptions): Promise<SealResult>;
  /** Read and remove the fallback report file if present. */
  readFallback(launch: Launch): Promise<FallbackReport | undefined>;
  /**
   * Remove the launch's worktree. Never throws. Resolves to false when it is still on disk or registered with the
   * clone afterwards, so the caller can retry; any other value means it is gone.
   */
  remove(launch: Launch, opts?: RemoveOptions): Promise<boolean | void>;
  /** Launch ids that currently have a worktree. */
  listWorktrees(): Promise<string[]>;
  /** Create the tag locally (idempotent). With an origin, also push it; the outcome (a conflict in the clone included) is returned, never thrown. */
  tagMilestone(id: Id, version: number, sha: string): Promise<TagPushResult | void>;
  /** `git diff --stat from..to`, or an empty string when unavailable. */
  diffStat(from: string, to: string): Promise<string>;
  /** Progress fingerprint: the worktree head sha, a colon, and a hash of its status and diff. */
  fingerprint(launch: Launch): Promise<string>;
  /** Whether the launch's worktree and brief are present. */
  exists(launch: Launch): Promise<boolean>;
  /**
   * Commit uncommitted changes as a work-in-progress commit on the launch branch; the head afterwards. See specs/pull-runner "Release".
   * With `untracked: false` (a lease expiry) untracked files are neither progress nor committed: only changes to tracked files and
   * paths the worker staged are. See specs/pull-runner "Lease expiry".
   */
  preserve(launch: Launch, opts?: PreserveOptions): Promise<{ headSha: string; wipCommit?: string }>;
}
