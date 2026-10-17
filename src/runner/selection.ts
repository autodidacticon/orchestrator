/**
 * The worker model and effort level: defaults, shape rules, and schemas.
 * The daemon keeps no catalogue of models; a name the CLI rejects fails the
 * launch at spawn. See specs/model-selection.
 */
import { z } from 'zod';

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

export const DEFAULT_MODEL = 'claude-opus-5-5';
export const DEFAULT_EFFORT: Effort = 'medium';

/** Aliases and ids as Anthropic publishes them; nothing that could escape the shell template. */
export const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export function isModelName(s: unknown): s is string {
  return typeof s === 'string' && MODEL_PATTERN.test(s);
}

export function isEffort(s: unknown): s is Effort {
  return typeof s === 'string' && (EFFORT_LEVELS as readonly string[]).includes(s);
}

export const modelSchema = z.string().regex(MODEL_PATTERN, { message: 'a model is letters, digits, dots, colons, underscores, and hyphens, starting with a letter or digit' });
export const effortSchema = z.enum(EFFORT_LEVELS);
