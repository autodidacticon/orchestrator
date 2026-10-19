# Task T1: Golden

Do the golden task.

## Acceptance criteria

1. it works

## Definition of done

- Leave your changes in this worktree on branch `task/T1/l1`, committed or not; the orchestrator commits what is uncommitted when it accepts your report.
- Never merge into, push to, or check out `main`. The orchestrator rebases your branch onto the integration head at verification and integrates it after verification.
- Run the check command before submitting: `npm test`.
- If the task needs no changes, say so explicitly with `noChanges: { justification }` in your report.
- Your report must give evidence for every acceptance criterion above: one `acceptance` entry per criterion, whose `criterion` quotes the criterion text (markdown and case do not matter) or gives its number.
- Terminate as soon as your report is accepted.

## Workspace

- Worktree: `/w`
- Branch: `task/T1/l1`
- Base commit: `base1`
- Integration branch: `main`
- You run under the Codex sandbox `workspace-write` with approvals disabled: a command the sandbox refuses fails with 'Operation not permitted' and will not be approved at runtime. Do not retry it; ask with a `needsAccess` question naming the command. The operator can run it for you, or change `runner.codex.sandbox` for your next launch.
- Notices may arrive in your inbox (the `inbox` operation): `stuck` when no progress has been observed for a while, `nudge` with a message from the operator, `baseMoved` with the new integration `head` and the `files` that changed, and `payloadChanged` when your task's description was edited (re-read the brief file). Check the inbox after long steps.

## Dependencies

- none

## Reporting

- Call these operations through the `orchestrator` MCP server's tools (`heartbeat`, `report`, `block`, `inbox`, `log`). Do not call the API from a command (curl, a script): the sandbox blocks its network access. Use the fallback file below only when an MCP tool call itself fails.
- API: `http://127.0.0.1:1/v1/launches/L1/...` with header `Authorization: Bearer <token from brief.json>`.
- Operations: heartbeat, report (kind submit|fail, with seq), block (a question; waits for the answer), inbox, log.
- If the API fails for more than 120s, write your report to `/w/.orchestrator/report.json` and exit.
- If any call returns 401, stop immediately: your launch has been revoked.
