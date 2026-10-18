/**
 * Layered configuration: argument, file, pinned (the integration branch only),
 * detected, default. Scalars take the first layer; the allow list composes.
 * Every value carries its provenance. See specs/toolchain-discovery
 * "Resolution order and provenance".
 */
import { z } from 'zod';
import { type Config, configSchema } from '../config.js';
import { hasAllowedToolsSlot, hasEffortSlot, hasModelSlot } from '../runner/command.js';
import { CODEX_SANDBOXES, COMMIT_POLICIES, type CodexSandbox, type CommitPolicy, defaultCodexCommit, type Effort, effortSchema, effortSchemaFor, isRunnerKind, modelSchema, RUNNER_KINDS, type RunnerKind } from '../runner/selection.js';
import type { ToolchainRecord } from '../toolchain/detect.js';
import { type AllowedToolsParts, composeAllowedTools, isSafeRule } from '../toolchain/tools.js';

export const OVERRIDABLE_KEYS = ['checkCommand', 'integrationBranch', 'capacity', 'allowedTools', 'runnerCommand', 'runnerKind', 'model', 'effort', 'claude', 'codex'] as const;
export type OverridableKey = (typeof OVERRIDABLE_KEYS)[number];
export const START_ONLY_KEYS: readonly OverridableKey[] = ['integrationBranch'];

/** The override namespace of each runner kind, and the leaves it holds. */
const NAMESPACE_OF = { 'claude-code': 'claude', codex: 'codex' } as const satisfies Record<RunnerKind, string>;
type Namespace = (typeof NAMESPACE_OF)[RunnerKind];
const NAMESPACES: readonly Namespace[] = ['claude', 'codex'];
const NAMESPACE_LEAVES: Record<Namespace, readonly string[]> = { claude: ['model', 'effort', 'commit'], codex:['model', 'effort', 'sandbox', 'commit', 'command'] };

const rule = z.string().refine(isSafeRule, (r) => ({ message: `rule ${JSON.stringify(r)} must not be empty or contain a double quote, backslash, dollar sign, or backtick` }));

const claudeOverridesSchema = z
  .object({
    model: modelSchema.nullable().optional(),
    effort: effortSchemaFor('claude-code').nullable().optional(),
    commit: z.enum(COMMIT_POLICIES).nullable().optional(),
  })
  .strict();

const codexOverridesSchema = z
  .object({
    model: modelSchema.nullable().optional(),
    effort: effortSchemaFor('codex').nullable().optional(),
    sandbox: z.enum(CODEX_SANDBOXES).nullable().optional(),
    commit: z.enum(COMMIT_POLICIES).nullable().optional(),
    command: z.string().min(1).nullable().optional(),
  })
  .strict();

/**
 * An override document: a value sets the key, null clears it. The stored document
 * keeps model and effort per kind under `claude` and `codex`; the flat `model` and
 * `effort` are accepted in a patch and bound to the kind in force when it is written.
 */
export const overridesSchema = z
  .object({
    checkCommand: z.string().min(1).nullable().optional(),
    integrationBranch: z.string().min(1).nullable().optional(),
    capacity: z.number().int().positive().nullable().optional(),
    allowedTools: z.array(rule).nullable().optional(),
    runnerCommand: z.string().min(1).nullable().optional(),
    runnerKind: z.enum(RUNNER_KINDS).nullable().optional(),
    model: modelSchema.nullable().optional(),
    effort: effortSchema.nullable().optional(),
    claude: claudeOverridesSchema.nullable().optional(),
    codex: codexOverridesSchema.nullable().optional(),
  })
  .strict();
export type Overrides = z.infer<typeof overridesSchema>;

export type Source = 'argument' | 'file' | 'pinned' | 'detected' | 'default' | 'unresolved' | 'composed';

export interface Provenance {
  checkCommand: Source;
  integrationBranch: Source;
  capacity: Source;
  runnerCommand: Source;
  runnerKind: Source;
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

export interface ConfigLeaf<T> {
  value: T;
  source: Source;
}

/** The Claude Code runner's policy leaves, resolved whichever kind is in force. */
export interface ClaudeLeaves {
  commit: ConfigLeaf<CommitPolicy>;
}

/** The Codex runner's leaves, resolved whichever kind is in force. */
export interface CodexLeaves {
  model: ConfigLeaf<string>;
  effort: ConfigLeaf<Effort>;
  command: ConfigLeaf<string | undefined>;
  sandbox: ConfigLeaf<CodexSandbox>;
  /** Unset in the file and the overrides, derived from the resolved sandbox (`defaultCodexCommit`). */
  commit: ConfigLeaf<CommitPolicy>;
  networkAccess: ConfigLeaf<boolean | undefined>;
  ignoreUserConfig: ConfigLeaf<boolean>;
  ephemeral: ConfigLeaf<boolean>;
}

export interface Resolved {
  config: Config;
  provenance: Provenance;
  /** The runner kind in force. See specs/worker-runners. */
  kind: ConfigLeaf<RunnerKind>;
  /** The allow list; composed for claude-code only, empty and not applied for codex. */
  allowedTools: { value: string[]; parts: AllowedToolsParts; applied: boolean };
  /** The run default model and effort of the kind in force; `applied` is whether that kind's template carries the slot. See specs/model-selection. */
  model: { value: string; applied: boolean };
  effort: { value: Effort; applied: boolean };
  claude: ClaudeLeaves;
  codex: CodexLeaves;
  toolchain: ToolchainRecord | undefined;
  needsConfig: OverridableKey[];
  overrides: Overrides;
  inputs: ResolveInputs;
}

const DEFAULTS = configSchema.parse({});

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function fileHas(raw: Record<string, unknown> | undefined, key: string): boolean {
  return raw !== undefined && raw[key] !== undefined && raw[key] !== null;
}

/** The file's `runner` block as written. */
function fileRunnerBlock(raw: Record<string, unknown> | undefined): Record<string, unknown> {
  const runner = raw?.['runner'];
  return isObject(runner) ? runner : {};
}

/** The file's `runner.<namespace>` block as written. */
function fileRunner(raw: Record<string, unknown> | undefined, ns: Namespace): Record<string, unknown> {
  const block = fileRunnerBlock(raw)[ns];
  return isObject(block) ? block : {};
}

/** Merge a patch into an override document: a null clears the key; inside `claude` and `codex` a null clears one leaf. */
export function mergeOverrides(current: Overrides, patch: Overrides): Overrides {
  const out: Record<string, unknown> = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else if (v === undefined) continue;
    else if ((NAMESPACES as readonly string[]).includes(k) && isObject(v)) {
      const ns: Record<string, unknown> = isObject(out[k]) ? { ...(out[k] as Record<string, unknown>) } : {};
      for (const [leaf, lv] of Object.entries(v)) {
        if (lv === null) delete ns[leaf];
        else if (lv !== undefined) ns[leaf] = lv;
      }
      if (Object.keys(ns).length) out[k] = ns;
      else delete out[k];
    } else out[k] = v;
  }
  return out as Overrides;
}

/** Move a patch's flat `model` and `effort` under the namespace of `kind`; an explicit namespaced leaf wins. */
function bindFlat(patch: Record<string, unknown>, kind: RunnerKind): { doc: Record<string, unknown>; bound: Set<string> } {
  const ns = NAMESPACE_OF[kind];
  const bound = new Set<string>();
  if (patch[ns] === null || (patch[ns] !== undefined && !isObject(patch[ns]))) return { doc: patch, bound };
  const doc: Record<string, unknown> = { ...patch };
  const nested: Record<string, unknown> = isObject(patch[ns]) ? { ...(patch[ns] as Record<string, unknown>) } : {};
  for (const key of ['model', 'effort']) {
    if (doc[key] === undefined) continue;
    if (nested[key] === undefined) nested[key] = doc[key];
    delete doc[key];
    bound.add(key);
  }
  if (bound.size) doc[ns] = nested;
  return { doc, bound };
}

export type PatchResult = { ok: true; patch: Overrides } | { ok: false; key: string; error: string };

/**
 * Validate an override patch. With a kind (the patch's own `runnerKind` first),
 * the flat `model` and `effort` are bound to that kind's namespace and `effort`
 * is checked against the kind's set; without one they stay flat.
 */
export function parseOverridePatch(patch: unknown, kind?: RunnerKind): PatchResult {
  let doc = patch ?? {};
  let bound = new Set<string>();
  let ns: Namespace | undefined;
  if (isObject(doc)) {
    const k = isRunnerKind(doc['runnerKind']) ? doc['runnerKind'] : kind;
    if (k) {
      ns = NAMESPACE_OF[k];
      ({ doc, bound } = bindFlat(doc, k));
      const d = doc as Record<string, unknown>;
      if (d[ns] === null && (d['model'] !== undefined || d['effort'] !== undefined)) return { ok: false, key: ns, error: `a null ${ns} clears its model and effort and cannot be combined with a flat model or effort` };
    }
  }
  const parsed = overridesSchema.safeParse(doc);
  if (parsed.success) return { ok: true, patch: parsed.data };
  const issue = parsed.error.issues[0];
  const path = issue?.code === 'unrecognized_keys' ? [...issue.path, String(issue.keys[0] ?? '')] : (issue?.path ?? []);
  // A flat key bound to the kind keeps its own name in the refusal; the message names the kind.
  const named = (NAMESPACES as readonly unknown[]).includes(path[0]) ? path.slice(0, 2) : path.slice(0, 1);
  const key = named.length === 2 && named[0] === ns && bound.has(String(named[1])) ? String(named[1]) : named.map(String).join('.');
  return { ok: false, key, error: issue?.message ?? 'invalid value' };
}

/**
 * Operator-surface arguments into an override patch: `sandbox` is codex's, and
 * `commit` lands under the namespace of the patch's own `runnerKind`, else of
 * `kind` (the kind in force). Used by `orchestrator-ctl config` and the MCP
 * `start` and `configure` tools. See specs/operator-control "Configuration route".
 */
export function foldRunnerArgs(args: Record<string, unknown>, kind: RunnerKind): Record<string, unknown> {
  const { sandbox, commit, ...out } = args;
  const put = (ns: Namespace, leafKey: string, v: unknown) => {
    if (v !== undefined) out[ns] = { ...(isObject(out[ns]) ? out[ns] : {}), [leafKey]: v };
  };
  put('codex', 'sandbox', sandbox);
  put(NAMESPACE_OF[isRunnerKind(out['runnerKind']) ? out['runnerKind'] : kind], 'commit', commit);
  return out;
}

export type ApplyResult ={ ok: true; patch: Overrides; next: Overrides } | { ok: false; key: string; error: string };

/**
 * Validate a patch against the document in force and merge it. The flat `model`
 * and `effort` bind to the kind in force once the patch applies: its own
 * `runnerKind`, else the kind the current document resolves to.
 */
export function applyOverridePatch(inputs: ResolveInputs, current: Overrides, patch: unknown): ApplyResult {
  const raw = isObject(patch) ? patch['runnerKind'] : undefined;
  const kind = isRunnerKind(raw) ? raw : resolveLayers(inputs, raw === null ? { ...current, runnerKind: undefined } : current).kind.value;
  const parsed = parseOverridePatch(patch, kind);
  if (!parsed.ok) return parsed;
  return { ok: true, patch: parsed.patch, next: mergeOverrides(current, parsed.patch) };
}

/** A scalar leaf: argument over file over default; an in-memory config with no file stands for the file layer. */
function leaf<T>(argument: T | null | undefined, fileSets: boolean, base: T, fallback: T, noFile: boolean): ConfigLeaf<T> {
  if (argument !== undefined && argument !== null) return { value: argument, source: 'argument' };
  return { value: base, source: fileSets || (noFile && base !== fallback) ? 'file' : 'default' };
}

const EMPTY_PARTS: AllowedToolsParts = { default: [], detected: [], file: [], argument: [] };

export function resolveLayers(inputs: ResolveInputs, overrides: Overrides = {}): Resolved {
  const { base, fileRaw, detected, pinned } = inputs;
  const provenance = {} as Provenance;
  const noFile = fileRaw === undefined;

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

  const kind = leaf(overrides.runnerKind, fileHas(fileRunnerBlock(fileRaw), 'kind'), base.runner.kind, DEFAULTS.runner.kind, noFile);
  provenance.runnerKind = kind.source;

  // Model and effort per kind; a flat key in an unbound document stands for the kind in force.
  const flat = (k: RunnerKind) => (k === kind.value ? { model: overrides.model, effort: overrides.effort } : {});
  const claudeFile = fileRunner(fileRaw, 'claude');
  const codexFile = fileRunner(fileRaw, 'codex');
  const claudeModel = leaf(flat('claude-code').model ?? overrides.claude?.model, fileHas(claudeFile, 'model'), base.runner.claude.model, DEFAULTS.runner.claude.model, noFile);
  const claudeEffort = leaf<Effort>(flat('claude-code').effort ?? overrides.claude?.effort, fileHas(claudeFile, 'effort'), base.runner.claude.effort, DEFAULTS.runner.claude.effort, noFile);
  const c = base.runner.codex;
  const d = DEFAULTS.runner.codex;
  const o = overrides.codex ?? {};
  const claude: ClaudeLeaves = {
    commit: leaf(overrides.claude?.commit, fileHas(claudeFile, 'commit'), base.runner.claude.commit, DEFAULTS.runner.claude.commit, noFile),
  };
  const sandbox = leaf(o.sandbox, fileHas(codexFile, 'sandbox'), c.sandbox, d.sandbox, noFile);
  // Derived from the sandbox in force, so a sandbox override moves the default with it. See specs/worker-runners "Sandbox and commit policy".
  const derivedCommit = defaultCodexCommit(sandbox.value);
  const codex: CodexLeaves = {
    model: leaf(flat('codex').model ?? o.model, fileHas(codexFile, 'model'), c.model, d.model, noFile),
    effort: leaf<Effort>(flat('codex').effort ?? o.effort, fileHas(codexFile, 'effort'), c.effort, d.effort, noFile),
    command: leaf(o.command, fileHas(codexFile, 'command'), c.command, d.command, noFile),
    sandbox,
    commit: leaf<CommitPolicy>(o.commit, fileHas(codexFile, 'commit'), c.commit ?? derivedCommit, derivedCommit, noFile),
    networkAccess: leaf(undefined, fileHas(codexFile, 'networkAccess'), c.networkAccess, d.networkAccess, noFile),
    ignoreUserConfig: leaf(undefined, fileHas(codexFile, 'ignoreUserConfig'), c.ignoreUserConfig, d.ignoreUserConfig, noFile),
    ephemeral: leaf(undefined, fileHas(codexFile, 'ephemeral'), c.ephemeral, d.ephemeral, noFile),
  };
  const isCodex = kind.value === 'codex';
  const model = isCodex ? codex.model : claudeModel;
  const effort = isCodex ? codex.effort : claudeEffort;
  provenance.model = model.source;
  provenance.effort = effort.source;

  // Allow-list composition is claude-code only. Codex's built-in template carries the model and effort slots; a template from the file or an argument is read for them.
  const allowedTools = isCodex
    ? { value: [], parts: EMPTY_PARTS, applied: false }
    : {
        ...composeAllowedTools({
          record: detected?.toolchain,
          deriveTools: typeof claudeFile['deriveTools'] === 'boolean' ? claudeFile['deriveTools'] : base.runner.claude.deriveTools,
          fileRules: Array.isArray(claudeFile['allowedTools']) ? claudeFile['allowedTools'].map(String) : base.runner.claude.allowedTools,
          argumentRules: overrides.allowedTools ?? [],
        }),
        applied: hasAllowedToolsSlot(runnerCommand),
      };
  provenance.allowedTools = 'composed';
  const template = isCodex ? codex.command.value : runnerCommand;
  const modelApplied = template === undefined ? true : hasModelSlot(template);
  const effortApplied = template === undefined ? true : hasEffortSlot(template);

  const needsConfig: OverridableKey[] = checkCommand === undefined ? ['checkCommand'] : [];
  return {
    config: {
      ...base,
      checkCommand,
      integrationBranch,
      capacity,
      runnerCommand,
      runner: {
        ...base.runner,
        kind: kind.value,
        claude: { ...base.runner.claude, model: claudeModel.value, effort: claudeEffort.value, commit: claude.commit.value },
        codex: { ...c, model: codex.model.value, effort: codex.effort.value, command: codex.command.value, sandbox: codex.sandbox.value, commit: codex.commit.value },
      },
    },
    provenance,
    kind,
    allowedTools,
    model: { value: model.value, applied: modelApplied },
    effort: { value: effort.value, applied: effortApplied },
    claude,
    codex,
    toolchain: detected?.toolchain,
    needsConfig,
    overrides,
    inputs,
  };
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
    runnerKind: ConfigLeaf<RunnerKind>;
    allowedTools: ConfigLeaf<string[]> & { parts: AllowedToolsParts; applied: boolean };
    model: ConfigLeaf<string> & { applied: boolean };
    effort: ConfigLeaf<Effort> & { applied: boolean };
    claude: ClaudeLeaves;
    codex: CodexLeaves;
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
    runnerKind: c.runnerKind,
    allowedTools: { source: c.allowedTools.source, count: c.allowedTools.value.length, applied: c.allowedTools.applied, parts: Object.fromEntries(Object.entries(c.allowedTools.parts).map(([k, v]) => [k, v.length])) },
    model: c.model,
    effort: c.effort,
    toolchain: report.toolchain ? { kinds: report.toolchain.kinds, checkCommand: report.toolchain.checkCommand, checkFrom: report.toolchain.checkFrom, packageManager: report.toolchain.packageManager } : undefined,
    needsConfig: report.needsConfig,
    overrides: Object.keys(report.overrides),
  };
}

/**
 * The override document kept in the store under `config.overrides`; empty when absent or unreadable.
 * A document stored before runner kinds holds a flat `model` and `effort`; they are read as `claude.*`.
 */
export function readOverrides(store: { getKv(key: string): string | undefined }): Overrides {
  const raw = store.getKv('config.overrides');
  if (!raw) return {};
  try {
    let doc: unknown = JSON.parse(raw);
    if (isObject(doc) && (doc['model'] !== undefined || doc['effort'] !== undefined)) doc = bindFlat(doc, 'claude-code').doc;
    const parsed = overridesSchema.safeParse(doc);
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

const DOTTED_KEYS = NAMESPACES.flatMap((ns) => NAMESPACE_LEAVES[ns].map((l) => `${ns}.${l}`));

/**
 * `--set key=value` flags into an override document: `capacity` as an integer,
 * `allowedTools` as a JSON array or one rule per flag (appended), `claude.<leaf>`
 * and `codex.<leaf>` folded into their namespace (or `claude=`/`codex=` as a JSON
 * object), the rest as strings. With a `runnerKind` flag or a `kind`, the flat
 * `model` and `effort` bind to that kind and `effort` is checked against its set.
 * Throws a usage error on an unknown key or a bad value.
 */
export function parseSetFlags(flags: readonly string[], kind?: RunnerKind): Overrides {
  const out: Record<string, unknown> = {};
  for (const flag of flags) {
    const eq = flag.indexOf('=');
    if (eq <= 0) throw new Error(`--set expects key=value, not ${JSON.stringify(flag)}`);
    const key = flag.slice(0, eq).trim();
    const raw = flag.slice(eq + 1);
    if (DOTTED_KEYS.includes(key)) {
      const [ns, leafKey] = key.split('.') as [Namespace, string];
      if (!raw.trim()) throw new Error(`--set ${key} expects a non-empty value`);
      out[ns] = { ...(isObject(out[ns]) ? out[ns] : {}), [leafKey]: raw };
      continue;
    }
    if (!(OVERRIDABLE_KEYS as readonly string[]).includes(key)) throw new Error(`--set: unknown key ${JSON.stringify(key)}; one of ${[...OVERRIDABLE_KEYS.filter((k) => !(NAMESPACES as readonly string[]).includes(k)), ...DOTTED_KEYS].join(', ')}`);
    if ((NAMESPACES as readonly string[]).includes(key)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = undefined;
      }
      if (!isObject(parsed)) throw new Error(`--set ${key} expects a JSON object, or use ${NAMESPACE_LEAVES[key as Namespace].map((l) => `${key}.${l}`).join(', ')}`);
      out[key] = { ...(isObject(out[key]) ? out[key] : {}), ...parsed };
    } else if (key === 'capacity') {
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
  const parsed = parseOverridePatch(out, kind);
  if (!parsed.ok) throw new Error(`--set ${parsed.key}: ${parsed.error}`);
  return parsed.patch;
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
      runnerKind: resolved.kind,
      allowedTools: { value: resolved.allowedTools.value, source: 'composed', parts: resolved.allowedTools.parts, applied: resolved.allowedTools.applied },
      model: { value: resolved.model.value, source: resolved.provenance.model, applied: resolved.model.applied },
      effort: { value: resolved.effort.value, source: resolved.provenance.effort, applied: resolved.effort.applied },
      claude: resolved.claude,
      codex: resolved.codex,
    },
    toolchain: resolved.toolchain,
    overrides: resolved.overrides,
    needsConfig: resolved.needsConfig,
  };
}
