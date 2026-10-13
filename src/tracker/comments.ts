/**
 * Comment bodies for tracker effects. Plain text with a marker footer; the
 * drainer appends the marker as the last line. See specs/tracker-sync.
 */
import type { Id } from '../graph/model.js';
import type { BlockedReason, FailedReason, Question } from '../state/status.js';

export function marker(runId: string, sourceSeq: number): string {
  return `— orchestrator run ${runId} · event ${sourceSeq}`;
}

export function questionBody(q: Question): string {
  const lines = [`The agent working on this issue has a question (${q.kind}):`, '', q.message];
  if (q.options && q.options.length) {
    lines.push('', 'Options:');
    for (const o of q.options) lines.push(`- ${o}`);
  }
  lines.push('', 'Reply under this comment to answer.');
  return lines.join('\n');
}

export function blockedBody(reason: BlockedReason, extra: { whatWouldUnblock?: string } = {}): string {
  const lines = [`Blocked (${reason.kind}): ${reason.message}`];
  if (reason.missing && reason.missing.length) lines.push('', `Missing: ${reason.missing.join(', ')}`);
  if (extra.whatWouldUnblock) lines.push('', `What would unblock it: ${extra.whatWouldUnblock}`);
  return lines.join('\n');
}

export interface SubmittedFacts {
  id: Id;
  sha: string;
  version: number;
  diffStat: string;
  closure: Array<{ taskId: Id; publishedSha?: string; summary?: string }>;
}

export function submittedBody(m: SubmittedFacts): string {
  const lines = [`Milestone ${m.id} is ready for review, version ${m.version} at ${m.sha} (tag milestone/${m.id}/v${m.version}).`];
  if (m.diffStat.trim()) lines.push('', 'Diff stat:', m.diffStat.trim());
  if (m.closure.length) {
    lines.push('', 'Tasks:');
    for (const t of m.closure) lines.push(`- ${t.taskId}${t.publishedSha ? ` (${t.publishedSha})` : ''}${t.summary ? `: ${t.summary}` : ''}`);
  }
  return lines.join('\n');
}

export function acceptedBody(f: { sha: string; version: number }): string {
  return `Milestone accepted: version ${f.version} at ${f.sha}.`;
}

export function rejectedBody(note: string): string {
  return `Milestone rejected: ${note}`;
}

export function doneBody(f: { sha?: string; summary?: string }): string {
  return `Integrated${f.sha ? ` as ${f.sha}` : ''}${f.summary ? `: ${f.summary}` : '.'}`;
}

export function integratedBody(sha?: string): string {
  return `Integrated${sha ? ` as ${sha}` : ''}; the issue closes when its milestone is accepted.`;
}

export function failedBody(reason: FailedReason): string {
  return `Attempt failed (${reason.kind})${reason.message ? `: ${reason.message}` : ''}`;
}
