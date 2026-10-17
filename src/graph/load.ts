/**
 * Graph file loading and validation. See specs/task-graph.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { effortSchema, modelSchema } from '../runner/selection.js';
import { type Graph, type GraphNode, type Id, makeGraph } from './model.js';

export class GraphValidationError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'parse'
      | 'schema'
      | 'duplicateId'
      | 'unknownDependency'
      | 'selfLoop'
      | 'cycle',
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'GraphValidationError';
  }
}

const nodeSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(['task', 'milestone', 'external']).default('task'),
    gated: z.boolean().default(false),
    done: z.boolean().default(false),
    deps: z.array(z.string().min(1)).default([]),
    /** Path globs the task's work stays within; stays in the payload. See specs/scheduling-policy "Scope declaration". */
    scope: z.array(z.string().min(1)).optional(),
    /** The worker model and effort for this task's launches; stay in the payload. See specs/model-selection "Task selectors". */
    model: modelSchema.optional(),
    effort: effortSchema.optional(),
  })
  .passthrough();

const fileSchema = z.object({ nodes: z.array(nodeSchema) });

export function revOf(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** Parse and validate graph text (JSON or YAML; YAML is a superset of JSON). */
export function parseGraph(content: string): Graph {
  let raw: unknown;
  try {
    raw = parseYaml(content);
  } catch (err) {
    throw new GraphValidationError(`cannot parse graph file: ${(err as Error).message}`, 'parse');
  }
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new GraphValidationError(
      `graph file does not match schema: ${parsed.error.issues.map((i) => `${describeIssuePath(raw, i.path)}: ${i.message}`).join('; ')}`,
      'schema',
      { issues: parsed.error.issues },
    );
  }

  const nodes = new Map<Id, GraphNode>();
  for (const n of parsed.data.nodes) {
    if (nodes.has(n.id)) {
      throw new GraphValidationError(`duplicate node id "${n.id}"`, 'duplicateId', { id: n.id });
    }
    const { id, kind, gated, done, deps, ...payload } = n;
    nodes.set(id, { id, kind, gated, done: kind === 'external' ? done : false, deps: [...new Set(deps)], payload });
  }

  for (const node of nodes.values()) {
    for (const d of node.deps) {
      if (d === node.id) {
        throw new GraphValidationError(`node "${node.id}" depends on itself`, 'selfLoop', { id: node.id });
      }
      if (!nodes.has(d)) {
        throw new GraphValidationError(
          `node "${node.id}" depends on unknown id "${d}"`,
          'unknownDependency',
          { id: node.id, dependency: d },
        );
      }
    }
  }

  const cycle = findCycle(nodes);
  if (cycle) {
    throw new GraphValidationError(`dependency cycle: ${cycle.join(' -> ')}`, 'cycle', { path: cycle });
  }

  return makeGraph(revOf(content), nodes);
}

/** `nodes.3.scope` becomes `node "T4" (nodes.3): scope` when the raw node has an id. */
function describeIssuePath(raw: unknown, issuePath: Array<string | number>): string {
  const joined = issuePath.join('.');
  const [head, index, ...rest] = issuePath;
  if (head !== 'nodes' || typeof index !== 'number') return joined;
  const nodes = (raw as { nodes?: unknown })?.nodes;
  const node = Array.isArray(nodes) ? (nodes[index] as { id?: unknown } | undefined) : undefined;
  if (typeof node?.id !== 'string') return joined;
  return `node "${node.id}" (nodes.${index})${rest.length ? `: ${rest.join('.')}` : ''}`;
}

/** DFS with colors; returns the cycle path (first id repeated at the end) or undefined. */
export function findCycle(nodes: ReadonlyMap<Id, GraphNode>): Id[] | undefined {
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const color = new Map<Id, number>();
  const stack: Id[] = [];

  const visit = (id: Id): Id[] | undefined => {
    color.set(id, GREY);
    stack.push(id);
    const node = nodes.get(id);
    if (node) {
      for (const d of node.deps) {
        const c = color.get(d) ?? WHITE;
        if (c === GREY) {
          const start = stack.indexOf(d);
          return [...stack.slice(start), d];
        }
        if (c === WHITE) {
          const found = visit(d);
          if (found) return found;
        }
      }
    }
    stack.pop();
    color.set(id, BLACK);
    return undefined;
  };

  for (const id of nodes.keys()) {
    if ((color.get(id) ?? WHITE) === WHITE) {
      const found = visit(id);
      if (found) return found;
    }
  }
  return undefined;
}

export async function loadGraphFile(path: string): Promise<Graph> {
  const content = await readFile(path, 'utf8');
  return parseGraph(content);
}
