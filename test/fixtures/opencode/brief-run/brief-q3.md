# Task T1: Create the greeting file the operator names

## Description

Create one text file at the repository root containing the line `hello from opencode`. The operator has not decided the file's name: you must ask for it before creating the file, and use exactly the name the answer gives.

## Acceptance criteria

1. A file exists at the repository root whose content is exactly the line `hello from opencode`.
2. The file's name was chosen by the operator through a `needsDecision` question asked with the `orchestrator_block` tool, and the file uses that name.
3. The file is committed on the launch branch.

## Definition of done

- Commit all work on branch `task/T1/l1` in this worktree. Uncommitted or untracked files make your submission be rejected with 409 and the file list; commit and resubmit.
- Never merge into, push to, or check out `main`. The orchestrator integrates your branch after verification.
- Run the check command before submitting: `node --version`.
- Your report must give evidence for every acceptance criterion above: one `acceptance` entry per criterion, whose `criterion` quotes the criterion text or gives its number.
- Terminate as soon as your report is accepted.

## Workspace

- Worktree: `<scratch>/proj5`
- Branch: `task/T1/l1`
- Base commit: `3545a707f8d208aaf675fa384f20a1e4457b107c`
- Integration branch: `main`
- You run with OpenCode permission rules in force and no sandbox: a command a rule does not allow fails with 'The user rejected permission to use this specific tool call.' and will not be approved at runtime. Do not retry it; ask with a `needsAccess` question naming the command, then continue with what you can.
- Notices may arrive in your inbox (the `orchestrator_inbox` tool): `stuck` when no progress has been observed for a while, `nudge` with a message from the operator, `baseMoved` with the new integration `head` and the `files` that changed.

## Dependencies

- none

## Reporting

- Call these operations through the `orchestrator` MCP server's tools: `orchestrator_heartbeat`, `orchestrator_report`, `orchestrator_block`, `orchestrator_inbox`, `orchestrator_log`.
- Send a heartbeat first, with a short progress text, and again after each long step.
- Operations: heartbeat, report (kind submit|fail, with seq), block (a question; waits for the answer, which may take minutes), inbox, log.
- If a tool call fails for more than 120s, write your report to `<scratch>/proj5/.orchestrator/report.json` and exit.
- If any call returns 401, stop immediately: your launch has been revoked.
