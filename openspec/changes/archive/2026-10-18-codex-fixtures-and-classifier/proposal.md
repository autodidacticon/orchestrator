# Codex fixtures become byte copies, and the failure classifier stops over-matching

## Why

The CODEX-M1 review (2026-10-18) found two things in the Codex runner's test assets and its spawn-failure diagnosis:

- The ten files under `test/fixtures/codex/` were reconstructions of the probe outputs, not copies. The worker that wrote them could not read the probing session's scratchpad. The originals survive under `~/.orchestrator/codex-evidence-2026-10-18/`, and they differ from the reconstructions in shape: the real `git-err.txt` is one stderr line; the real `C-events.jsonl` puts the `error` item before `turn.started` and carries a JSON-encoded 400; the real `D-stderr.txt` has a `Reading prompt from stdin...` line and an `Error: thread/start` line; the real `E-events.jsonl` is an approval refusal whose turn still completes with exit 0; and in both real git probes the denied `git add`/`git commit` never appear as `command_execution` items at all, only in the agent's final message.
- `classifyCodexFailure` matched the bare word `authentication` (so the stderr line `Using authentication from CODEX_HOME` reads as `authFailed`), matched `denied`/`cancel`/`reject` on any failed MCP call (so an `EACCES: permission denied` tool error reads as `mcpApprovalRefused`), looked only at the last `command_execution` item for a sandbox denial, and fell back to the last stderr line of any kind for `exitBeforeTurn` where the spec says the last error line.

## What changes

- `test/fixtures/codex/` holds byte-identical copies of the ten probe files; `two-turns.jsonl` stays as the one hand-written fixture, and the README says so.
- `classifyCodexFailure`: `authFailed` requires a login failure (`401`, unauthorized, not logged in, `codex login`, invalid or missing API key, expired token, or `authentication failed|error|required`); `mcpApprovalRefused` requires the approval wording Codex emits (`requires approval`, `approval policy`); `sandboxDenied` is read from any failed `command_execution` item whose output says `Operation not permitted`, or, when no item does, from an `agent_message` that reports it, because the probes show Codex omitting the denied command from the JSONL; the `exitBeforeTurn` detail is only an error line.
- The tests pinned to the reconstructions move to the real contents, and three negative tests pin the reviewer's repros.

## Scope

task-lifecycle "Health failure reasons" (MODIFIED). No capability is added. The fixture files and `test/fixtures/codex/README.md` are test assets outside the specs.
