/**
 * An in-memory tracker and a drainer that does what the run skill does with the
 * session's tracker tools: list the outbox, map states by type, check markers
 * before posting, ack with the vendor id, nack with the error, and relay human
 * comments under a question as the answer. See specs/tracker-sync "Drainer contract".
 */
import type { OutboxEffect } from '../../src/state/store.js';

export type StateType = 'unstarted' | 'started' | 'completed' | 'canceled';

export interface FakeComment {
  id: string;
  body: string;
  author: 'bot' | 'human';
  createdAt: number;
}

export interface FakeIssue {
  id: string;
  stateType: StateType;
  history: StateType[];
  comments: FakeComment[];
}

const MARKER = '— orchestrator run ';

export class FakeTracker {
  readonly issues = new Map<string, FakeIssue>();
  /** Issue id -> error text: setState on that issue is rejected until cleared. */
  readonly rejectState = new Map<string, string>();
  hasCanceledType = true;
  private nextComment = 1;
  private clock = 1;

  issue(id: string): FakeIssue {
    let i = this.issues.get(id);
    if (!i) {
      i = { id, stateType: 'unstarted', history: [], comments: [] };
      this.issues.set(id, i);
    }
    return i;
  }

  setState(id: string, state: string): { stateId: string } {
    const err = this.rejectState.get(id);
    if (err) throw new Error(err);
    const type: StateType = state === 'inProgress' ? 'started' : state === 'done' ? 'completed' : 'canceled';
    if (type === 'canceled' && !this.hasCanceledType) throw new Error('workflow has no canceled-type state');
    const i = this.issue(id);
    i.stateType = type;
    i.history.push(type);
    return { stateId: `state-${type}` };
  }

  postComment(id: string, body: string, author: 'bot' | 'human' = 'bot'): { commentId: string } {
    const i = this.issue(id);
    const c: FakeComment = { id: `c${this.nextComment++}`, body, author, createdAt: this.clock++ };
    i.comments.push(c);
    return { commentId: c.id };
  }

  humanComment(id: string, body: string): string {
    return this.postComment(id, body, 'human').commentId;
  }

  states(id: string): StateType[] {
    return [...this.issue(id).history];
  }

  /** Bot comment bodies without their marker line. */
  comments(id: string): string[] {
    return this.issue(id).comments.filter((c) => c.author === 'bot').map((c) => c.body.replace(/\n\n— orchestrator run .*$/s, ''));
  }
}

export function isMarked(body: string): boolean {
  return body.includes(MARKER);
}

async function http(base: string, method: 'GET' | 'POST', route: string, body?: Record<string, unknown>) {
  const res = await fetch(`${base}${route}`, { method, headers: { 'content-type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

export interface DrainReport {
  applied: number[];
  rejected: Array<{ id: number; error: string }>;
  skipped: number[];
}

/** One drain pass over the pending outbox, exactly as the run skill would do it. */
export async function drainOnce(base: string, tracker: FakeTracker): Promise<DrainReport> {
  const list = await http(base, 'GET', '/v1/outbox?limit=200');
  const effects = (list.body['effects'] ?? []) as OutboxEffect[];
  const report: DrainReport = { applied: [], rejected: [], skipped: [] };
  const errored = new Set<string>();
  for (const e of effects) {
    const issue = String(e.payload['issue'] ?? e.taskId);
    if (errored.has(issue)) {
      report.skipped.push(e.id);
      continue;
    }
    try {
      let result: Record<string, unknown>;
      if (e.kind === 'setState') {
        const state = String(e.payload['state']);
        if (state === 'cancelled' && !tracker.hasCanceledType) {
          result = { ...tracker.postComment(issue, `Cancelled by the orchestrator.\n\n${String(e.payload['marker'] ?? '')}`), stateLeft: true };
        } else {
          result = tracker.setState(issue, state);
        }
      } else {
        const marker = String(e.payload['marker']);
        const existing = tracker.issue(issue).comments.find((c) => c.body.includes(marker));
        result = existing ? { commentId: existing.id, found: true } : tracker.postComment(issue, `${String(e.payload['body'])}\n\n${marker}`);
      }
      await http(base, 'POST', `/v1/outbox/${e.id}/ack`, { result });
      report.applied.push(e.id);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await http(base, 'POST', `/v1/outbox/${e.id}/nack`, { error });
      report.rejected.push({ id: e.id, error });
      errored.add(issue);
    }
  }
  return report;
}

/** Relay the first new human comment after the latest marked comment for every open question. */
export async function relayOnce(base: string, tracker: FakeTracker, relayed: Set<string>): Promise<Array<{ task: string; commentId: string; status: number; body: Record<string, unknown> }>> {
  const status = await http(base, 'GET', '/v1/status');
  const out: Array<{ task: string; commentId: string; status: number; body: Record<string, unknown> }> = [];
  for (const task of (status.body['openQuestions'] ?? []) as string[]) {
    const comments = tracker.issue(task).comments;
    let lastMarked = -1;
    comments.forEach((c, i) => {
      if (isMarked(c.body)) lastMarked = i;
    });
    const candidate = comments.slice(lastMarked + 1).find((c) => !isMarked(c.body) && !relayed.has(c.id));
    if (!candidate) continue;
    const r = await http(base, 'POST', `/v1/tasks/${task}/answer`, { text: candidate.body });
    relayed.add(candidate.id);
    out.push({ task, commentId: candidate.id, status: r.status, body: r.body });
  }
  return out;
}
