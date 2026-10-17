/**
 * Layered configuration: argument, file, pinned (the integration branch only),
 * detected, default. Scalars take the first layer; the allow list composes.
 * Every value carries its provenance. See specs/toolchain-discovery
 * "Resolution order and provenance".
 */
import { z } from 'zod';
import { type Config, configSchema } from '../config.js';
import { hasAllowedToolsSlot, hasEffortSlot, hasModelSlot } from '../runner/command.js';
import { type Effort, effortSchema, modelSchema } from '../runner/selection.js';
import type { ToolchainRecord } from '../toolchain/detect.js';
import { type AllowedToolsParts, composeAllowedTools, isSafeRule } from '../toolchain/tools.js';

export const OVERRIDABLE_KEYS = ['checkCommand', 'integrationBranch', 'capacity', 'allowedTools', 'runnerCommand', 'model', 'effort'] as const;
export type OverridableKey = (typeof OVERRIDABLE_KEYS)[number];
export const START_ONLY_KEYS: readonly OverridableKey[] = ['integrationBranch'];

const rule = z.string().refine(isSafeRule, (r) => ({ message: `rule ${JSON.stringify(r)} must not be empty or contain a double quote, backslash, dollar sign, or backtick` }));

/** An override document: a value sets the key, null clears it. */
export const overridesSchema = z
  .object({
    checkCommand: z.string().min(1).nullable().optional(),
    integrationBranch: z.string().min(1).nullable().optional(),
    capacity: z.number().int().positive().nullable().optional(),
    allowedTools: z.array(rule).nullable().optional(),
    runnerCommand: z.string().min(1).nullable().optional(),
    model: modelSchema.nullable().optional(),
    effort: effortSchema.nullable().optional(),
  })
  .strict();
export type Overrides = z.infer<typeof overridesSchema>;

export type Source = 'argument' | 'file' | 'pinned' | 'detected' | 'default' | 'unresolved' | 'composed';

export interface Provenance {
  checkCommand: Source;
  integrationBranch: Source;
  capacity: Source;
  runnerCommand: Source;
  allowedTools: Source;
  model: Source;
  effort: Source;
}

export interface ResolveInputs {
  /** The parsed configuration (file plus defaults, paths already absolute). */
  base: Config;
  /** The file as written, without defaults; absent when there is no file. */
  fileRaw?: Record<string, unknown>;
  detected?: { toolchain?: ToolchainRecord; integrationBranch?: string };
  /** The integration branch pinned in the store for the run. */
  pinned?: string;
}

export interface Resolved {
  config: Config;
  provenance: Provenance;
  allowedTools: { value: string[]; parts: AllowedToolsParts; applied: boolean };
  /** The run default model and effort; `applied` is whether the runner command carries the slot. See specs/model-selection. */
  model: { value: string; applied: boolean };
  effort: { value: Effort; applied: boolean };
  toolchain: ToolchainRecord | undefined;
  needsConfig: OverridableKey[];
  overrides: Overrides;
  inputs: ResolveInputs;
}

const DEFAULTS = configSchema.parse({});

function fileHas(raw: Record<string, unknown> | undefined, key: string): boolean {
  return raw !== undefined && raw[key] !== undefined && raw[key] !== null;
}

function fileClaude(raw: Record<string, unknown> | undefined): { allowedTools?: string[]; deriveTools?: boolean; model?: string; effort?: string } {
  const runner = raw?.['runner'];
  const claude = runner && typeof runner === 'object' ? (runner as Record<string, unknown>)['claude'] : undefined;
  if (!claude || typeof claude !== 'object') return {};
  const c = claude as Record<string, unknown>;
  return {
    allowedTools: Array.isArray(c['allowedTools']) ? c['allowedTools'].map(String) : undefined,
    deriveTools: typeof c['deriveTools'] === 'boolean' ? c['deriveTools'] : undefined,
    model: typeof c['model'] === 'string' ? c['model'] : undefined,
    effort: typeof c['effort'] === 'string' ? c['effort'] : undefined,
  };
}

/** Merge a patch into an override document: a null clears the key. */
export function mergeOverrides(current: Overrides, patch: Overrides): Overrides {
  const out: Record<string, unknown> = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else if (v !== undefined) out[k] = v;
  }
  return out as Overrides;
}

export function resolveLayers(inputs: ResolveInputs, overrides: Overrides = {}): Resolved {
  const { base, fileRaw, detected, pinned } = inputs;
  const provenance = {} as Provenance;

  // An in-memory config with no file (the harnesses) stands for the file layer.
  const fileCheck = fileRaw === undefined || fileHas(fileRaw, 'checkCommand') ? base.checkCommand : undefined;
  const checkCommand = overrides.checkCommand ?? fileCheck ?? detected?.toolchain?.checkCommand;
  provenance.checkCommand = overrides.checkCommand ? 'argument' : fileCheck !== undefined ? 'file' : detected?.toolchain?.checkCommand ? 'detected' : 'unresolved';

  let integrationBranch: string;
  if (overrides.integrationBranch) {
    integrationBranch = overrides.integrationBranch;
    provenance.integrationBranch = 'argument';
  } else if (fileHas(fileRaw, 'integrationBranch')) {
    integrationBranch = base.integrationBranch;
    provenance.integrationBranch = 'file';
  } else if (pinned) {
    integrationBranch = pinned;
    provenance.integrationBranch = 'pinned';
  } else if (detected?.integrationBranch) {
    integrationBranch = detected.integrationBranch;
    provenance.integrationBranch = 'detected';
  } else if (fileRaw === undefined && base.integrationBranch !== DEFAULTS.integrationBranch) {
    integrationBranch = base.integrationBranch;
    provenance.integrationBranch = 'file';
  } else {
    integrationBranch = base.integrationBranch;
    provenance.integrationBranch = 'default';
  }

  const capacity = overrides.capacity ?? base.capacity;
  provenance.capacity = overrides.capacity ? 'argument' : fileHas(fileRaw, 'capacity') || (fileRaw === undefined && base.capacity !== DEFAULTS.capacity) ? 'file' : 'default';

  const runnerCommand = overrides.runnerCommand ?? base.runnerCommand;
  provenance.runnerCommand = overrides.runnerCommand ? 'argument' : fileHas(fileRaw, 'runnerCommand') || (fileRaw === undefined && base.runnerCommand !== DEFAULTS.runnerCommand) ? 'file' : 'default';

  const claude = fileClaude(fileRaw);
  const composed = composeAllowedTools({
    record: detected?.toolchain,
    deriveTools: claude.deriveTools ?? base.runner.claude.deriveTools,
    fileRules: claude.allowedTools ?? base.runner.claude.allowedTools,
    argumentRules: overrides.allowedTools ?? [],
  });
  provenance.allowedTools = 'composed';

  // Model and effort: argument over file over default; an in-memory config with no file stands for the file layer.
  const model = overrides.model ?? base.runner.claude.model;
  provenance.model = overrides.model ? 'argument' : claude.model !== undefined || (fileRaw === undefined && base.runner.claude.model !== DEFAULTS.runner.claude.model) ? 'file' : 'default';
  const effort = overrides.effort ?? base.runner.claude.effort;
  provenance.effort = overrides.effort ? 'argument' : claude.effort !== undefined || (fileRaw === undefined && base.runner.claude.effort !== DEFAULTS.runner.claude.effort) ? 'file' : 'default';

  const needsConfig: OverridableKey[] = checkCommand === undefined ? ['checkCommand'] : [];
  return {
    config: { ...base, checkCommand, integrationBranch, capacity, runnerCommand, runner: { ...base.runner, claude: { ...base.runner.claude, model, effort } } },
    provenance,
    allowedTools: { ...composed, applied: hasAllowedToolsSlot(runnerCommand) },
    model: { value: model, applied: hasModelSlot(runnerCommand) },
    effort: { value: effort, applied: hasEffortSlot(runnerCommand) },
    toolchain: detected?.toolchain,
    needsConfig,
    overrides,
    inputs,
  };
}

export interface ConfigLeaf<T> {
  value: T;
  source: Source;
}

/** The report shape shared by `status`, `GET /v1/config`, the start result, and `config.json`. */
export interface ConfigReport {
  resolvedAt: number;
  repo: string;
  config: {
    checkCommand: ConfigLeaf<string | undefined>;
    integrationBranch: ConfigLeaf<string>;
    capacity: ConfigLeaf<number>;
    runnerCommand: ConfigLeaf<string>;
    allowedTools: ConfigLeaf<string[]> & { parts: AllowedToolsParts; applied: boolean };
    model: ConfigLeaf<string> & { applied: boolean };
    effort: ConfigLeaf<Effort> & { applied: boolean };
  };
  toolchain: ToolchainRecord | undefined;
  overrides: Overrides;
  needsConfig: OverridableKey[];
}

/** The compact form appended as the `config.resolved` event. */
export function configSummary(report: ConfigReport): Record<string, unknown> {
  const c = report.config;
  return {
    checkCommand: c.checkCommand,
    integrationBranch: c.integrationBranch,
    capacity: c.capacity,
    runnerCommand: { source: c.runnerCommand.source },
    allowedTools: { source: c.allowedTools.source, count: c.allowedTools.value.length, applied: c.allowedTools.applied, parts: Object.fromEntries(Object.entries(c.allowedTools.parts).map(([k, v]) => [k, v.length])) },
    model: c.model,
    effort: c.effort,
    toolchain: report.toolchain ? { kinds: report.toolchain.kinds, checkCommand: report.toolchain.checkCommand, checkFrom: report.toolchain.checkFrom, packageManager: report.toolchain.packageManager } : undefined,
    needsConfig: report.needsConfig,
    overrides: Object.keys(report.overrides),
  };
}

/** The override document kept in the store under `config.overrides`; empty when absent or unreadable. */
export function readOverrides(store: { getKv(key: string): string | undefined }): Overrides {
  const raw = store.getKv('config.overrides');
  if (!raw) return {};
  try {
    const parsed = overridesSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

/**
 * `--set key=value` flags into an override document: `capacity` as an integer,
 * `allowedTools` as a JSON array or one rule per flag (appended), `model` and
 * `effort` checked by their shape rules, the rest as strings. Throws a usage error on an unknown key or a bad value.
 */
export function parseSetFlags(flags: readonly string[]): Overrides {
  const out: Record<string, unknown> = {};
  for (const flag of flags) {
    const eq = flag.indexOf('=');
    if (eq <= 0) throw new Error(`--set expects key=value, not ${JSON.stringify(flag)}`);
    const key = flag.slice(0, eq).trim();
    const raw = flag.slice(eq + 1);
    if (!(OVERRIDABLE_KEYS as readonly string[]).includes(key)) throw new Error(`--set: unknown key ${JSON.stringify(key)}; one of ${OVERRIDABLE_KEYS.join(', ')}`);
    if (key === 'capacity') {
      const n = Number(raw);
      if (!raw.trim() || !Number.isInteger(n) || n <= 0) throw new Error(`--set capacity expects a positive integer, not ${JSON.stringify(raw)}`);
      out[key] = n;
    } else if (key === 'allowedTools') {
      let rules: string[];
      if (raw.trim().startsWith('[')) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = undefined;
        }
        if (!Array.isArray(parsed) || !parsed.every((r) => typeof r === 'string')) throw new Error(`--set allowedTools expects a JSON array of rules or one rule, not ${JSON.stringify(raw)}`);
        rules = parsed as string[];
      } else {
        rules = [raw];
      }
      out[key] = [...((out[key] as string[] | undefined) ?? []), ...rules];
    } else {
      if (!raw.trim()) throw new Error(`--set ${key} expects a non-empty value`);
      out[key] = raw;
    }
  }
  const parsed = overridesSchema.safeParse(out);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`--set ${String(issue?.path[0] ?? '')}: ${issue?.message ?? 'invalid value'}`);
  }
  return parsed.data;
}

export type SetConfigResult =
  | { ok: true; applied: OverridableKey[]; report: ConfigReport }
  | { ok: false; status: 400; key: string; error: string }
  | { ok: false; status: 409; startOnly: OverridableKey[]; error: string };

export function reportOf(resolved: Resolved, now: number): ConfigReport {
  return {
    resolvedAt: now,
    repo: resolved.config.repoPath,
    config: {
      checkCommand: { value: resolved.config.checkCommand, source: resolved.provenance.checkCommand },
      integrationBranch: { value: resolved.config.integrationBranch, source: resolved.provenance.integrationBranch },
      capacity: { value: resolved.config.capacity, source: resolved.provenance.capacity },
      runnerCommand: { value: resolved.config.runnerCommand, source: resolved.provenance.runnerCommand },
      allowedTools: { value: resolved.allowedTools.value, source: 'composed', parts: resolved.allowedTools.parts, applied: resolved.allowedTools.applied },
      model: { value: resolved.model.value, source: resolved.provenance.model, applied: resolved.model.applied },
      effort: { value: resolved.effort.value, source: resolved.provenance.effort, applied: resolved.effort.applied },
    },
    toolchain: resolved.toolchain,
    overrides: resolved.overrides,
    needsConfig: resolved.needsConfig,
  };
}
