/**
 * Brief composition. Produces brief.json (machine) and brief.md (human/agent).
 * The brief is standalone: a person could perform the task from it alone.
 */
import type { BriefInput, BriefLimits, BriefRunner } from '../workspace/workspace.js';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { checkCommandPatterns } from '../runner/opencode.js';

export interface ComposeOptions {
  fallbackPath: string;
  /** Whether the repository has an `openspec/` root; absent: whether `<worktree>/openspec` exists. See specs/agent-protocol "Standalone brief". */
  openspec?: boolean;
}

/** The definition-of-done item of a brief for a repository with an `openspec/` root. */
export const OPENSPEC_CHANGE_RULE =
  '- Record any spec change as an OpenSpec change directory `openspec/changes/<name>/` named after the task (use the name the task gives, if any): `proposal.md`, `tasks.md`, and `specs/<capability>/spec.md` delta files with `## ADDED|MODIFIED|REMOVED Requirements` sections holding full `### Requirement:` blocks, validated with `openspec validate <name>`. Do not edit `openspec/specs/` directly; the operator archives the change after review.';

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
  /** The launch's runner kind, commit policy, (codex) sandbox and (opencode) permission; absent when the brief input had none. See specs/worker-runners. */
  runner?: BriefRunner;
  retryWindowMs: number;
  /** The lease TTL in force when the brief was composed; a claim response states the same value. */
  leaseTtlMs?: number;
  /** The stuck limits and the launch time budget in force when the brief was composed; absent when the brief input had none. See specs/agent-protocol "Brief states the limits in force". */
  limits?: BriefLimits;
  fallbackPath: string;
  attempt: number;
  launchNo: number;
  task: Record<string, unknown>;
  acceptanceCriteria: string[];
  dependencies: Array<{ taskId: string; summary?: string; report?: Record<string, unknown>; cancelled?: { reason: string }; external?: { done: boolean; title?: string } }>;
  context?: Record<string, unknown>;
}

/** The longest a worker may go between calls: a third of the lease TTL. */
export const renewEveryMsOf = (leaseTtlMs: number): number => Math.max(1, Math.floor(leaseTtlMs / 3));

const seconds = (ms: number): string => (ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`);

/** The brief's heartbeat interval line. See specs/agent-protocol "Heartbeat interval". */
export function leaseRule(leaseTtlMs: number): string {
  const every = renewEveryMsOf(leaseTtlMs);
  return `- Lease: your lease lasts ${seconds(leaseTtlMs)} (\`leaseTtlMs\` ${leaseTtlMs}; a claim response states it as \`lease.ttlMs\` with the expiry). Every call renews it. Call an operation (\`heartbeat\` with a short progress text will do) at least every ${seconds(every)} (\`lease.renewEveryMs\` ${every}, a third of the lease). Run any command expected to take longer than that in the background and call \`heartbeat\` while it runs: you cannot call while a foreground command runs, and a lease that expires ends your launch. An expiry keeps your commits, changes to tracked files and files you staged (\`git add\`) on your branch; a new file you have not staged is not kept.`;
}

/**
 * The brief's limits line: the stuck limits and the launch time budget in force when the brief is composed.
 * A limit of 0 is disabled and drops its part; with all three 0 there is no line. Each limit is a length of time only:
 * the line does not say how idle or elapsed time is measured. See specs/agent-protocol "Brief states the limits in force".
 */
export function limitsRule(limits: BriefLimits): string | undefined {
  const { stuckAfterMs, stuckFailAfterMs, maxLaunchMs } = limits;
  if (!stuckAfterMs && !stuckFailAfterMs && !maxLaunchMs) return undefined;
  const parts: string[] = [];
  const silence: string[] = [];
  if (stuckAfterMs > 0) silence.push(`after ${seconds(stuckAfterMs)} (\`health.stuckAfterMs\` ${stuckAfterMs}) with no progress signal your launch is flagged stuck and a \`stuck\` notice arrives in your inbox`);
  if (stuckFailAfterMs > 0) silence.push(`after ${seconds(stuckFailAfterMs)} (\`health.stuckFailAfterMs\` ${stuckFailAfterMs}) with no progress signal your launch is ended and the attempt is spent`);
  if (silence.length) {
    const s = silence.join('; ');
    parts.push(`${s[0]!.toUpperCase()}${s.slice(1)}.`);
  }
  parts.push('A progress signal is a call to an operation, a new commit, or a change in the worktree.');
  if (maxLaunchMs > 0) parts.push(`Your launch is ${silence.length ? 'also ' : ''}ended, and the attempt spent, when its time budget of ${seconds(maxLaunchMs)} (\`budgets.maxLaunchMs\` ${maxLaunchMs}) is used up, even while it makes progress.`);
  parts.push(
    maxLaunchMs > 0
      ? 'Call `heartbeat` between long steps, run a longer command in the background and call `heartbeat` while it runs, and before the budget ends report what you have, or ask a question, rather than start a step that cannot finish in the time left.'
      : 'Call `heartbeat` between long steps, and run a longer command in the background and call `heartbeat` while it runs.',
  );
  parts.push('These numbers are the ones in force when this brief was written; the operator can change them during the run, and a change arrives as a `nudge` notice in your inbox.');
  return `- Limits: ${parts.join(' ')}`;
}

const limitsLines = (limits: BriefLimits | undefined): string[] => {
  const line = limits ? limitsRule(limits) : undefined;
  return line ? [line] : [];
};

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
    ...(input.leaseTtlMs ? { leaseTtlMs: input.leaseTtlMs } : {}),
    ...(input.limits ? { limits: { ...input.limits } } : {}),
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
    // Workers that edited openspec/specs directly lost the per-change record and collided on the main spec files (ORC-74).
    ...((opts.openspec ?? existsSync(path.join(launch.worktree, 'openspec'))) ? [OPENSPEC_CHANGE_RULE] : []),
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
  // The derived ruleset denies what it does not allow; a denied call returns an error and the run goes on. See specs/agent-protocol "Check command and tool rules in the brief".
  if (kind === 'opencode') {
    const permission = input.runner?.permission;
    const patterns = [...new Set([...(permission?.bashPatterns?.length ? permission.bashPatterns : ['git *']), ...checkCommandPatterns(input.checkCommand)])];
    lines.push(
      "- You run with OpenCode permission rules in force and nothing else confining your commands: a command a rule does not allow fails with 'The user has specified a rule which prevents you from using this specific tool call.' and will not be approved at runtime. Do not retry it; ask with a `needsAccess` question naming the command, then continue with what you can. The operator can run it for you, or set `runner.opencode.permission` to `allow` for your next launch.",
      permission?.mode === 'allow'
        ? '- If the orchestrator spawned you, the rules allow every command and every tool. A worker holding a claimed launch runs under its own permissions instead.'
        : `- If the orchestrator spawned you, the rules allow the file tools (read, glob, grep, list, edit, write), the orchestrator tools, and these bash commands: ${patterns.map((p) => `\`${p}\``).join(', ')}; every other command is denied, and each command of a chain (\`&&\`, \`;\`, \`|\`) must match one of them on its own. A worker holding a claimed launch runs under its own permissions instead.`,
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
    if (c['priorFailure']) {
      lines.push(`- Previous attempt failed: ${JSON.stringify(c['priorFailure'])}`);
      const rf = (c['priorFailure'] as { detail?: { runnerFailure?: { reason?: unknown; detail?: unknown } } }).detail?.runnerFailure;
      if (rf && typeof rf.reason === 'string') {
        lines.push(`- The runner's diagnosis of the previous launch: \`${rf.reason}\`${typeof rf.detail === 'string' && rf.detail ? `: ${rf.detail}` : ''}. Fix or avoid that cause rather than retrying the same way; if it is outside the worktree (model, login, MCP setup, ${kind === 'opencode' ? 'permission rules' : 'sandbox'}), ask with a question.`);
      }
    }
    if (c['verifierOutput']) lines.push('- Verifier output:', '', '```', String(c['verifierOutput']).slice(0, 8000), '```');
    if (c['conflict']) {
      const k = c['conflict'] as { files?: string[]; since?: string[]; previousBranch?: string };
      // A branch lost with a previous clone is not named. See specs/crash-recovery "Context naming lost work".
      lines.push(
        k.previousBranch
          ? `- Your previous branch \`${k.previousBranch}\` conflicted on rebase in: ${(k.files ?? []).join(', ')}. Tasks published since your base: ${(k.since ?? []).join(', ') || 'none'}. ${
              daemonCommits
                ? 'Inspect that branch with `git show`/`git diff` and reapply its changes as file edits on the new base, or start over.'
                : 'Rebase that branch or start over from the new base.'
            }`
          : `- Your previous branch conflicted on rebase in: ${(k.files ?? []).join(', ')}. Tasks published since your base: ${(k.since ?? []).join(', ') || 'none'}. That branch was lost with the orchestrator's previous clone; start over from the new base.`,
      );
    }
    if (c['lostWork']) {
      const k = c['lostWork'] as import('../state/status.js').LostWorkContext;
      lines.push(
        `- Your previous launch \`${k.priorLaunchId}\` was interrupted (${k.reason}) and its work was kept on its branch, but that branch was lost with the orchestrator's previous clone and nothing of it remains. Start from your base commit.`,
      );
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
    // A prior branch lost with a previous clone is not named. See specs/crash-recovery "Context naming lost work".
    const where = revision.priorBranch ? `worked on branch \`${revision.priorBranch}\`` : "worked on a branch that was lost with the orchestrator's previous clone";
    lines.push(
      `- Your prior launch \`${revision.priorLaunchId}\` ${where}${
        revision.priorPublishedSha
          ? ` and published commit \`${revision.priorPublishedSha}\`, which remains on \`${input.integrationBranch}\` and is contained in your base commit \`${launch.baseSha}\``
          : ' and did not publish'
      }.`,
    );
    if (revision.priorReportSummary) lines.push(`- Prior report: ${revision.priorReportSummary}`);
    lines.push(
      daemonCommits
        ? revision.priorBranch
          ? '- Revise the prior work rather than redoing it: build on what the base commit already contains, inspect the prior branch with `git show`/`git diff` and reapply changes as file edits, and leave the delta in the worktree for the orchestrator to commit.'
          : '- Revise the prior work rather than redoing it: build on what the base commit already contains, and leave the delta in the worktree for the orchestrator to commit.'
        : '- Revise the prior work rather than redoing it: build on what the base commit already contains, and commit the delta.',
      '',
    );
  }
  lines.push('## Reporting', '');
  // A Codex sandbox refuses network access to commands, so the API is reachable only through the MCP server, which Codex runs outside the sandbox.
  if (kind === 'codex')
    lines.push(
      '- Call these operations through the `orchestrator` MCP server\'s tools (`heartbeat`, `report`, `block`, `inbox`, `log`). Do not call the API from a command (curl, a script): the sandbox blocks its network access. Use the fallback file below only when an MCP tool call itself fails.',
    );
  // No sandbox stands between an OpenCode agent and loopback, so the API stays usable; the tools are still preferred.
  if (kind === 'opencode')
    lines.push(
      "- Call these operations through the `orchestrator` MCP server's tools, which you see as `orchestrator_heartbeat`, `orchestrator_report`, `orchestrator_block`, `orchestrator_inbox` and `orchestrator_log`. Prefer them to calling the API below from a command; use the fallback file only when both fail.",
    );
  lines.push(
    `- API: \`${input.apiBaseUrl}/v1/launches/${launch.launchId}/...\` with header \`Authorization: Bearer <token from brief.json>\`.`,
    '- Operations: heartbeat, report (kind submit|fail, with seq), block (a question; waits for the answer), inbox, log.',
    // The interval rule. See specs/agent-protocol "Heartbeat interval".
    ...(input.leaseTtlMs ? [leaseRule(input.leaseTtlMs)] : []),
    // The stuck limits and the time budget. See specs/agent-protocol "Brief states the limits in force".
    ...limitsLines(input.limits),
    `- If the API fails for more than ${Math.round(input.retryWindowMs / 1000)}s, write your report to \`${opts.fallbackPath}\` and exit.`,
    '- If any call returns 401, stop immediately: your launch has been revoked.',
    '',
  );
  return { markdown: lines.join('\n'), json };
}
