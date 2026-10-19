# Task T1: Golden

Do the golden task.

## Acceptance criteria

1. it works

## Definition of done

- Commit all work on branch `task/T1/l1` in this worktree. Uncommitted or untracked files make your submission be rejected with 409 and the file list; commit and resubmit.
- Never merge into, push to, or check out `main`. You may rebase your launch branch onto it when a baseMoved notice says it advanced; the orchestrator integrates your branch after verification.
- Run the check command before submitting: `npm test`.
- If the task needs no changes, say so explicitly with `noChanges: { justification }` in your report.
- Your report must give evidence for every acceptance criterion above: one `acceptance` entry per criterion, whose `criterion` quotes the criterion text (markdown and case do not matter) or gives its number.
- Terminate as soon as your report is accepted.

## Workspace

- Worktree: `/w`
- Branch: `task/T1/l1`
- Base commit: `base1`
- Integration branch: `main`
- You run with OpenCode permission rules in force and nothing else confining your commands: a command a rule does not allow fails with 'The user has specified a rule which prevents you from using this specific tool call.' and will not be approved at runtime. Do not retry it; ask with a `needsAccess` question naming the command, then continue with what you can. The operator can run it for you, or set `runner.opencode.permission` to `allow` for your next launch.
- If the orchestrator spawned you, the rules allow the file tools (read, glob, grep, list, edit, write), the orchestrator tools, and these bash commands: `npm test *`, `git status`, `npm test`; every other command is denied, and each command of a chain (`&&`, `;`, `|`) must match one of them on its own. A worker holding a claimed launch runs under its own permissions instead.
- Notices may arrive in your inbox (the `inbox` operation): `stuck` when no progress has been observed for a while, `nudge` with a message from the operator, `baseMoved` with the new integration `head` and the `files` that changed, and `payloadChanged` when your task's description was edited (re-read the brief file). Check the inbox after long steps.

## Dependencies

- none

## Reporting

- Call these operations through the `orchestrator` MCP server's tools, which you see as `orchestrator_heartbeat`, `orchestrator_report`, `orchestrator_block`, `orchestrator_inbox` and `orchestrator_log`. Prefer them to calling the API below from a command; use the fallback file only when both fail.
- API: `http://127.0.0.1:1/v1/launches/L1/...` with header `Authorization: Bearer <token from brief.json>`.
- Operations: heartbeat, report (kind submit|fail, with seq), block (a question; waits for the answer), inbox, log.
- If the API fails for more than 120s, write your report to `/w/.orchestrator/report.json` and exit.
- If any call returns 401, stop immediately: your launch has been revoked.
