/**
 * Remediation hook: the first LLM hook point. v1 ships the interface, a
 * default that never remediates (so the task blocks for a human), and a
 * static implementation for tests. A model-backed remediator is a follow-up.
 */
import type { GraphNode } from '../graph/model.js';

export interface RemediationContext {
  missing: string[];
  depReports: Array<{ taskId: string; summary?: string }>;
}

/** Produces the missing slot content, or undefined if it cannot. */
export interface Remediator {
  remediate(node: GraphNode, payload: Record<string, unknown>, ctx: RemediationContext): Promise<Record<string, unknown> | undefined>;
}

export const noRemediation: Remediator = { remediate: async () => undefined };

/** Returns a fixed candidate for every missing slot. Tests and dry runs. */
export class StaticRemediator implements Remediator {
  readonly calls: Array<{ taskId: string; missing: string[] }> = [];
  constructor(private readonly fill: (slot: string, node: GraphNode) => unknown = (slot) => `candidate ${slot}`) {}
  async remediate(node: GraphNode, _payload: Record<string, unknown>, ctx: RemediationContext): Promise<Record<string, unknown>> {
    this.calls.push({ taskId: node.id, missing: ctx.missing });
    return Object.fromEntries(ctx.missing.map((m) => [m, this.fill(m, node)]));
  }
}
