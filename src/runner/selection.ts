/**
 * Runner kinds, the worker model and effort level: defaults, shape rules, and schemas.
 * The daemon keeps no catalogue of models; a name the CLI rejects fails the
 * launch at spawn. See specs/model-selection and specs/worker-runners.
 */
import { z } from 'zod';

/** The agent CLIs a launch can run under. See specs/worker-runners "Runner kinds and defaults". */
export const RUNNER_KINDS = ['claude-code', 'codex', 'opencode'] as const;
export type RunnerKind = (typeof RUNNER_KINDS)[number];

/** Who commits a launch's work: the agent before it submits, or the daemon when it submits. See specs/worker-runners "Sandbox and commit policy". */
export const COMMIT_POLICIES = ['agent', 'daemon'] as const;
export type CommitPolicy = (typeof COMMIT_POLICIES)[number];

/** The Codex sandbox modes (`codex -s`). */
export const CODEX_SANDBOXES = ['read-only', 'workspace-write', 'danger-full-access'] as const;
export type CodexSandbox = (typeof CODEX_SANDBOXES)[number];

/** OpenCode's permission policy: `derived` from the launch, or `allow` every tool. The semantics belong to the OpenCode runner. */
export const OPENCODE_PERMISSIONS = ['derived', 'allow'] as const;
export type OpenCodePermission = (typeof OPENCODE_PERMISSIONS)[number];

/** Where an OpenCode launch keeps its data: the user's shared data directory, or one per launch. */
export const OPENCODE_DATA_DIRS = ['shared', 'launch'] as const;
export type OpenCodeDataDir = (typeof OPENCODE_DATA_DIRS)[number];

/** Codex's commit default: only danger-full-access can write a linked worktree's gitdir, so the other sandboxes need the daemon to commit. */
export function defaultCodexCommit(sandbox: CodexSandbox): CommitPolicy {
  return sandbox === 'danger-full-access' ? 'agent' : 'daemon';
}

/** The effort levels each kind's CLI accepts; a superset check, the CLI stays the final validator. See specs/worker-runners "Per-kind effort sets". */
export const EFFORT_LEVELS_BY_KIND = {
  'claude-code': ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  // Passed through as `--variant`; which variants a model lists is the CLI's to decide.
  opencode: ['low', 'medium', 'high', 'xhigh', 'max'],
} as const satisfies Record<RunnerKind, readonly string[]>;

/** Every level any kind accepts: the shape check for graph load, import, and task selectors. */
export const EFFORT_LEVELS_ALL = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
export type Effort = (typeof EFFORT_LEVELS_ALL)[number];

/** The Claude Code set, kept for callers that predate runner kinds. */
export const EFFORT_LEVELS = EFFORT_LEVELS_BY_KIND['claude-code'];

export const DEFAULT_MODEL_BY_KIND = { 'claude-code': 'claude-opus-5-5', codex: 'gpt-6-astra', opencode: 'anthropic/claude-opus-5-5' } as const satisfies Record<RunnerKind, string>;
export const DEFAULT_MODEL = DEFAULT_MODEL_BY_KIND['claude-code'];
export const DEFAULT_EFFORT: Effort = 'medium';

/** A level a kind lacks, mapped to the one it runs at instead; applied when a launch is prepared. */
export const EFFORT_FALLBACK: Partial<Record<RunnerKind, Partial<Record<Effort, Effort>>>> = { 'claude-code': { ultra: 'max' }, opencode: { ultra: 'max' } };

/** What a launch is prepared with. `effortRequested` is the level asked for when the kind's fallback replaced it. See specs/model-selection. */
export interface Selection {
  runner: RunnerKind;
  model: string;
  effort: Effort;
  effortRequested?: Effort;
}

/** Aliases and ids as the vendors publish them; nothing that could escape the shell template. */
export const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/** OpenCode's `provider/model`: two names of MODEL_PATTERN's shape joined by exactly one slash. */
export const OPENCODE_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/** The model shape of each kind. */
export const MODEL_PATTERN_BY_KIND = { 'claude-code': MODEL_PATTERN, codex: MODEL_PATTERN, opencode: OPENCODE_MODEL_PATTERN } as const satisfies Record<RunnerKind, RegExp>;

/** A count per runner kind, every kind present at zero; the one source for `claimableByKind`-shaped maps. */
export function zeroByKind(): Record<RunnerKind, number> {
  return Object.fromEntries(RUNNER_KINDS.map((k) => [k, 0])) as Record<RunnerKind, number>;
}

export function isRunnerKind(s: unknown): s is RunnerKind {
  return typeof s === 'string' && (RUNNER_KINDS as readonly string[]).includes(s);
}

export function isModelName(s: unknown): s is string {
  return typeof s === 'string' && MODEL_PATTERN.test(s);
}

/** The model shape of one kind. */
export function isModelNameFor(kind: RunnerKind, s: unknown): s is string {
  return typeof s === 'string' && MODEL_PATTERN_BY_KIND[kind].test(s);
}

/** Some kind's model shape: the check for a selector whose kind is decided when the launch is prepared. */
export function isAnyModelName(s: unknown): s is string {
  return RUNNER_KINDS.some((k) => isModelNameFor(k, s));
}

export function isEffort(s: unknown): s is Effort {
  return typeof s === 'string' && (EFFORT_LEVELS_ALL as readonly string[]).includes(s);
}

export function isEffortFor(kind: RunnerKind, s: unknown): s is Effort {
  return typeof s === 'string' && (EFFORT_LEVELS_BY_KIND[kind] as readonly string[]).includes(s);
}

/** The refusal for a level the kind lacks; names the kind. */
export function effortMessage(kind: RunnerKind, value: unknown): string {
  return `${JSON.stringify(value)} is not an effort level for ${kind}; one of ${EFFORT_LEVELS_BY_KIND[kind].join(', ')}`;
}

const MODEL_SHAPE = 'letters, digits, dots, colons, underscores, and hyphens, starting with a letter or digit';

/** The model shape a kind takes, in words. */
export function modelMessage(kind: RunnerKind): string {
  return kind === 'opencode' ? `an opencode model is provider/model, each part ${MODEL_SHAPE}` : `a model is ${MODEL_SHAPE}`;
}

export const modelSchema = z.string().regex(MODEL_PATTERN, { message: modelMessage('claude-code') });
const opencodeModelSchema = z.string().regex(OPENCODE_MODEL_PATTERN, { message: modelMessage('opencode') });

/** The model schema for one kind; the opencode refusal names the kind. */
export function modelSchemaFor(kind: RunnerKind): z.ZodString {
  return kind === 'opencode' ? opencodeModelSchema : modelSchema;
}

/** Some kind's model shape: task selectors before their kind is known, and price keys. */
export const anyModelSchema = z.string().refine(isAnyModelName, { message: `a model is ${MODEL_SHAPE}, or provider/model of those for opencode` });
export const effortSchema = z.enum(EFFORT_LEVELS_ALL);

/** The effort schema for one kind; the refusal names the kind. */
export function effortSchemaFor(kind: RunnerKind): z.ZodType<Effort, z.ZodTypeDef, unknown> {
  return z.custom<Effort>((v) => isEffortFor(kind, v), (v) => ({ message: effortMessage(kind, v) }));
}
