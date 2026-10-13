/**
 * The transition table as data, one guard, and counter effects.
 * See specs/task-lifecycle "Transition table enforcement" and "Counters".
 */
import type { NodeKind } from '../graph/model.js';
import type { Entry, Status, StatusKind } from './status.js';

export type Actor = 'orchestrator' | 'agent' | 'verifier' | 'human';

export type Effect = 'attempts++' | 'integrationRetries++' | 'launches++' | 'resetBudgets' | 'reviewVersion++';

export interface TransitionRow {
  from: StatusKind | 'nonTerminal';
  to: StatusKind;
  actor: Actor;
  nodeKind: NodeKind | 'any';
  trigger: string;
  effects: readonly Effect[];
}

const NON_TERMINAL: readonly StatusKind[] = ['unstarted', 'running', 'waiting', 'submitted', 'failed', 'blocked'];

export const TRANSITIONS: readonly TransitionRow[] = [
  { from: 'unstarted', to: 'blocked', actor: 'orchestrator', nodeKind: 'task', trigger: 'briefValidationFailed', effects: [] },
  { from: 'unstarted', to: 'running', actor: 'orchestrator', nodeKind: 'task', trigger: 'admitted', effects: ['launches++'] },
  { from: 'running', to: 'submitted', actor: 'agent', nodeKind: 'task', trigger: 'submit', effects: [] },
  { from: 'running', to: 'failed', actor: 'agent', nodeKind: 'task', trigger: 'fail', effects: ['attempts++'] },
  { from: 'running', to: 'blocked', actor: 'agent', nodeKind: 'task', trigger: 'fallbackBlock', effects: [] },
  { from: 'running', to: 'waiting', actor: 'agent', nodeKind: 'task', trigger: 'block', effects: [] },
  { from: 'running', to: 'failed', actor: 'orchestrator', nodeKind: 'task', trigger: 'deadOrExpired', effects: ['attempts++'] },
  { from: 'running', to: 'failed', actor: 'orchestrator', nodeKind: 'task', trigger: 'stuck', effects: ['attempts++'] },
  { from: 'running', to: 'failed', actor: 'orchestrator', nodeKind: 'task', trigger: 'timeBudget', effects: ['attempts++'] },
  { from: 'running', to: 'unstarted', actor: 'orchestrator', nodeKind: 'task', trigger: 'released', effects: [] },
  { from: 'waiting', to: 'running', actor: 'orchestrator', nodeKind: 'task', trigger: 'resumed', effects: [] },
  { from: 'waiting', to: 'blocked', actor: 'orchestrator', nodeKind: 'task', trigger: 'maxWaitOrDead', effects: [] },
  { from: 'submitted', to: 'done', actor: 'verifier', nodeKind: 'task', trigger: 'published', effects: [] },
  { from: 'submitted', to: 'failed', actor: 'verifier', nodeKind: 'task', trigger: 'verificationFailed', effects: ['attempts++'] },
  { from: 'submitted', to: 'unstarted', actor: 'verifier', nodeKind: 'task', trigger: 'conflict', effects: ['integrationRetries++'] },
  { from: 'failed', to: 'unstarted', actor: 'orchestrator', nodeKind: 'task', trigger: 'retry', effects: [] },
  { from: 'failed', to: 'blocked', actor: 'orchestrator', nodeKind: 'task', trigger: 'exhausted', effects: [] },
  { from: 'blocked', to: 'unstarted', actor: 'human', nodeKind: 'any', trigger: 'unblock', effects: ['resetBudgets'] },
  { from: 'done', to: 'unstarted', actor: 'human', nodeKind: 'any', trigger: 'reopen', effects: ['resetBudgets'] },
  { from: 'cancelled', to: 'unstarted', actor: 'human', nodeKind: 'any', trigger: 'uncancel', effects: ['resetBudgets'] },
  { from: 'running', to: 'unstarted', actor: 'human', nodeKind: 'task', trigger: 'cascade', effects: ['resetBudgets'] },
  { from: 'waiting', to: 'unstarted', actor: 'human', nodeKind: 'task', trigger: 'cascade', effects: ['resetBudgets'] },
  { from: 'submitted', to: 'unstarted', actor: 'human', nodeKind: 'task', trigger: 'cascade', effects: ['resetBudgets'] },
  { from: 'done', to: 'unstarted', actor: 'human', nodeKind: 'task', trigger: 'cascade', effects: ['resetBudgets'] },
  { from: 'nonTerminal', to: 'cancelled', actor: 'human', nodeKind: 'any', trigger: 'cancel', effects: [] },
  { from: 'unstarted', to: 'done', actor: 'orchestrator', nodeKind: 'milestone', trigger: 'milestoneAuto', effects: [] },
  { from: 'unstarted', to: 'submitted', actor: 'orchestrator', nodeKind: 'milestone', trigger: 'milestoneGated', effects: ['reviewVersion++'] },
  { from: 'submitted', to: 'done', actor: 'human', nodeKind: 'milestone', trigger: 'accept', effects: [] },
  { from: 'submitted', to: 'blocked', actor: 'human', nodeKind: 'milestone', trigger: 'reject', effects: [] },
  { from: 'done', to: 'unstarted', actor: 'orchestrator', nodeKind: 'milestone', trigger: 'milestoneReset', effects: [] },
  { from: 'submitted', to: 'unstarted', actor: 'orchestrator', nodeKind: 'milestone', trigger: 'milestoneReset', effects: [] },
];

export class TransitionError extends Error {
  constructor(
    public readonly nodeId: string,
    public readonly from: StatusKind,
    public readonly to: StatusKind,
    public readonly actor: Actor,
    public readonly nodeKind: NodeKind,
  ) {
    super(`transition not allowed for ${nodeKind} ${nodeId}: ${from} -> ${to} by ${actor}`);
    this.name = 'TransitionError';
  }
}

export function findTransition(
  nodeKind: NodeKind,
  from: StatusKind,
  to: StatusKind,
  actor: Actor,
  trigger?: string,
): TransitionRow | undefined {
  return TRANSITIONS.find(
    (r) =>
      r.to === to &&
      r.actor === actor &&
      (r.nodeKind === 'any' || r.nodeKind === nodeKind) &&
      (r.from === from || (r.from === 'nonTerminal' && NON_TERMINAL.includes(from))) &&
      (trigger === undefined || r.trigger === trigger),
  );
}

export function isAllowed(nodeKind: NodeKind, from: StatusKind, to: StatusKind, actor: Actor): boolean {
  return findTransition(nodeKind, from, to, actor) !== undefined;
}

export interface ApplyOptions {
  nodeId: string;
  nodeKind: NodeKind;
  actor: Actor;
  trigger?: string;
  now: number;
  /** Extra entry fields to merge (lease, integrationSha, carry, accepted). */
  patch?: Partial<Entry>;
}

/** Guard plus counter effects. Returns a new entry; throws TransitionError if not allowed. */
export function applyTransition(entry: Entry, next: Status, opts: ApplyOptions): Entry {
  const row = findTransition(opts.nodeKind, entry.status.kind, next.kind, opts.actor, opts.trigger);
  if (!row) throw new TransitionError(opts.nodeId, entry.status.kind, next.kind, opts.actor, opts.nodeKind);
  let out: Entry = { ...entry, ...opts.patch, status: next, updatedAt: opts.now };
  for (const e of row.effects) {
    switch (e) {
      case 'attempts++':
        out = { ...out, attempts: out.attempts + 1 };
        break;
      case 'integrationRetries++':
        out = { ...out, integrationRetries: out.integrationRetries + 1 };
        break;
      case 'launches++':
        out = { ...out, launches: out.launches + 1 };
        break;
      case 'resetBudgets':
        out = { ...out, attempts: 0, integrationRetries: 0 };
        break;
      case 'reviewVersion++':
        out = { ...out, reviewVersion: out.reviewVersion + 1 };
        break;
    }
  }
  // Leaving a lease-holding status clears the lease unless the patch sets one.
  if ((next.kind !== 'running' && next.kind !== 'waiting') && !(opts.patch && 'lease' in opts.patch)) {
    out = { ...out, lease: undefined };
  }
  return out;
}
