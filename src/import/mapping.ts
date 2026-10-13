/**
 * Tracker-to-graph mapping. See specs/graph-import. Deterministic: normalized
 * issue records in, a validated graph file out.
 */
import { stringify as toYaml } from 'yaml';
import { z } from 'zod';
import { GraphValidationError, parseGraph } from '../graph/load.js';

export const issueStateSchema = z.enum(['open', 'inProgress', 'done', 'cancelled']);

export const issueRecordSchema = z.object({
  id: z.string().min(1),
  title: z.string().default(''),
  description: z.string().optional(),
  state: issueStateSchema,
  blockedBy: z.array(z.string().min(1)).default([]),
  parent: z.string().optional(),
  labels: z.array(z.string()).optional(),
  priority: z.union([z.string(), z.number()]).optional(),
  url: z.string().optional(),
});

export type IssueRecord = z.infer<typeof issueRecordSchema>;

export const importOptionsSchema = z.object({
  criteriaHeading: z.string().min(1).default('Acceptance criteria'),
  /** Heading whose items become the task's `scope` globs. See specs/graph-import "Scope from the description". */
  scopeHeading: z.string().min(1).default('Scope'),
  inProgress: z.enum(['external', 'task']).default('external'),
  gated: z.boolean().default(true),
});

/** The tracker an import came from; recorded by the daemon so effects can be derived. See specs/graph-import "Tracker record". */
export const trackerSchema = z.object({
  kind: z.enum(['linear', 'atlassian']),
  workspace: z.string().min(1).optional(),
});

export type TrackerInput = z.infer<typeof trackerSchema>;

export const importInputSchema = z.object({
  root: z.string().min(1),
  issues: z.array(issueRecordSchema),
  options: importOptionsSchema.default({}),
  /** Passed through to the daemon's import route; the mapping ignores it. */
  tracker: trackerSchema.optional(),
});

export type ImportInput = z.infer<typeof importInputSchema>;

export interface GraphFileNode {
  id: string;
  kind?: 'task' | 'milestone' | 'external';
  gated?: boolean;
  done?: boolean;
  deps: string[];
  [payload: string]: unknown;
}

export interface ImportSummary {
  tasks: number;
  external: number;
  milestones: number;
  missingCriteria: string[];
  unknownExternal: string[];
  inProgressAsExternal: string[];
}

export class ImportError extends Error {
  constructor(
    message: string,
    public readonly details: unknown = undefined,
  ) {
    super(message);
    this.name = 'ImportError';
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const anyHeading = /^\s*#{1,6}\s+\S/;
const item = /^\s*(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)(.*\S)\s*$/;

function headingPattern(heading: string): RegExp {
  return new RegExp(`^\\s*(?:#{1,6}\\s*|\\*\\*)?${escapeRegExp(heading)}(?:\\*\\*)?\\s*:?\\s*$`, 'i');
}

/**
 * Split a description at every configured heading in one pass. `description`
 * is the text before the first of them; each section is the list items under
 * its heading up to the next heading, configured or markdown. A section whose
 * heading is absent is undefined.
 */
export function splitSections<K extends string>(text: string | undefined, headings: Record<K, string>): { description: string; sections: Partial<Record<K, string[]>> } {
  const sections: Partial<Record<K, string[]>> = {};
  if (!text) return { description: '', sections };
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const patterns = Object.entries(headings).map(([key, heading]) => ({ key: key as K, re: headingPattern(heading as string) }));
  const starts = patterns
    .map(({ key, re }) => ({ key, idx: lines.findIndex((l) => re.test(l)) }))
    .filter(({ idx }) => idx >= 0);
  if (starts.length === 0) return { description: text.trim(), sections };
  const first = Math.min(...starts.map((s) => s.idx));
  const isHeading = (l: string) => anyHeading.test(l) || patterns.some(({ re }) => re.test(l));
  for (const { key, idx } of starts) {
    const items: string[] = [];
    for (let i = idx + 1; i < lines.length; i++) {
      const l = lines[i] as string;
      if (isHeading(l)) break;
      const m = item.exec(l);
      if (m) items.push((m[1] as string).trim());
    }
    sections[key] = items;
  }
  return { description: lines.slice(0, first).join('\n').trim(), sections };
}

/** Split a description at the acceptance-criteria heading and the scope heading, in whichever order they appear. */
export function splitDescription(text: string | undefined, heading = 'Acceptance criteria', scopeHeading = 'Scope'): { description: string; acceptanceCriteria: string[]; scope?: string[] } {
  const { description, sections } = splitSections(text, { criteria: heading, scope: scopeHeading });
  return { description, acceptanceCriteria: sections.criteria ?? [], ...(sections.scope?.length ? { scope: sections.scope } : {}) };
}

/** Map normalized issues to graph file nodes. Throws ImportError on malformed input or an invalid graph. */
export function mapIssues(raw: unknown): { nodes: GraphFileNode[]; content: string; summary: ImportSummary; rev: string } {
  const parsed = importInputSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ImportError(`malformed import input at ${first?.path.join('.') || 'root'}: ${first?.message}`, parsed.error.issues);
  }
  const { root, issues, options } = parsed.data;
  const byId = new Map(issues.map((i) => [i.id, i]));
  const children = issues.filter((i) => i.parent === root && i.id !== root);
  if (children.length === 0) throw new ImportError(`root ${root} has no children (records with parent: ${root})`);
  const childIds = new Set(children.map((c) => c.id));

  const nodes: GraphFileNode[] = [];
  const summary: ImportSummary = { tasks: 0, external: 0, milestones: 0, missingCriteria: [], unknownExternal: [], inProgressAsExternal: [] };
  const externalIds = new Set<string>();

  const payloadOf = (i: IssueRecord) => {
    const { description, acceptanceCriteria, scope } = splitDescription(i.description, options.criteriaHeading, options.scopeHeading);
    return {
      title: i.title,
      description,
      acceptanceCriteria,
      ...(scope ? { scope } : {}),
      ...(i.labels ? { labels: i.labels } : {}),
      // Linear's 0 means no priority; every other value passes through unchanged. See specs/graph-import "Priority normalisation".
      ...(i.priority !== undefined && i.priority !== 0 ? { priority: i.priority } : {}),
      ...(i.url ? { url: i.url } : {}),
      trackerState: i.state,
    };
  };

  const addExternal = (id: string, cause: 'outside' | 'state') => {
    if (externalIds.has(id)) return;
    externalIds.add(id);
    const rec = byId.get(id);
    if (!rec) {
      summary.unknownExternal.push(id);
      nodes.push({ id, kind: 'external', done: false, deps: [], title: id, trackerState: 'unknown', unknown: true });
    } else {
      nodes.push({ id, kind: 'external', done: rec.state === 'done', deps: [], ...payloadOf(rec), externalCause: cause });
    }
    summary.external++;
  };

  for (const c of children) {
    const isTask = c.state === 'open' || (c.state === 'inProgress' && options.inProgress === 'task');
    if (!isTask) {
      if (c.state === 'inProgress') summary.inProgressAsExternal.push(c.id);
      addExternal(c.id, 'state');
      continue;
    }
    const payload = payloadOf(c);
    if (payload.acceptanceCriteria.length === 0) summary.missingCriteria.push(c.id);
    const deps = [...new Set(c.blockedBy.filter((b) => b !== c.id))];
    for (const d of deps) if (!childIds.has(d)) addExternal(d, 'outside');
    nodes.push({ id: c.id, kind: 'task', deps, ...payload });
    summary.tasks++;
  }

  const rootRec = byId.get(root);
  const rootDeps = [...childIds];
  if (rootRec) {
    for (const b of rootRec.blockedBy) {
      if (childIds.has(b) || b === root) continue;
      addExternal(b, 'outside');
      rootDeps.push(b);
    }
  }
  // The root's description and acceptance criteria ride on the milestone so the review bundle can show them.
  const rootText = rootRec?.description ? splitDescription(rootRec.description, options.criteriaHeading, options.scopeHeading) : undefined;
  nodes.push({
    id: root,
    kind: 'milestone',
    gated: options.gated,
    deps: rootDeps,
    title: rootRec?.title ?? root,
    ...(rootText ? { description: rootText.description, acceptanceCriteria: rootText.acceptanceCriteria } : {}),
    ...(rootRec?.url ? { url: rootRec.url } : {}),
    trackerState: rootRec?.state ?? 'unknown',
  });
  summary.milestones = 1;

  const ordered = [...nodes.filter((n) => n.kind === 'external'), ...nodes.filter((n) => n.kind === 'task'), ...nodes.filter((n) => n.kind === 'milestone')];
  const content = toYaml({ nodes: ordered });
  let rev: string;
  try {
    rev = parseGraph(content).rev;
  } catch (err) {
    if (err instanceof GraphValidationError) throw new ImportError(`mapped graph is invalid: ${err.message}`, err.details);
    throw err;
  }
  return { nodes: ordered, content, summary, rev };
}
