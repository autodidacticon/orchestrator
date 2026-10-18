/**
 * Brief composition. Produces brief.json (machine) and brief.md (human/agent).
 * The brief is standalone: a person could perform the task from it alone.
 */
import type { BriefInput } from '../workspace/workspace.js';
import type { CodexSandbox, CommitPolicy, RunnerKind } from '../runner/selection.js';

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
  checkCommand?: string;
  allowedTools?: string[];
  /** The launch's runner kind, commit policy and (codex) sandbox; absent when the brief input had none. See specs/worker-runners. */
  runner?: { kind: RunnerKind; commitPolicy?: CommitPolicy; sandbox?: CodexSandbox };
  retryWindowMs: number;
  fallbackPath: string;
  attempt: number;
  launchNo: number;
  task: Record<string, unknown>;
  acceptanceCriteria: string[];
  dependencies: Array<{ taskId: string; summary?: string; report?: Record<string, unknown>; cancelled?: { reason: string }; external?: { done: boolean; title?: string } }>;
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
    allowedTools: input.allowedTools,
    ...(input.runner ? { runner: input.runner } : {}),
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
      external: d.external,
    })),
    context: input.carry,
  };

  const title = String(node.payload['title'] ?? node.id);
  const description = String(node.payload['description'] ?? '');
  // Without a runner the brief is the Claude Code text under the `agent` commit policy. See specs/worker-runners "Sandbox and commit policy".
  const kind = input.runner?.kind ?? 'claude-code';
  const daemonCommits = input.runner?.commitPolicy === 'daemon';
  const lines: string[] = [];
  lines.push(`# Task ${node.id}: ${title}`, '');
  if (description) lines.push(description, '');
  lines.push('## Acceptance criteria', '');
  if (criteria.length) criteria.forEach((c, i) => lines.push(`${i + 1}. ${c}`));
  else lines.push('- (none declared)');
  lines.push('', '## Definition of done', '');
  lines.push(
    ...(daemonCommits
      ? [
          `- Leave your changes in this worktree on branch \`${launch.branch}\`, committed or not; the orchestrator commits what is uncommitted when it accepts your report.`,
          `- Never merge into, push to, or check out \`${input.integrationBranch}\`. The orchestrator rebases your branch onto the integration head at verification and integrates it after verification.`,
        ]
      : [
          `- Commit all work on branch \`${launch.branch}\` in this worktree. Uncommitted or untracked files make your submission be rejected with 409 and the file list; commit and resubmit.`,
          `- Never merge into, push to, or check out \`${input.integrationBranch}\`. You may rebase your launch branch onto it when a baseMoved notice says it advanced; the orchestrator integrates your branch after verification.`,
        ]),
    input.checkCommand
      ? `- Run the check command before submitting: \`${input.checkCommand}\`.`
      : '- No check command is configured for this repository yet; the operator is being asked. Run the project\'s documented test suite before submitting.',
    '- If the task needs no changes, say so explicitly with `noChanges: { justification }` in your report.',
    '- Your report must give evidence for every acceptance criterion above: one `acceptance` entry per criterion, whose `criterion` quotes the criterion text (markdown and case do not matter) or gives its number.',
    '- Terminate as soon as your report is accepted.',
    '',
  );
  lines.push('## Workspace', '');
  lines.push(`- Worktree: \`${launch.worktree}\``, `- Branch: \`${launch.branch}\``, `- Base commit: \`${launch.baseSha}\``, `- Integration branch: \`${input.integrationBranch}\``);
  if (kind === 'claude-code' && input.allowedTools?.length) {
    const bash = input.allowedTools.filter((r) => r.startsWith('Bash('));
    lines.push(
      `- If the orchestrator spawned you, these Bash rules are in force: ${bash.map((r) => `\`${r}\``).join(', ')}. A worker holding a claimed launch runs under its own permissions instead.`,
      '- Run commands from the worktree root without `cd`: every part of a compound command must match a rule on its own. When you need a command these rules do not cover, ask with a `needsAccess` question naming the command rather than retrying it.',
    );
  }
  if (kind === 'codex') {
    const sandbox = input.runner?.sandbox ? `the Codex sandbox \`${input.runner.sandbox}\`` : 'the Codex sandbox';
    lines.push(
      `- You run under ${sandbox} with approvals disabled: a command the sandbox refuses fails with 'Operation not permitted' and will not be approved at runtime. Do not retry it; ask with a \`needsAccess\` question naming the command. The operator can run it for you, or change \`runner.codex.sandbox\` for your next launch.`,
    );
  }
  lines.push(
    '- Notices may arrive in your inbox (the `inbox` operation): `stuck` when no progress has been observed for a while, `nudge` with a message from the operator, `baseMoved` with the new integration `head` and the `files` that changed, and `payloadChanged` when your task\'s description was edited (re-read the brief file). Check the inbox after long steps.',
    '',
  );
  lines.push('## Dependencies', '');
  if (!input.depReports.length) lines.push('- none');
  for (const d of input.depReports) {
    if (d.external) {
      lines.push(`- **${d.taskId}**${d.external.title ? ` (${d.external.title})` : ''} is outside this run and is ${d.external.done ? 'done' : 'not done'}. Its work was not produced by an agent here; look at the repository for what it delivered.`);
    } else if (d.cancelled) {
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
      lines.push(`- Your previous branch \`${k.previousBranch ?? ''}\` conflicted on rebase in: ${(k.files ?? []).join(', ')}. Tasks published since your base: ${(k.since ?? []).join(', ') || 'none'}. ${
          daemonCommits
            ? 'Inspect that branch with `git show`/`git diff` and reapply its changes as file edits on the new base, or start over.'
            : 'Rebase that branch or start over from the new base.'
        }`);
    }
    if (c['interrupted']) {
      const k = c['interrupted'] as import('../state/status.js').InterruptedContext;
      lines.push(
        `- Your previous launch \`${k.priorLaunchId}\` was interrupted (${k.reason}); this is interruption ${k.interruptions} for this task. Its branch \`${k.priorBranch}\` holds the work so far at \`${k.headSha}\`${
          k.wipCommit ? `, and commit \`${k.wipCommit}\` is a work-in-progress commit of changes it had not committed` : ''
        }. ${
          daemonCommits
            ? 'Continue from that branch by inspecting it with `git show`/`git diff` and reapplying its changes as file edits, or start over.'
            : `Continue from that branch by merging or cherry-picking it onto your base, or inspect it and start over${k.wipCommit ? '; squash the work-in-progress commit before submitting' : ''}.`
        }`,
      );
    }
    if (c['question'] || c['answer']) lines.push(`- Question asked earlier: ${JSON.stringify(c['question'])}`, `- Human answer: ${String(c['answer'] ?? '')}`);
    lines.push('');
  }
  const revision = input.carry?.['revision'] as import('../state/status.js').RevisionContext | undefined;
  if (revision) {
    lines.push('## Revision', '');
    lines.push(
      revision.cause === 'upstreamReopened'
        ? `- This task is being revised because its upstream task \`${revision.upstream ?? ''}\` was reopened and its work may change.`
        : '- This task was reopened for revision.',
    );
    lines.push(
      `- Your prior launch \`${revision.priorLaunchId}\` worked on branch \`${revision.priorBranch}\`${
        revision.priorPublishedSha
          ? ` and published commit \`${revision.priorPublishedSha}\`, which remains on \`${input.integrationBranch}\` and is contained in your base commit \`${launch.baseSha}\``
          : ' and did not publish'
      }.`,
    );
    if (revision.priorReportSummary) lines.push(`- Prior report: ${revision.priorReportSummary}`);
    lines.push(
      daemonCommits
        ? '- Revise the prior work rather than redoing it: build on what the base commit already contains, inspect the prior branch with `git show`/`git diff` and reapply changes as file edits, and leave the delta in the worktree for the orchestrator to commit.'
        : '- Revise the prior work rather than redoing it: build on what the base commit already contains, and commit the delta.',
      '',
    );
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
