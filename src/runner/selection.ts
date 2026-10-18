/**
 * Runner kinds, the worker model and effort level: defaults, shape rules, and schemas.
 * The daemon keeps no catalogue of models; a name the CLI rejects fails the
 * launch at spawn. See specs/model-selection and specs/worker-runners.
 */
import { z } from 'zod';

/** The agent CLIs a launch can run under. See specs/worker-runners "Runner kinds and defaults". */
export const RUNNER_KINDS = ['claude-code', 'codex'] as const;
export type RunnerKind = (typeof RUNNER_KINDS)[number];

/** The effort levels each kind's CLI accepts; a superset check, the CLI stays the final validator. See specs/worker-runners "Per-kind effort sets". */
export const EFFORT_LEVELS_BY_KIND = {
  'claude-code': ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
} as const satisfies Record<RunnerKind, readonly string[]>;

/** Every level any kind accepts: the shape check for graph load, import, and task selectors. */
export const EFFORT_LEVELS_ALL = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
export type Effort = (typeof EFFORT_LEVELS_ALL)[number];

/** The Claude Code set, kept for callers that predate runner kinds. */
export const EFFORT_LEVELS = EFFORT_LEVELS_BY_KIND['claude-code'];

export const DEFAULT_MODEL_BY_KIND = { 'claude-code': 'claude-opus-5-5', codex: 'gpt-6-astra' } as const satisfies Record<RunnerKind, string>;
export const DEFAULT_MODEL = DEFAULT_MODEL_BY_KIND['claude-code'];
export const DEFAULT_EFFORT: Effort = 'medium';

/** A level a kind lacks, mapped to the one it runs at instead; applied when a launch is prepared. */
export const EFFORT_FALLBACK: Partial<Record<RunnerKind, Partial<Record<Effort, Effort>>>> = { 'claude-code': { ultra: 'max' } };

/** Aliases and ids as the vendors publish them; nothing that could escape the shell template. */
export const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export function isRunnerKind(s: unknown): s is RunnerKind {
  return typeof s === 'string' && (RUNNER_KINDS as readonly string[]).includes(s);
}

export function isModelName(s: unknown): s is string {
  return typeof s === 'string' && MODEL_PATTERN.test(s);
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

export const modelSchema = z.string().regex(MODEL_PATTERN, { message: 'a model is letters, digits, dots, colons, underscores, and hyphens, starting with a letter or digit' });
export const effortSchema = z.enum(EFFORT_LEVELS_ALL);

/** The effort schema for one kind; the refusal names the kind. */
export function effortSchemaFor(kind: RunnerKind): z.ZodType<Effort, z.ZodTypeDef, unknown> {
  return z.custom<Effort>((v) => isEffortFor(kind, v), (v) => ({ message: effortMessage(kind, v) }));
}
