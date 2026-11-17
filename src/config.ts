/**
 * Orchestrator configuration with defaults. Loaded from a YAML/JSON file by main.ts.
 */
import { z } from 'zod';
import { renewEveryMsOf } from './brief/compose.js';
import { DEFAULT_CLAUDE_COMMAND } from './runner/command.js';
import { anyModelSchema, CODEX_SANDBOXES, COMMIT_POLICIES, DEFAULT_EFFORT, DEFAULT_MODEL_BY_KIND, effortSchemaFor, modelSchemaFor, OPENCODE_DATA_DIRS, OPENCODE_PERMISSIONS, RUNNER_KINDS } from './runner/selection.js';
import { isSafeRule } from './toolchain/tools.js';

/** Admission ordering stages. See specs/scheduling-policy "Ordering chain". */
export const stageNames = ['criticalPath', 'priority', 'fifo'] as const;
export type StageName = (typeof stageNames)[number];

/** `health.contendedRetries` when unset. */
export const DEFAULT_CONTENDED_RETRIES = 3;

/** `health.gapAfterMs` when unset: two notes of the clock further apart than this are a gap. See specs/health-monitoring "Gap in the daemon's clock". */
export const DEFAULT_GAP_AFTER_MS = 60_000;

/** `health.gapHoldMs` when unset: how long nothing starts after a gap. See specs/health-monitoring "Hold after a gap". */
export const DEFAULT_GAP_HOLD_MS = 60_000;

/** One model's token rates in USD per million tokens; the optional rates fall back as `priceUsage` states. */
const rate = z.number().nonnegative();
export const priceSchema = z
  .object({
    inputPerMTok: rate,
    cachedInputPerMTok: rate.optional(),
    cacheWriteInputPerMTok: rate.optional(),
    outputPerMTok: rate,
    reasoningOutputPerMTok: rate.optional(),
  })
  .strict();
export type Price = z.infer<typeof priceSchema>;

export const configSchema = z.object({
  /** Repository the orchestrator integrates into (the primary clone). */
  repoPath: z.string().default('.'),
  integrationBranch: z.string().default('main'),
  /** Graph file (JSON or YAML). */
  graphPath: z.string().default('graph.yaml'),
  /** Directory for the SQLite store, worktrees, logs. */
  dataDir: z.string().default('.orchestrator-run'),
  /** The per-user run directory when started by repository; reported in status. */
  runDir: z.string().optional(),
  capacity: z.number().int().positive().default(2),
  maxWaiting: z.number().int().nonnegative().default(4),
  leaseTtlMs: z.number().int().positive().default(10 * 60_000),
  maxWaitMs: z.number().int().positive().default(60 * 60_000),
  maxAttempts: z.number().int().positive().default(2),
  integrationRetries: z.number().int().nonnegative().default(3),
  tickIntervalMs: z.number().int().positive().default(5_000),
  /** Run on every rebased submission. Detected from the repository when the file does not set it; unresolved holds verification. See specs/toolchain-discovery. */
  checkCommand: z.string().min(1).optional(),
  checkTimeoutMs: z.number().int().positive().default(15 * 60_000),
  /**
   * Run by the daemon in each worktree it prepares, off the tick, before the launch is parked or spawned. Read at start;
   * not an override, never detected. Unset: nothing runs. See specs/pull-runner "Prepare command".
   */
  prepareCommand: z.string().min(1).optional(),
  prepareTimeoutMs: z.number().int().positive().default(10 * 60_000),
  /** Loopback API port; 0 picks a free port. */
  apiPort: z.number().int().nonnegative().default(0),
  /** Address the API binds to; `0.0.0.0` in a cluster. See specs/cluster-runtime. */
  apiBind: z.string().min(1).default('127.0.0.1'),
  /** The URL the daemon advertises (kv, daemon.json, briefs, claims) instead of `http://<apiBind>:<port>`. */
  apiBaseUrl: z.string().url().optional(),
  /** Agent retry window before falling back to the report file. */
  retryWindowMs: z.number().int().positive().default(120_000),
  /** The Claude Code runner's command template; {brief}, {worktree}, {launchId}, {mcpConfig}, and {allowedTools} are substituted at every spawn. */
  runnerCommand: z.string().default(DEFAULT_CLAUDE_COMMAND),
  validateAt: z.enum(['ready', 'ingest']).default('ready'),
  onInsufficient: z.enum(['block', 'remediate']).default('block'),
  remediateMode: z.enum(['review', 'auto']).default('review'),
  cancelReleasesDependentsDefault: z.boolean().default(false),
  /** Who executes launches. See specs/pull-runner "Runner modes". */
  runner: z
    .object({
      /** spawn: the daemon spawns a process; pull: launches wait for a worker; mixed: parked for claimWindowMs, then spawned. */
      mode: z.enum(['spawn', 'pull', 'mixed']).default('spawn'),
      claimWindowMs: z.number().int().nonnegative().default(60_000),
      /** The agent CLI launches run under. See specs/worker-runners "Runner kinds and defaults". */
      kind: z.enum(RUNNER_KINDS).default('claude-code'),
      /** The allow list of spawned Claude Code agents. See specs/toolchain-discovery "Derived allowed tools". */
      claude: z
        .object({
          /** Rules appended to the derived list, in the documented prefix form such as `Bash(docker:*)`. */
          allowedTools: z.array(z.string().refine(isSafeRule, { message: 'a rule must not contain a double quote, backslash, dollar sign, or backtick' })).default([]),
          /** Derive rules from the toolchains found in the repository root. */
          deriveTools: z.boolean().default(true),
          /** The worker model and effort for launches prepared under this run. See specs/model-selection. */
          model: modelSchemaFor('claude-code').default(DEFAULT_MODEL_BY_KIND['claude-code']),
          effort: effortSchemaFor('claude-code').default(DEFAULT_EFFORT),
          /** Who commits the work: the agent, or the daemon when the agent submits. See specs/worker-runners "Sandbox and commit policy". */
          commit: z.enum(COMMIT_POLICIES).default('agent'),
        })
        .default({}),
      /** The Codex runner: model, effort, command template, and policies. The policies' semantics belong to the Codex runner and the sandbox and commit policy. */
      codex: z
        .object({
          /** Command template; unset uses the runner's built-in one, which carries the model and effort slots. */
          command: z.string().min(1).optional(),
          model: modelSchemaFor('codex').default(DEFAULT_MODEL_BY_KIND.codex),
          effort: effortSchemaFor('codex').default(DEFAULT_EFFORT),
          /** The Codex sandbox; workspace-write cannot write a linked worktree's gitdir. See specs/worker-runners "Sandbox and commit policy". */
          sandbox: z.enum(CODEX_SANDBOXES).default('workspace-write'),
          /** Who commits the work; unset derives `daemon`, or `agent` under danger-full-access (see `defaultCodexCommit`). */
          commit: z.enum(COMMIT_POLICIES).optional(),
          networkAccess: z.boolean().optional(),
          ignoreUserConfig: z.boolean().default(true),
          ephemeral: z.boolean().default(true),
          mcpApproval: z.string().optional(),
          toolTimeoutSec: z.number().int().positive().optional(),
          startupTimeoutSec: z.number().int().positive().optional(),
        })
        .default({}),
      /** The OpenCode runner: a `provider/model` model, effort as `--variant`, command template, and policies. The policies' semantics belong to the OpenCode runner. */
      opencode: z
        .object({
          /** Command template; unset uses the runner's built-in one. */
          command: z.string().min(1).optional(),
          model: modelSchemaFor('opencode').default(DEFAULT_MODEL_BY_KIND.opencode),
          effort: effortSchemaFor('opencode').default(DEFAULT_EFFORT),
          /** Who commits the work; `agent` by default, since no sandbox stands between the agent and git. */
          commit: z.enum(COMMIT_POLICIES).default('agent'),
          /** The tool permission rules: derived from the launch, or allow every tool. */
          permission: z.enum(OPENCODE_PERMISSIONS).default('derived'),
          /** The user's shared data directory, or one per launch. */
          dataDir: z.enum(OPENCODE_DATA_DIRS).default('shared'),
          ignoreUserConfig: z.boolean().default(false),
          pure: z.boolean().default(true),
          snapshots: z.boolean().default(false),
        })
        .default({}),
    })
    .default({}),
  /** The integration branch's remote. See specs/integration-pipeline "Origin as source of truth". */
  git: z
    .object({
      /** The URL of the clone's `origin` remote; set, the remote is added or re-pointed to it. Unset, the clone's existing `origin` is used. Read only while pushIntegration is on. */
      originUrl: z.string().min(1).optional(),
      /** Origin is the source of truth: the verifier fetches before each job and pushes each publication with a lease, base selection reads origin's head, and milestone tags are pushed. Off, no git command contacts a remote. */
      pushIntegration: z.boolean().default(false),
      /** How often base selection and milestone pinning may fetch origin; 0 fetches on every read. The verifier fetches at every job. */
      fetchIntervalMs: z.number().int().nonnegative().default(30_000),
      /** Every git command that talks to origin (fetch, push, ls-remote) is killed after this long; 0 never kills. See specs/integration-pipeline "Remote commands are bounded". */
      remoteTimeoutMs: z.number().int().nonnegative().default(120_000),
      /** A publication push origin refuses (not a lost lease) this many times blocks its task with origin's message. See specs/integration-pipeline "Push refusal limit". */
      pushRefusalLimit: z.number().int().positive().default(5),
      /** The first wait before a refused or unreachable push is tried again; it doubles per retry, up to 32 times this. */
      pushRetryBackoffMs: z.number().int().nonnegative().default(30_000),
    })
    .default({}),
  /**
   * Where the run's state lives. Read from the file and the environment only, never from the stored override
   * document, which lives in the store being selected. See specs/state-backend "Store selection".
   */
  store: z
    .object({
      /** sqlite: `<dataDir>/store.sqlite`; postgres: a journaled memory image flushed to the database at `url`. */
      kind: z.enum(['sqlite', 'postgres']).default('sqlite'),
      /** The Postgres connection URL; `DATABASE_URL` when unset. Printed only with its password removed. */
      url: z.string().min(1).optional(),
      /**
       * A file holding the Postgres connection URL (a mounted secret), read once at startup; `DATABASE_URL_FILE`
       * when unset. Used when `url` is unset; then the URL is never in the daemon's environment. A relative path
       * resolves against the daemon's working directory. See specs/state-backend "Store URL from a file".
       */
      urlFile: z.string().min(1).optional(),
      /**
       * postgres only: the run id, which keys the rows and the run lock. Unset: `ORCH_RUN_ID`, else a hash of
       * git.originUrl (or of the clone's origin while git.pushIntegration is on), else the repository path hash.
       * Checked at startup against 1 to 64 characters of [A-Za-z0-9_-]. See specs/state-backend "Run id per deployment".
       */
      runId: z.string().optional(),
      /** The oldest unflushed batch may be this old before the daemon exits. A worker lease must be at least as long. */
      flushDeadlineMs: z.number().int().positive().default(120_000),
    })
    .default({}),
  /** Graph reload behaviour. See specs/agent-protocol "Payload change notice". */
  graph: z
    .object({
      /** Notify a live launch when a compatible reload changed its task's payload. */
      payloadChangedNotice: z.boolean().default(true),
    })
    .default({}),
  /** Agent proposals. See specs/operator-control "Proposals". */
  proposals: z
    .object({
      /** An accepted proposal joins every gated milestone whose closure contains the proposer. */
      joinMilestone: z.boolean().default(true),
    })
    .default({}),
  /** Stuck detection and the base-moved notice. See specs/health-monitoring. */
  health: z
    .object({
      /** Idle time before a launch is flagged stuck and nudged; 0 disables. */
      stuckAfterMs: z.number().int().nonnegative().default(15 * 60_000),
      /** Idle time before a stuck launch is failed; 0 disables. */
      stuckFailAfterMs: z.number().int().nonnegative().default(45 * 60_000),
      /** How long a submitted task's process may keep running so the runner can write its usage; 0 reaps at once. See specs/health-monitoring "Usage accounting". */
      reportGraceMs: z.number().int().nonnegative().default(30_000),
      baseMovedNotice: z.boolean().default(true),
      /** Launches per task that died of `startupContended` and are relaunched without charging a retry; later ones count. Unset is DEFAULT_CONTENDED_RETRIES. See specs/task-lifecycle "Retry and exhaustion". */
      contendedRetries: z.number().int().nonnegative().optional(),
      /** Two notes of the daemon's clock further apart than this are a gap, left out of the stuck limits, the launch time budget and leases; 0 turns the rule off. Read at start. Unset is DEFAULT_GAP_AFTER_MS. See specs/health-monitoring "Gap in the daemon's clock". */
      gapAfterMs: z.number().int().nonnegative().optional(),
      /** How long after a gap nothing is admitted, resumed, spawned or verified; 0 turns the hold off. Read at start. Unset is DEFAULT_GAP_HOLD_MS. See specs/health-monitoring "Hold after a gap". */
      gapHoldMs: z.number().int().nonnegative().optional(),
    })
    .default({}),
  /** Wall time per launch and cost per run. */
  budgets: z
    .object({
      /** 0 disables. */
      maxLaunchMs: z.number().int().nonnegative().default(2 * 3600_000),
      /** 0 means unlimited. */
      maxRunCostUsd: z.number().nonnegative().default(0),
      /** USD per million tokens by model, for launches whose runner reports tokens but no cost. See specs/health-monitoring "Run cost budget". */
      prices: z.record(anyModelSchema, priceSchema).default({}),
    })
    .default({}),
  /** Cuts of the review index, read at daemon start; a request parameter overrides each for one call. See specs/operator-control "Review bundle". */
  review: z
    .object({
      /** File lines of the diff stat the index keeps; the totals line is always kept. */
      statLines: z.number().int().nonnegative().default(40),
      /** UTF-16 units of each task summary the index keeps. */
      summaryChars: z.number().int().nonnegative().default(400),
    })
    .default({}),
  /** Tracker mirroring policy. See specs/tracker-sync. */
  tracker: z
    .object({
      /** auto: only when a tracker was recorded at import; always; never. */
      enabled: z.enum(['auto', 'always', 'never']).default('auto'),
      /** Drainer rejections before an effect is marked failed. */
      maxAttempts: z.number().int().positive().default(3),
      /** The parent issue goes in progress when its first child task starts. */
      parentInProgress: z.boolean().default(true),
      commentOnDone: z.boolean().default(false),
      commentOnFail: z.boolean().default(false),
      /** When a task's issue becomes done: at publication, or when its gated milestone is accepted. */
      doneAt: z.enum(['integration', 'milestoneAccepted']).default('integration'),
      /** The run skill relays human comments under a question as the answer. */
      answersFromComments: z.boolean().default(true),
    })
    .default({}),
  /** Admission order and the scope filter. See specs/scheduling-policy. */
  scheduling: z
    .object({
      /** Stages applied as one stable lexicographic sort over ready candidates; ties keep graph file order. */
      order: z.array(z.enum(stageNames)).default(['criticalPath', 'priority', 'fifo']),
      /** Defer a candidate whose declared scope overlaps the scope of a task holding a slot. */
      scopes: z.boolean().default(true),
    })
    .default({}),
  /** The daemon's own life. See specs/operator-control "Idle exit" and specs/pull-runner "Release". */
  daemon: z
    .object({
      /** Quiet time, with no session attached unless exitWhileAttached, before the daemon exits on its own; 0 disables. */
      idleExitMs: z.number().int().nonnegative().default(600_000),
      /** Count an attached session as activity (false) or let the daemon exit while one is attached (true). */
      exitWhileAttached: z.boolean().default(false),
      /** Kept releases a task may absorb before a release with keep spends an attempt; 0 means unlimited. */
      maxKeptReleases: z.number().int().nonnegative().default(3),
    })
    .default({}),
  /** Brief template slots: name -> { source, required, minLength }. */
  briefSlots: z
    .record(
      z.object({
        source: z.string(),
        required: z.boolean().default(true),
        minLength: z.number().int().nonnegative().default(1),
      }),
    )
    .default({
      description: { source: 'description', required: true, minLength: 1 },
      acceptanceCriteria: { source: 'acceptanceCriteria', required: true, minLength: 1 },
    }),
});

export type Config = z.infer<typeof configSchema>;

/** What a caller may pass before defaults apply: every defaulted key optional, nested blocks partial. */
export type ConfigInput = z.input<typeof configSchema>;

export function defaultConfig(overrides: ConfigInput = {}): Config {
  return configSchema.parse(overrides);
}

import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

/** Load a YAML/JSON config file; relative paths resolve against the file's directory. `DATABASE_URL` fills `store.url`. */
export async function loadConfig(file: string, env: NodeJS.ProcessEnv = process.env): Promise<Config> {
  const text = await readFile(file, 'utf8');
  const raw = (parseYaml(text) ?? {}) as Record<string, unknown>;
  const cfg = withStoreEnv(configSchema.parse(raw), env);
  const base = path.dirname(path.resolve(file));
  const abs = (p: string) => (path.isAbsolute(p) ? p : path.resolve(base, p));
  return { ...cfg, repoPath: abs(cfg.repoPath), graphPath: abs(cfg.graphPath), dataDir: abs(cfg.dataDir) };
}

/** A store URL source that cannot be used: two sources at once, or a URL file that cannot be read or is empty. Never carries the URL. */
export class StoreUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreUrlError';
  }
}

/** URL files already read by this process, by path: the daemon resolves its configuration more than once at startup, and every resolution sees the same URL. */
const urlFileCache = new Map<string, string>();

/** Forget the URL files read so far (tests). */
export function clearStoreUrlFileCache(): void {
  urlFileCache.clear();
}

/** The URL held by a store URL file: its content, trimmed. Read once per process and path; a failed read is not kept. */
export function readStoreUrlFile(file: string, origin: string): string {
  const cached = urlFileCache.get(path.resolve(file));
  if (cached !== undefined) return cached;
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    throw new StoreUrlError(`cannot read the database URL file ${file} (${origin}): ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
  }
  const url = text.trim();
  if (!url) throw new StoreUrlError(`the database URL file ${file} (${origin}) is empty`);
  urlFileCache.set(path.resolve(file), url);
  return url;
}

/**
 * `store.url` when the file leaves it unset. Under `store.kind: postgres`, in this order: the file named by
 * `store.urlFile`, else the file named by `DATABASE_URL_FILE`, else `DATABASE_URL`; `store.url` with
 * `store.urlFile`, or `DATABASE_URL` with `DATABASE_URL_FILE`, is refused. Under `sqlite` no file is read and
 * `DATABASE_URL` fills the unused url, as before. The only environment inputs of the store block besides
 * `ORCH_RUN_ID`. See specs/state-backend "Store URL from a file".
 */
export function withStoreEnv(cfg: Config, env: NodeJS.ProcessEnv = process.env): Config {
  const fromEnv = env['DATABASE_URL']?.trim();
  const fileFromEnv = env['DATABASE_URL_FILE']?.trim();
  if (cfg.store.url && cfg.store.urlFile) throw new StoreUrlError('store.url and store.urlFile are both set: set one');
  if (cfg.store.url) return cfg;
  if (cfg.store.kind !== 'postgres') return fromEnv ? { ...cfg, store: { ...cfg.store, url: fromEnv } } : cfg;
  if (fromEnv && fileFromEnv && !cfg.store.urlFile) throw new StoreUrlError('DATABASE_URL and DATABASE_URL_FILE are both set: set one');
  let url: string | undefined;
  if (cfg.store.urlFile) url = readStoreUrlFile(cfg.store.urlFile, 'store.urlFile');
  else if (fileFromEnv) url = readStoreUrlFile(fileFromEnv, 'DATABASE_URL_FILE');
  else url = fromEnv || undefined;
  if (!url) return cfg;
  return { ...cfg, store: { ...cfg.store, url } };
}

/** Where `store.url` came from: the config file, a URL file (`store.urlFile` or `DATABASE_URL_FILE`), `DATABASE_URL`, or nowhere. */
export function storeUrlSource(cfg: Config, fileRaw: Record<string, unknown> | undefined, env: NodeJS.ProcessEnv = process.env): StoreUrlSource | undefined {
  if (!cfg.store.url) return undefined;
  const fileStore = fileRaw?.['store'] as { url?: unknown } | undefined;
  if (typeof fileStore?.url === 'string' && fileStore.url) return 'file';
  return cfg.store.kind === 'postgres' && (cfg.store.urlFile || env['DATABASE_URL_FILE']?.trim()) ? 'urlFile' : 'environment';
}

export type StoreUrlSource = 'file' | 'urlFile' | 'environment';

/**
 * A connection URL with its password removed: from the userinfo, from a `password` query parameter, and from a
 * libpq `password=` keyword. Anything that does not parse is cut to its scheme. See specs/state-backend "Database URL redaction".
 */
export function redactUrl(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  const trimmed = url.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    // libpq keyword/value form: host=... password=...
    return trimmed.replace(/(^|\s)password\s*=\s*('(?:[^'\\]|\\.)*'|\S*)/gi, '$1password=');
  }
  try {
    const u = new URL(trimmed);
    if (u.password) u.password = '';
    for (const k of [...u.searchParams.keys()]) if (k.toLowerCase() === 'password') u.searchParams.delete(k);
    return u.toString();
  } catch {
    return `${trimmed.slice(0, trimmed.indexOf('://') + 3)}<unparseable>`;
  }
}

/** Every form the URL's password may be printed in (raw and percent-decoded), for scrubbing log text. */
export function urlSecrets(url: string | undefined): string[] {
  if (!url) return [];
  const out = new Set<string>();
  try {
    const u = new URL(url.trim());
    if (u.password) {
      out.add(u.password);
      try {
        out.add(decodeURIComponent(u.password));
      } catch {
        /* keep the raw form */
      }
    }
    for (const [k, v] of u.searchParams) if (k.toLowerCase() === 'password' && v) out.add(v);
  } catch {
    const m = /(?:^|\s)password\s*=\s*('(?:[^'\\]|\\.)*'|\S+)/i.exec(url);
    if (m?.[1]) out.add(m[1].replace(/^'|'$/g, ''));
  }
  return [...out].filter((s) => s.length > 0);
}

/**
 * Whether a lease leaves the stated margin above the flush deadline. A worker renews every third of the lease
 * (`renewEveryMsOf`), so when a stall begins its lease may have only `leaseTtlMs - renewEveryMs` left. The stall lasts
 * at most `flushDeadlineMs` (then the daemon exits and restarts), and while it lasts the daemon is not ready and workers
 * cannot renew. The margin left above the deadline is one more renewal interval, for the worker's first renewal to
 * reach the daemon once it is ready again: `leaseTtlMs - 2 * renewEveryMs >= flushDeadlineMs`.
 * See specs/state-backend "Lease margin above the flush deadline".
 */
export function leaseCoversFlushDeadline(leaseTtlMs: number, flushDeadlineMs: number): boolean {
  return leaseTtlMs - 2 * renewEveryMsOf(leaseTtlMs) >= flushDeadlineMs;
}

/** A lease that always leaves the margin: three times the deadline (then a renewal interval is the deadline itself). */
export function minLeaseTtlMs(flushDeadlineMs: number): number {
  return 3 * flushDeadlineMs;
}

/**
 * Why the store block cannot start, or undefined. Under `postgres` a URL is required, and the worker lease must
 * outlast the flush deadline by a stated margin (`minLeaseTtlMs`): a lease may not run out while the records that
 * granted or renewed it are still unflushed. See specs/state-backend "Lease margin above the flush deadline".
 */
export function storeConfigError(cfg: Pick<Config, 'store' | 'leaseTtlMs'>): string | undefined {
  if (cfg.store.kind !== 'postgres') return undefined;
  if (!cfg.store.url) return 'store.kind is postgres but no database URL is set: set store.url, store.urlFile, DATABASE_URL_FILE or DATABASE_URL';
  if (!leaseCoversFlushDeadline(cfg.leaseTtlMs, cfg.store.flushDeadlineMs)) {
    const min = minLeaseTtlMs(cfg.store.flushDeadlineMs);
    const every = renewEveryMsOf(cfg.leaseTtlMs);
    return (
      `leaseTtlMs (${cfg.leaseTtlMs}) is too short for store.flushDeadlineMs (${cfg.store.flushDeadlineMs}): ` +
      `a worker renews every ${every}ms, so a stall may begin with ${cfg.leaseTtlMs - every}ms of lease left, and the lease must outlast the deadline by one more renewal interval; ` +
      `raise leaseTtlMs to at least ${min} (three times the deadline) or lower store.flushDeadlineMs`
    );
  }
  return undefined;
}

/**
 * The startup warning for a Postgres store with `git.pushIntegration` off, or undefined. The state then outlives the
 * clone, but the integration branch lives only in the clone: on a clone without a volume a restart loses every
 * publication while the store still records the tasks done. The daemon cannot tell a volume from an emptyDir, and a
 * locally started Postgres run keeps its clone on disk, so this warns rather than refuses.
 * See specs/state-backend "Postgres store without push integration".
 */
export function storeDurabilityWarning(cfg: Pick<Config, 'store' | 'git'>): string | undefined {
  if (cfg.store.kind !== 'postgres' || cfg.git.pushIntegration) return undefined;
  return 'store.kind is postgres but git.pushIntegration is off: the integration branch and launch branches live only in this clone, so unless the clone is on a persistent volume a restart loses every publication while the store still records those tasks done; set git.pushIntegration: true (and git.originUrl) to make origin the source of truth';
}

/** The store block as printed: the URL without its password. */
export function redactedStore(store: Config['store']): Config['store'] {
  return { ...store, ...(store.url !== undefined ? { url: redactUrl(store.url) } : {}) };
}
