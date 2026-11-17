/**
 * The environment the daemon hands to the processes it spawns: agents and
 * check commands, and (through src/workspace/git.ts) its own git commands and
 * the hooks they run. They inherit the daemon's environment, but `ORCH_HOME`
 * points inside the run's data directory and the client-side daemon variables
 * (`CLIENT_VARS`) are gone, so a client they run finds no daemon of the
 * user's. The daemon's own API stays reachable through `ORCH_API`.
 * `ORCH_RUN_ID` is always removed, on every store kind.
 *
 * The store's connection (`DATABASE_URL`, `DATABASE_URL_FILE`, every libpq
 * connection variable in `LIBPQ_VARS`, and any variable whose value is a
 * withheld store URL) is removed only while the daemon withholds. Withholding
 * is a process-wide switch, on when this module loads, so a process that
 * opened no store (the operator CLI, the operator MCP server, a library caller,
 * the in-process test harness) withholds. The daemon (src/main.ts) sets it
 * once, right after its store opens, from `storeWithholdingFor`: on for a
 * Postgres store; off for a SQLite store, unless the config file leaves
 * `store.kind` unwritten while a Postgres input is set
 * (`postgresInputsWithoutKind`). What a child running as the daemon's user can
 * still reach (a mounted secret file, the daemon's memory) is stated in
 * deploy/README.md "Store credentials". See specs/agent-protocol "Agent
 * environment", specs/integration-pipeline "Check environment" and
 * specs/state-backend "No store URL in child environments" and "Withholding
 * follows the store".
 */
import path from 'node:path';

export const CHILD_HOME = 'child-home';

/** Variables a child must not inherit: a client it runs would otherwise reach the user's runs. Empty means delete. */
export const CLIENT_VARS = ['ORCH_URL', 'ORCH_REPO', 'ORCH_DATA_DIR'] as const;

/**
 * The store's inputs: a child that read them would reach the orchestrator's state database. Removed while the daemon
 * withholds; `ORCH_RUN_ID` always. Empty means delete.
 */
export const STORE_VARS = ['DATABASE_URL', 'DATABASE_URL_FILE', 'ORCH_RUN_ID'] as const;

/**
 * The libpq environment variables that choose a server, a database, a user, a password, a service or password
 * file, or a TLS/GSS identity (the PostgreSQL client documentation's "Environment Variables", plus `PGSYSCONFDIR`,
 * which locates `pg_service.conf`). A store URL built from parts (`postgres://host/db` plus `PGPASSWORD`) is not
 * matched by value, so while the daemon withholds these names are removed whatever their values. The one list of
 * them; a test asserts each name. Empty means delete.
 */
export const LIBPQ_VARS = [
  'PGHOST',
  'PGHOSTADDR',
  'PGPORT',
  'PGDATABASE',
  'PGUSER',
  'PGPASSWORD',
  'PGPASSFILE',
  'PGSERVICE',
  'PGSERVICEFILE',
  'PGSYSCONFDIR',
  'PGOPTIONS',
  'PGAPPNAME',
  'PGSSLMODE',
  'PGREQUIRESSL',
  'PGSSLNEGOTIATION',
  'PGSSLCOMPRESSION',
  'PGSSLCERT',
  'PGSSLKEY',
  'PGSSLPASSWORD',
  'PGSSLCERTMODE',
  'PGSSLROOTCERT',
  'PGSSLCRL',
  'PGSSLCRLDIR',
  'PGSSLSNI',
  'PGSSLKEYLOGFILE',
  'PGREQUIREPEER',
  'PGSSLMINPROTOCOLVERSION',
  'PGSSLMAXPROTOCOLVERSION',
  'PGMINPROTOCOLVERSION',
  'PGMAXPROTOCOLVERSION',
  'PGGSSENCMODE',
  'PGKRBSRVNAME',
  'PGGSSLIB',
  'PGGSSDELEGATION',
  'PGCHANNELBINDING',
  'PGREQUIREAUTH',
  'PGCONNECT_TIMEOUT',
  'PGTARGETSESSIONATTRS',
  'PGLOADBALANCEHOSTS',
] as const;

/**
 * Every name removed from a child environment, whatever its value, while the daemon withholds: the store's own
 * inputs and libpq's. `ORCH_RUN_ID` among them is removed on every store kind (`ALWAYS_REMOVED`).
 */
export const WITHHELD_VARS: readonly string[] = [...STORE_VARS, ...LIBPQ_VARS];
const withheldNames: ReadonlySet<string> = new Set(WITHHELD_VARS);

/** The store variable removed whether or not the daemon withholds: a run id names the user's run, not the project's database. */
const ALWAYS_REMOVED = 'ORCH_RUN_ID';

/** The names that return to children when the daemon does not withhold: every withheld name but `ORCH_RUN_ID`. */
const PASSABLE_VARS: readonly string[] = WITHHELD_VARS.filter((k) => k !== ALWAYS_REMOVED);

/** Store URLs whose holders are removed from every child environment while the daemon withholds, whatever the variable's name. */
const withheld = new Set<string>();

/** Whether the store's variables are withheld from children. On at load; only src/main.ts turns it off. */
let withholding = true;

/** Withhold the resolved store URL from every child environment. Called by the daemon once the store block is resolved. */
export function withholdStoreUrl(url: string | undefined): void {
  const u = url?.trim();
  if (u) withheld.add(u);
}

/** Forget the withheld URLs and turn withholding back on (tests). */
export function clearWithheldStoreUrls(): void {
  withheld.clear();
  withholding = true;
}

/**
 * Turn withholding on or off for this process. Called once, by src/main.ts, after the store opens and before the
 * configuration is resolved, with the result of `storeWithholdingFor`. Not exported from the package.
 */
export function setStoreWithholding(on: boolean): void {
  withholding = on;
}

/** Whether this process withholds the store's variables from its children. */
export function storeWithholding(): boolean {
  return withholding;
}

/**
 * Whether a daemon withholds the store's variables: always for the store it opened being Postgres; for SQLite only
 * when a Postgres input is set while the config file leaves `store.kind` unwritten (`inputs` not empty).
 */
export function storeWithholdingFor(openedKind: 'sqlite' | 'postgres', inputs: readonly string[]): boolean {
  if (openedKind === 'postgres') return true;
  return inputs.length > 0;
}

/**
 * The Postgres inputs set while the config file does not write `store.kind`: each key of the file's `store` block
 * (as `store.<key>`), then `ORCH_RUN_ID` when it is set and not empty after trimming. Empty for no file, a file with
 * no `store` mapping, and a `store` block that writes `kind` (either value). `DATABASE_URL`, `DATABASE_URL_FILE`,
 * the libpq names and `git.originUrl` are not inputs: a SQLite project may use them for its own database.
 */
export function postgresInputsWithoutKind(fileRaw: Record<string, unknown> | undefined, env: NodeJS.ProcessEnv): string[] {
  const store = fileRaw?.['store'];
  const block = store !== null && typeof store === 'object' && !Array.isArray(store) ? (store as Record<string, unknown>) : undefined;
  if (block && 'kind' in block) return [];
  const inputs = block ? Object.keys(block).map((k) => `store.${k}`) : [];
  if (env['ORCH_RUN_ID']?.trim()) inputs.push('ORCH_RUN_ID');
  return inputs;
}

/** The names of `DATABASE_URL`, `DATABASE_URL_FILE` and the `LIBPQ_VARS` that are set and not empty in `env`; never a value. */
export function databaseVariablesIn(env: NodeJS.ProcessEnv): string[] {
  return PASSABLE_VARS.filter((k) => Boolean(env[k]?.trim()));
}

/**
 * The isolation keys alone, for callers that merge their own base environment (the runner deletes empty values):
 * `ORCH_HOME`, the client variables and `ORCH_RUN_ID` emptied, and the store's variables emptied while the daemon
 * withholds.
 */
export function isolationEnv(dataDir: string): Record<string, string> {
  const out: Record<string, string> = { ORCH_HOME: path.join(dataDir, CHILD_HOME) };
  for (const k of CLIENT_VARS) out[k] = '';
  out[ALWAYS_REMOVED] = '';
  if (withholding) for (const k of PASSABLE_VARS) out[k] = '';
  return out;
}

/**
 * The environment without `ORCH_RUN_ID` and, while the daemon withholds, without the store's variables, the libpq
 * variables, and any variable holding a withheld store URL.
 */
export function withoutStore<T extends string | undefined>(env: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(env)) {
    if (k === ALWAYS_REMOVED) continue;
    if (withholding) {
      if (withheldNames.has(k)) continue;
      if (typeof v === 'string' && withheld.has(v.trim())) continue;
    }
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
