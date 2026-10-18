/**
 * Orchestrator configuration with defaults. Loaded from a YAML/JSON file by main.ts.
 */
import { z } from 'zod';
import { DEFAULT_CLAUDE_COMMAND } from './runner/command.js';
import { DEFAULT_EFFORT, DEFAULT_MODEL, effortSchema, modelSchema } from './runner/selection.js';
import { isSafeRule } from './toolchain/tools.js';

/** Admission ordering stages. See specs/scheduling-policy "Ordering chain". */
export const stageNames = ['criticalPath', 'priority', 'fifo'] as const;
export type StageName = (typeof stageNames)[number];

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
  /** Loopback API port; 0 picks a free port. */
  apiPort: z.number().int().nonnegative().default(0),
  /** Address the API binds to; `0.0.0.0` in a cluster. See specs/cluster-runtime. */
  apiBind: z.string().min(1).default('127.0.0.1'),
  /** The URL the daemon advertises (kv, daemon.json, briefs, claims) instead of `http://<apiBind>:<port>`. */
  apiBaseUrl: z.string().url().optional(),
  /** Agent retry window before falling back to the report file. */
  retryWindowMs: z.number().int().positive().default(120_000),
  /** Runner command template; {brief}, {worktree}, {launchId}, {mcpConfig}, and {allowedTools} are substituted at every spawn. */
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
      /** The allow list of spawned Claude Code agents. See specs/toolchain-discovery "Derived allowed tools". */
      claude: z
        .object({
          /** Rules appended to the derived list, in the documented prefix form such as `Bash(docker:*)`. */
          allowedTools: z.array(z.string().refine(isSafeRule, { message: 'a rule must not contain a double quote, backslash, dollar sign, or backtick' })).default([]),
          /** Derive rules from the toolchains found in the repository root. */
          deriveTools: z.boolean().default(true),
          /** The worker model and effort for launches prepared under this run. See specs/model-selection. */
          model: modelSchema.default(DEFAULT_MODEL),
          effort: effortSchema.default(DEFAULT_EFFORT),
        })
        .default({}),
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
    })
    .default({}),
  /** Wall time per launch and cost per run. */
  budgets: z
    .object({
      /** 0 disables. */
      maxLaunchMs: z.number().int().nonnegative().default(2 * 3600_000),
      /** 0 means unlimited. */
      maxRunCostUsd: z.number().nonnegative().default(0),
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

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

/** Load a YAML/JSON config file; relative paths resolve against the file's directory. */
export async function loadConfig(file: string): Promise<Config> {
  const text = await readFile(file, 'utf8');
  const raw = (parseYaml(text) ?? {}) as Record<string, unknown>;
  const cfg = configSchema.parse(raw);
  const base = path.dirname(path.resolve(file));
  const abs = (p: string) => (path.isAbsolute(p) ? p : path.resolve(base, p));
  return { ...cfg, repoPath: abs(cfg.repoPath), graphPath: abs(cfg.graphPath), dataDir: abs(cfg.dataDir) };
}
