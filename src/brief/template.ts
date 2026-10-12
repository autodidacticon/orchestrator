/**
 * Brief template slots and validation. See specs/agent-protocol
 * "Brief validation and remediation".
 */
import type { GraphNode } from '../graph/model.js';
import type { BriefValidator, ValidationResult } from './validate.js';

export interface SlotSpec {
  /** Payload field the slot is filled from. */
  source: string;
  required: boolean;
  minLength: number;
}

export type SlotTemplate = Record<string, SlotSpec>;

export const defaultSlots: SlotTemplate = {
  description: { source: 'description', required: true, minLength: 1 },
  acceptanceCriteria: { source: 'acceptanceCriteria', required: true, minLength: 1 },
};

/** A slot's value as text: strings as-is, arrays joined, anything else stringified. */
export function slotValue(payload: Record<string, unknown>, source: string): string | undefined {
  const v = payload[source];
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string') return v.trim();
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean).join('\n');
  return String(v);
}

export class SlotValidator implements BriefValidator {
  constructor(private readonly template: SlotTemplate = defaultSlots) {}

  validate(node: GraphNode, payload: Record<string, unknown>): ValidationResult {
    if (node.kind !== 'task') return { ok: true };
    const missing: string[] = [];
    for (const [name, spec] of Object.entries(this.template)) {
      if (!spec.required) continue;
      const v = slotValue(payload, spec.source);
      if (v === undefined || v.length < spec.minLength) missing.push(name);
    }
    return missing.length ? { ok: false, missing } : { ok: true };
  }
}
