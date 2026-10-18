# Codex fixtures

These files have the names of the codex-cli 0.163.0 probe outputs from 2026-10-18
(`probe/`, `facts/`, `spike/` in the probing session's scratchpad). They are
**reconstructions, not byte copies**. The scratchpad was still there, but the ORC-47
worker's sandbox could not read outside its worktree. Each file is built from the
facts recorded in Linear ORC-47 and the P-ORC-6 project description:

| File | Origin | What it shows |
| --- | --- | --- |
| `git-events.jsonl` | probe/git-events.jsonl | `codex exec --json` stdout. The `thread_id` and the `turn.completed` usage are the recorded values. `turn.completed` is the last line and follows the final `agent_message`. |
| `git2-events.jsonl` | probe/git2-events.jsonl | A second git probe. `git commit` fails under `workspace-write` in a linked worktree. The usage is synthetic. |
| `git-err.txt` | probe/git-err.txt | Stderr only (progress header and the git error), with no JSONL. A log cut off before `turn.completed`. |
| `mcp-events.jsonl` | probe/mcp-events.jsonl | An `mcp_tool_call` item against the probe server. The usage is synthetic. |
| `mcp-last.txt` | probe/mcp-last.txt | The `-o` last-message file of the MCP probe. |
| `C-events.jsonl` | facts/C-events.jsonl | An unknown `-m`: an `error` item, then `turn.failed`. Exit 1. |
| `D-stderr.txt` | facts/D-stderr.txt | `required=true` with a server that fails to start. Exit 1, no JSONL, the error on stderr. |
| `E-events.jsonl` | facts/E-events.jsonl | A plain successful run (`--ephemeral --ignore-user-config`). The usage is synthetic. |
| `G-events.jsonl` | spike/G-events.jsonl | Probe G: an MCP call completed under `approval_policy="never"` with both approve keys set. The usage is synthetic. |
| `probe-mcp-server.mjs` | facts/probe-mcp-server.mjs | A minimal stdio MCP server with one `echo` tool. |

Event shapes other than `thread.started`, `turn.started`, `turn.completed{usage}`,
`turn.failed`, and `error` are approximate. If byte-identical copies are wanted,
replace these files with the scratchpad originals.
