# Design

## Where a sandbox denial shows up

Both real git probes (`git-events.jsonl`, `git2-events.jsonl`, codex-cli 0.163.0 under `-s workspace-write` in a linked worktree) ran `git add` and `git commit`, both of which failed with `fatal: Unable to create '<repo>/.git/worktrees/<wt>/index.lock': Operation not permitted`. Neither command appears in the `--json` stream: the only `command_execution` items are the `printf`, `git log`, and `git status` that succeeded, and the error text is carried by the agent's final `agent_message`. The e2e of codex-e2e saw a network denial (`python3` with `urllib`, `[Errno 1] Operation not permitted`) in a run whose item types were `agent_message` and `command_execution`, so a failed command item with the error in its output is also possible.

The classifier therefore reads the denial from either place, in this order after the named errors and the approval refusal: a failed `command_execution` item (any, not only the last) whose `aggregated_output` says `Operation not permitted` wins; otherwise, after `turnFailed`, an `agent_message` that says `Operation not permitted` is taken as the diagnosis with that line as the detail. The message is the weaker signal and so comes after any explicit error. `readFailure` is only consulted for a launch that died without a report, so an agent that reported the denial itself and then exited is exactly the case this diagnoses.

Consequence for the fixtures: both real git logs now classify as `sandboxDenied`. The "complete run gives no diagnosis" cases are `mcp-events.jsonl` and `G-events.jsonl`, whose turns completed with nothing failing.

## Approval refusal with a completed turn

The real `E-events.jsonl` ends with `turn.completed` and exit 0: Codex finishes the turn after the refused call. The classifier already checks the refusal before it treats a completed turn as "no diagnosis", so the real fixture classifies as `mcpApprovalRefused` without a rule change; the spec text says so explicitly now.

## Patterns

- `AUTH_FAILED`: `\b401\b`, `unauthori[sz]ed`, `not logged in`, `codex login`, `invalid api key`, `api key ... (missing|invalid|not set)`, `token (has )?expired`, `authentication (failed|error|required)`. The bare word `authentication` is dropped: Codex prints `Using authentication from CODEX_HOME` on a normal run.
- `APPROVAL`: `requires approval` or `approval policy`, the wording of the observed refusal (`MCP tool call requires approval, but approval policy is never`). A tool error such as `EACCES: permission denied` is no longer an approval refusal.
- `exitBeforeTurn` detail: the last stderr line matching `error|fatal|failed`, else none.

## Fixtures

The ten files are `cp`'d from `~/.orchestrator/codex-evidence-2026-10-18/{probe,facts,spike}/` and verified with `cmp`. `two-turns.jsonl` is unchanged. Tests that pinned reconstruction details move to the real values: the unknown model is `gpt-bogus-9`, the refused tool is `probe.probe_write`, `D-stderr.txt`'s diagnosis is its `ERROR` line, and the fake codex's last message is whatever the fixture's last `agent_message` says.
