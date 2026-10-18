/**
 * The environment the daemon hands to the processes it spawns: agents and
 * check commands. They inherit the daemon's environment, but `ORCH_HOME` points
 * inside the run's data directory and the client-side daemon variables are
 * gone, so a client they run finds no daemon of the user's. The daemon's own
 * API stays reachable through `ORCH_API`. See specs/agent-protocol "Agent
 * environment" and specs/integration-pipeline "Check environment".
 */
import path from 'node:path';

export const CHILD_HOME = 'child-home';

/** Variables a child must not inherit: a client it runs would otherwise reach the user's runs. Empty means delete. */
export const CLIENT_VARS = ['ORCH_URL', 'ORCH_REPO', 'ORCH_DATA_DIR'] as const;

/** The isolation keys alone, for callers that merge their own base environment (the runner deletes empty values). */
export function isolationEnv(dataDir: string): Record<string, string> {
  const out: Record<string, string> = { ORCH_HOME: path.join(dataDir, CHILD_HOME) };
  for (const k of CLIENT_VARS) out[k] = '';
  return out;
}

/** Delete keys whose value is the empty string. */
export function stripEmpty(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && v !== '') out[k] = v;
  return out;
}

/** The full child environment: the process environment, the isolation keys, then `extra`, with empties removed. */
export function childEnv(dataDir: string, extra: Record<string, string> = {}): Record<string, string> {
  return stripEmpty({ ...process.env, ...isolationEnv(dataDir), ...extra });
}
