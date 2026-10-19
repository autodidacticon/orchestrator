/**
 * AgentRunner: spawn a process for a launch, check liveness, reap.
 * Real runners spawn detached with stdio to per-launch log files (see subprocess.ts).
 */
import type { Launch } from '../state/store.js';

export interface SpawnResult {
  pid: number;
}

/** What the runner can say about a launch's process. See specs/health-monitoring "Process liveness". */
export type Liveness = 'alive' | 'dead' | 'unknown';

/** Usage read from a finished launch, when the runner can read it. */
export interface Usage {
  costUsd?: number;
  turns?: number;
  durationMs?: number;
  /** Token counts in one shape for every runner. See specs/health-monitoring "Usage accounting". */
  tokens?: TokenUsage;
  /** Which reader produced the usage. */
  source?: UsageSource;
}

export interface TokenUsage {
  input: number;
  cachedInput?: number;
  cacheWriteInput?: number;
  output: number;
  reasoningOutput?: number;
}

export type UsageSource = 'claude-code' | 'codex' | 'opencode' | 'scripted' | 'worker';

/**
 * Why a launch's process ended without a report, when the runner can tell. Runner-provided detail
 * on `exitedWithoutReport`, not a failure kind. See specs/task-lifecycle "Health failure reasons".
 */
export interface RunnerFailure {
  /** A short name, e.g. the Codex runner's `unknownModel`, `authFailed`, `mcpStartupFailed`. */
  reason: string;
  /** The log line that shows it. */
  detail?: string;
}

export interface AgentRunner {
  spawn(launch: Launch, env: Record<string, string>): Promise<SpawnResult>;
  alive(launch: Launch): Promise<boolean>;
  /** alive or dead from the recorded pid; unknown when the runner cannot observe the process. */
  liveness(launch: Launch): Promise<Liveness>;
  /** SIGTERM, grace, SIGKILL. Idempotent. */
  reap(launch: Launch): Promise<void>;
  /** Kill any process that belongs to this launch id even without a recorded pid. */
  killByLaunchId(launchId: string): Promise<void>;
  /** Usage of a launch that ended, if the runner can read it. */
  readUsage?(launch: Launch): Promise<Usage | undefined>;
  /** Why a launch that ended without a report failed, if the runner can tell from its log. */
  readFailure?(launch: Launch): Promise<RunnerFailure | undefined>;
}
