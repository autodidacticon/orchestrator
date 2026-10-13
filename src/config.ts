/**
 * Orchestrator configuration with defaults. Loaded from a YAML/JSON file by main.ts.
 */
import { z } from 'zod';

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
  checkCommand: z.string().default('npm test'),
  checkTimeoutMs: z.number().int().positive().default(15 * 60_000),
  /** Loopback API port; 0 picks a free port. */
  apiPort: z.number().int().nonnegative().default(0),
  /** Agent retry window before falling back to the report file. */
  retryWindowMs: z.number().int().positive().default(120_000),
  /** Runner command template; {brief}, {worktree}, {launchId}, {mcpConfig} are substituted. */
  runnerCommand: z.string().default(
    'claude -p --output-format json --mcp-config {mcpConfig} --strict-mcp-config --permission-mode acceptEdits --allowedTools "Bash(git:*)" "mcp__orchestrator__heartbeat" "mcp__orchestrator__report" "mcp__orchestrator__block" "mcp__orchestrator__inbox" "mcp__orchestrator__log" --no-session-persistence < {brief}',
  ),
  validateAt: z.enum(['ready', 'ingest']).default('ready'),
  onInsufficient: z.enum(['block', 'remediate']).default('block'),
  remediateMode: z.enum(['review', 'auto']).default('review'),
  cancelReleasesDependentsDefault: z.boolean().default(false),
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

export function defaultConfig(overrides: Partial<Config> = {}): Config {
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
