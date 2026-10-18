# Codex fixtures

Byte-identical copies of the codex-cli 0.163.0 probe outputs recorded on 2026-10-18
(verified with `cmp` against `~/.orchestrator/codex-evidence-2026-10-18/`, where the
probing session's `probe/`, `facts/`, and `spike/` directories are preserved). The one
exception is `two-turns.jsonl`, which is hand-written.

| File | Origin | What it shows |
| --- | --- | --- |
| `git-events.jsonl` | probe/git-events.jsonl | `codex exec --json` stdout of the first git probe under `-s workspace-write` in a linked worktree. `printf`, `git log`, and `git status` appear as `command_execution` items; the denied `git add` and `git commit` do not appear at all, and their `Operation not permitted` error is quoted only in the final `agent_message`. `turn.completed` is the last line and follows that message. Usage input 40361, cached 32128, output 260. |
| `git2-events.jsonl` | probe/git2-events.jsonl | The second git probe: same shape, again with the denied commands absent from the JSONL. |
| `git-err.txt` | probe/git-err.txt | The stderr of the git probe: one line, `Reading additional input from stdin...`. No JSONL. |
| `mcp-events.jsonl` | probe/mcp-events.jsonl | A clean run that lists the shim's five tools in its `agent_message`. No tool call, turn completed. |
| `mcp-last.txt` | probe/mcp-last.txt | The `-o` last-message file of that run: the five tool names. |
| `C-events.jsonl` | facts/C-events.jsonl | An unknown `-m gpt-bogus-9`: an `error` item (`Model metadata ... not found`) before `turn.started`, then an `error` event and `turn.failed` carrying a JSON-encoded API 400. Exit 1, no `turn.completed`. |
| `D-stderr.txt` | facts/D-stderr.txt | `required=true` with a server that fails to start: three stderr lines, the `ERROR codex_core::session` line naming `required MCP servers failed to initialize`, and no JSONL. Exit 1. |
| `E-events.jsonl` | facts/E-events.jsonl | An MCP tool call refused for approval under `approval_policy="never"`: `probe.probe_write` fails with `MCP tool call requires approval, but approval policy is never`, the agent repeats the message, and the turn still completes. Exit 0. |
| `G-events.jsonl` | spike/G-events.jsonl | Probe G: the same call completed under `approval_policy="never"` with both approve keys set, and its result shows the MCP server process writing outside the worktree, reaching loopback HTTP, and committing in the linked worktree. |
| `probe-mcp-server.mjs` | facts/probe-mcp-server.mjs | The stdio MCP server the probes registered, with its `probe_write` tool. |
| `two-turns.jsonl` | hand-written (ORC-50) | **A test decision, not a probe output.** Two `turn.completed` lines in one exec, which a real codex has not been seen to print. It pins the rule that usage is summed over every `turn.completed`. |
