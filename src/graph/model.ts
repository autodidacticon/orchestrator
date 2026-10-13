/**
 * Graph model. See specs/task-graph.
 *
 * Vocabulary: deps(n), dependents(n), closure(n). No "root", "leaf", or
 * unqualified "edge". Only blocking relations are deps.
 */
export type Id = string;

export type NodeKind = 'task' | 'milestone' | 'external';

export interface GraphNode {
  id: Id;
  kind: NodeKind;
  /** Milestones only: requires human accept/reject instead of auto-completion. */
  gated: boolean;
  /** External nodes only: satisfied iff true. Never scheduled here. */
  done: boolean;
  deps: readonly Id[];
  /** Everything else from the source file (title, description, acceptanceCriteria, behavior...). */
  payload: Readonly<Record<string, unknown>>;
}

export interface Graph {
  /** Content hash of the loaded file. */
  rev: string;
  /** Insertion-ordered: file order is the FIFO order. */
  nodes: ReadonlyMap<Id, GraphNode>;
  /** Reverse index, derived. */
  dependents: ReadonlyMap<Id, readonly Id[]>;
}

export function buildDependents(nodes: ReadonlyMap<Id, GraphNode>): Map<Id, Id[]> {
  const out = new Map<Id, Id[]>();
  for (const id of nodes.keys()) out.set(id, []);
  for (const node of nodes.values()) {
    for (const d of node.deps) {
      out.get(d)?.push(node.id);
    }
  }
  return out;
}

export function makeGraph(rev: string, nodes: ReadonlyMap<Id, GraphNode>): Graph {
  return { rev, nodes, dependents: buildDependents(nodes) };
}
