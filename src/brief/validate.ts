/**
 * Brief validation hook interface and the permissive default used by logic tests.
 * Slot-based validation lives in template.ts; remediation in remediate.ts.
 */
import type { GraphNode } from '../graph/model.js';

export type ValidationResult = { ok: true } | { ok: false; missing: string[] };

export interface BriefValidator {
  validate(node: GraphNode, payload: Record<string, unknown>): ValidationResult;
}

export const alwaysValid: BriefValidator = { validate: () => ({ ok: true }) };

export type { RemediationContext, Remediator } from './remediate.js';
export { noRemediation } from './remediate.js';
