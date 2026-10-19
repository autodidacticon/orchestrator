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
- If the orchestrator spawned you, these Bash rules are in force: `Bash(git:*)`, `Bash(npm test:*)`, `Bash(git status)`. A worker holding a claimed launch runs under its own permissions instead.
- Run commands from the worktree root without `cd`: every part of a compound command must match a rule on its own. When you need a command these rules do not cover, ask with a `needsAccess` question naming the command rather than retrying it.
- Notices may arrive in your inbox (the `inbox` operation): `stuck` when no progress has been observed for a while, `nudge` with a message from the operator, `baseMoved` with the new integration `head` and the `files` that changed, and `payloadChanged` when your task's description was edited (re-read the brief file). Check the inbox after long steps.

## Dependencies

- none

## Reporting

- API: `http://127.0.0.1:1/v1/launches/L1/...` with header `Authorization: Bearer <token from brief.json>`.
- Operations: heartbeat, report (kind submit|fail, with seq), block (a question; waits for the answer), inbox, log.
- If the API fails for more than 120s, write your report to `/w/.orchestrator/report.json` and exit.
- If any call returns 401, stop immediately: your launch has been revoked.
