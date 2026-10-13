/**
 * Derive tracker-bound effects from a transition. Runs inside the transition's
 * store transaction; the caller inserts the rows. See specs/tracker-sync.
 */
import type { Config } from '../config.js';
import type { Graph, GraphNode, Id } from '../graph/model.js';
import * as q from '../graph/query.js';
import type { Entry, StatusKind } from '../state/status.js';
import type { NewOutboxEffect, Store } from '../state/store.js';
import type { Actor } from '../state/transitions.js';
import {
  acceptedBody,
  blockedBody,
  doneBody,
  failedBody,
  integratedBody,
  marker,
  questionBody,
  rejectedBody,
  submittedBody,
} from './comments.js';
import { hasTrackerIdentity, trackerEnabled } from './policy.js';

export interface TransitionFacts {
  id: Id;
  node: GraphNode;
  from: StatusKind;
  to: StatusKind;
  actor: Actor;
  trigger: string;
  /** The entry after the transition. */
  entry: Entry;
  /** Sequence of the transition event. */
  seq: number;
  /** Context the tick gathered before the transition (publishedSha, summary, diffStat, closure, sha, version, note, whatWouldUnblock). */
  extra: Record<string, unknown>;
}

export interface DerivationContext {
  graph: Graph;
  store: Store;
  config: Config;
  runId: string;
  now: number;
}

export type State = 'inProgress' | 'done' | 'cancelled';

export function deriveEffects(ctx: DerivationContext, t: TransitionFacts): NewOutboxEffect[] {
  const out: NewOutboxEffect[] = [];
  if (!trackerEnabled(ctx.config, ctx.store)) return out;
  const { node, to, from, trigger, entry, extra } = t;
  if (node.kind === 'external') return out;
  const tcfg = ctx.config.tracker;
  const g = ctx.graph;

  const issueOf = (n: GraphNode): Record<string, unknown> => {
    const url = n.payload['url'];
    return { issue: n.id, ...(typeof url === 'string' && url ? { url } : {}) };
  };
  const setState = (n: GraphNode, state: State): void => {
    if (!hasTrackerIdentity(n)) return;
    if (ctx.store.lastSetState(n.id) === state) return;
    if (out.some((e) => e.kind === 'setState' && e.taskId === n.id)) return;
    out.push({ sourceSeq: t.seq, taskId: n.id, kind: 'setState', payload: { ...issueOf(n), state }, createdAt: ctx.now });
  };
  const comment = (n: GraphNode, body: string): void => {
    if (!hasTrackerIdentity(n)) return;
    out.push({ sourceSeq: t.seq, taskId: n.id, kind: 'comment', payload: { ...issueOf(n), body, marker: marker(ctx.runId, t.seq) }, createdAt: ctx.now });
  };
  const parentsOf = (n: GraphNode): GraphNode[] => [...g.nodes.values()].filter((m) => m.kind === 'milestone' && m.deps.includes(n.id));
  const gatedOver = (id: Id): GraphNode[] => [...g.nodes.values()].filter((m) => m.kind === 'milestone' && m.gated && q.closure(g, m.id).has(id));
  const closureTasks = (m: GraphNode): GraphNode[] =>
    [...q.closure(g, m.id)].map((id) => g.nodes.get(id)).filter((n): n is GraphNode => n !== undefined && n.kind === 'task');
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
  const publishedShaOf = (id: Id): string | undefined => ctx.store.listJobs({ taskId: id, status: 'published' }).at(-1)?.publishedSha;
  const summaryOf = (id: Id): string | undefined => str(ctx.store.getCompletionReport(id)?.body['summary']);

  switch (to) {
    case 'running': {
      setState(node, 'inProgress');
      if (tcfg.parentInProgress && node.kind === 'task') for (const m of parentsOf(node)) setState(m, 'inProgress');
      break;
    }
    case 'done': {
      if (node.kind === 'milestone') {
        setState(node, 'done');
        if (trigger === 'accept') {
          const sha = str(extra['sha']) ?? entry.accepted?.sha ?? entry.integrationSha ?? '';
          const version = typeof extra['version'] === 'number' ? extra['version'] : entry.accepted?.version ?? entry.reviewVersion;
          comment(node, acceptedBody({ sha, version }));
          if (tcfg.doneAt === 'milestoneAccepted' && node.gated) {
            for (const task of closureTasks(node)) {
              if (ctx.store.getEntry(task.id)?.status.kind === 'done') setState(task, 'done');
            }
          }
        }
        break;
      }
      const sha = str(extra['publishedSha']) ?? publishedShaOf(node.id);
      const summary = str(extra['summary']) ?? summaryOf(node.id);
      if (tcfg.doneAt === 'integration' || gatedOver(node.id).length === 0) {
        setState(node, 'done');
        if (tcfg.commentOnDone) comment(node, doneBody({ sha, summary }));
      } else {
        comment(node, integratedBody(sha));
      }
      break;
    }
    case 'cancelled': {
      setState(node, 'cancelled');
      break;
    }
    case 'waiting': {
      if (entry.status.kind === 'waiting') comment(node, questionBody(entry.status.question));
      break;
    }
    case 'blocked': {
      if (entry.status.kind !== 'blocked') break;
      // A question that timed out or whose process died keeps its comment.
      if (from === 'waiting') break;
      const reason = entry.status.reason;
      if (reason.kind === 'milestoneRejected') comment(node, rejectedBody(str(extra['note']) ?? reason.note ?? reason.message));
      else if (trigger === 'fallbackBlock') comment(node, questionBody(reason));
      else comment(node, blockedBody(reason, { whatWouldUnblock: str(extra['whatWouldUnblock']) }));
      break;
    }
    case 'submitted': {
      if (node.kind !== 'milestone') break;
      const sha = str(extra['integrationSha']) ?? entry.integrationSha ?? '';
      const closure = Array.isArray(extra['closure'])
        ? (extra['closure'] as Array<{ taskId: Id; publishedSha?: string; summary?: string }>)
        : closureTasks(node).map((task) => ({ taskId: task.id, publishedSha: publishedShaOf(task.id), summary: summaryOf(task.id) }));
      comment(node, submittedBody({ id: node.id, sha, version: entry.reviewVersion, diffStat: str(extra['diffStat']) ?? '', closure }));
      break;
    }
    case 'failed': {
      if (tcfg.commentOnFail && entry.status.kind === 'failed') comment(node, failedBody(entry.status.reason));
      break;
    }
    default:
      break;
  }
  return out;
}
