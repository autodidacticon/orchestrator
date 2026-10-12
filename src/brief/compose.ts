/**
 * Brief composition. Produces brief.json (machine) and brief.md (human/agent).
 * The brief is standalone: a person could perform the task from it alone.
 */
import type { BriefInput } from '../workspace/workspace.js';

export interface ComposeOptions {
  fallbackPath: string;
}

export interface BriefJson {
  launchId: string;
  taskId: string;
  token: string;
  apiBaseUrl: string;
  worktree: string;
  branch: string;
  baseSha: string;
  graphRev: string;
  integrationBranch: string;
  checkCommand: string;
  retryWindowMs: number;
  fallbackPath: string;
  attempt: number;
  launchNo: number;
  task: Record<string, unknown>;
  acceptanceCriteria: string[];
  dependencies: Array<{ taskId: string; summary?: string; report?: Record<string, unknown>; cancelled?: { reason: string } }>;
  context?: Record<string, unknown>;
}

export function acceptanceCriteriaOf(payload: Record<string, unknown>): string[] {
  const raw = payload['acceptanceCriteria'];
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string' && raw.trim()) return raw.split('\n').map((s) => s.replace(/^[-*]\s*/, '').trim()).filter(Boolean);
  return [];
}

export function composeBrief(input: BriefInput, opts: ComposeOptions): { markdown: string; json: BriefJson } {
  const { launch, node } = input;
  const criteria = acceptanceCriteriaOf(node.payload);
  const json: BriefJson = {
    launchId: launch.launchId,
    taskId: node.id,
    token: launch.token,
    apiBaseUrl: input.apiBaseUrl,
    worktree: launch.worktree,
    branch: launch.branch,
    baseSha: launch.baseSha,
    graphRev: launch.graphRev,
    integrationBranch: input.integrationBranch,
    checkCommand: input.checkCommand,
    retryWindowMs: input.retryWindowMs,
    fallbackPath: opts.fallbackPath,
    attempt: launch.attempt,
    launchNo: launch.launchNo,
    task: node.payload,
    acceptanceCriteria: criteria,
    dependencies: input.depReports.map((d) => ({
      taskId: d.taskId,
      summary: d.report ? String(d.report.body['summary'] ?? '') : undefined,
      report: d.report?.body,
      cancelled: d.cancelled,
    })),
    context: input.carry,
  };

  const title = String(node.payload['title'] ?? node.id);
  const description = String(node.payload['description'] ?? '');
  const lines: string[] = [];
  lines.push(`# Task ${node.id}: ${title}`, '');
  if (description) lines.push(description, '');
  lines.push('## Acceptance criteria', '');
  if (criteria.length) for (const c of criteria) lines.push(`- ${c}`);
  else lines.push('- (none declared)');
  lines.push('', '## Definition of done', '');
  lines.push(
    `- Commit all work on branch \`${launch.branch}\` in this worktree. Uncommitted or untracked files make your submission be rejected with 409 and the file list; commit and resubmit.`,
    `- Never merge, rebase onto, or touch \`${input.integrationBranch}\`. The orchestrator integrates your branch after verification.`,
    `- Run the check command before submitting: \`${input.checkCommand}\`.`,
    '- If the task needs no changes, say so explicitly with `noChanges: { justification }` in your report.',
    '- Your report must give evidence for every acceptance criterion above.',
    '- Terminate as soon as your report is accepted.',
    '',
  );
  lines.push('## Workspace', '');
  lines.push(`- Worktree: \`${launch.worktree}\``, `- Branch: \`${launch.branch}\``, `- Base commit: \`${launch.baseSha}\``, `- Integration branch: \`${input.integrationBranch}\``, '');
  lines.push('## Dependencies', '');
  if (!input.depReports.length) lines.push('- none');
  for (const d of input.depReports) {
    if (d.cancelled) {
      lines.push(`- **${d.taskId}** was cancelled: ${d.cancelled.reason}. Its work does not exist; plan accordingly.`);
    } else if (d.report) {
      const b = d.report.body;
      lines.push(`- **${d.taskId}**: ${String(b['summary'] ?? '')}`);
      for (const key of ['interfaces', 'decisions', 'deviations'] as const) {
        const arr = b[key];
        if (Array.isArray(arr) && arr.length) lines.push(`  - ${key}: ${arr.map(String).join('; ')}`);
      }
    } else {
      lines.push(`- **${d.taskId}**: no completion report available; see \`git log ${input.integrationBranch}\`.`);
    }
  }
  lines.push('');
  if (input.carry && Object.keys(input.carry).length) {
    lines.push('## Context from previous attempts', '');
    const c = input.carry as Record<string, unknown>;
    if (c['priorFailure']) lines.push(`- Previous attempt failed: ${JSON.stringify(c['priorFailure'])}`);
    if (c['verifierOutput']) lines.push('- Verifier output:', '', '```', String(c['verifierOutput']).slice(0, 8000), '```');
    if (c['conflict']) {
      const k = c['conflict'] as { files?: string[]; since?: string[]; previousBranch?: string };
      lines.push(`- Your previous branch \`${k.previousBranch ?? ''}\` conflicted on rebase in: ${(k.files ?? []).join(', ')}. Tasks published since your base: ${(k.since ?? []).join(', ') || 'none'}. Rebase that branch or start over from the new base.`);
    }
    if (c['question'] || c['answer']) lines.push(`- Question asked earlier: ${JSON.stringify(c['question'])}`, `- Human answer: ${String(c['answer'] ?? '')}`);
    lines.push('');
  }
  lines.push('## Reporting', '');
  lines.push(
    `- API: \`${input.apiBaseUrl}/v1/launches/${launch.launchId}/...\` with header \`Authorization: Bearer <token from brief.json>\`.`,
    '- Operations: heartbeat, report (kind submit|fail, with seq), block (a question; waits for the answer), inbox, log.',
    `- If the API fails for more than ${Math.round(input.retryWindowMs / 1000)}s, write your report to \`${opts.fallbackPath}\` and exit.`,
    '- If any call returns 401, stop immediately: your launch has been revoked.',
    '',
  );
  return { markdown: lines.join('\n'), json };
}
