/**
 * The environment the daemon hands to the processes it spawns: agents and
 * check commands. They inherit the daemon's environment, but `ORCH_HOME` points
 * inside the run's data directory and the client-side daemon variables are
 * gone, so a client they run finds no daemon of the user's. The daemon's own
 * API stays reachable through `ORCH_API`. The store's connection is never
 * passed on: `DATABASE_URL`, `ORCH_RUN_ID` and any variable whose value is the
 * resolved store URL are removed. See specs/agent-protocol "Agent environment",
 * specs/integration-pipeline "Check environment" and specs/state-backend
 * "No store URL in child environments".
 */
import path from 'node:path';

export const CHILD_HOME = 'child-home';

/** Variables a child must not inherit: a client it runs would otherwise reach the user's runs. Empty means delete. */
export const CLIENT_VARS = ['ORCH_URL', 'ORCH_REPO', 'ORCH_DATA_DIR'] as const;

/** The store's inputs: a child that read them would reach the orchestrator's state database. Empty means delete. */
export const STORE_VARS = ['DATABASE_URL', 'ORCH_RUN_ID'] as const;

/** Store URLs whose holders are removed from every child environment, whatever the variable's name. */
const withheld = new Set<string>();

/** Withhold the resolved store URL from every child environment. Called by the daemon once the store block is resolved. */
export function withholdStoreUrl(url: string | undefined): void {
  const u = url?.trim();
  if (u) withheld.add(u);
}

/** Forget the withheld URLs (tests). */
export function clearWithheldStoreUrls(): void {
  withheld.clear();
}

/** The isolation keys alone, for callers that merge their own base environment (the runner deletes empty values). */
export function isolationEnv(dataDir: string): Record<string, string> {
  const out: Record<string, string> = { ORCH_HOME: path.join(dataDir, CHILD_HOME) };
  for (const k of CLIENT_VARS) out[k] = '';
  for (const k of STORE_VARS) out[k] = '';
  return out;
}

/** The environment without the store's variables and without any variable holding a withheld store URL. */
export function withoutStore<T extends string | undefined>(env: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(env)) {
    if ((STORE_VARS as readonly string[]).includes(k)) continue;
    if (typeof v === 'string' && withheld.has(v.trim())) continue;
    out[k] = v;
  }
  return out;
}

/** Delete keys whose value is the empty string. */
export function stripEmpty(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && v !== '') out[k] = v;
  return out;
}

/** The full child environment: the process environment, the isolation keys, then `extra`, with empties and the store removed. */
export function childEnv(dataDir: string, extra: Record<string, string> = {}): Record<string, string> {
  return withoutStore(stripEmpty({ ...process.env, ...isolationEnv(dataDir), ...extra }));
}
