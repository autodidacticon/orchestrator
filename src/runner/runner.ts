/**
 * AgentRunner: spawn a process for a launch, check liveness, reap.
 * Real runners spawn detached with stdio to per-launch log files (see subprocess.ts).
 */
import type { Launch } from '../state/store.js';

export interface SpawnResult {
  pid: number;
}

export interface AgentRunner {
  spawn(launch: Launch, env: Record<string, string>): Promise<SpawnResult>;
  alive(launch: Launch): Promise<boolean>;
  /** SIGTERM, grace, SIGKILL. Idempotent. */
  reap(launch: Launch): Promise<void>;
  /** Kill any process that belongs to this launch id even without a recorded pid. */
  killByLaunchId(launchId: string): Promise<void>;
}
