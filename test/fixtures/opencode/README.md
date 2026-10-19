# OpenCode probe evidence, 2026-10-18 (opencode 1.18.30, model opencode/big-pickle, free)

Feasibility probes for an `opencode` runner kind. Facts the orchestrator would rely on:

- `opencode run --format json` prints JSONL events: step_start, text, tool_use, step_finish, error.
  step_finish.part carries tokens {total,input,output,reasoning,cache{read,write}} and cost.
  total = input + output + reasoning + cache.read, so `input` excludes cache reads (Claude-style).
- stdin: when not a TTY it is read to EOF and appended to the message (events/A-stdin.jsonl, H1.jsonl).
  A run with stdin left open hangs after the log line `message=init`. The template must redirect stdin.
  Empty message: exit 1 "You must provide a message or a command".
- Per-launch config: OPENCODE_CONFIG=<file> or OPENCODE_CONFIG_CONTENT=<json>. `mcp.<id>` with
  type local, command [...], environment {...}. Tools are named `<id>_<tool>` (orchestrator_ping).
  The MCP child inherits the whole parent environment plus `environment`.
- MCP server that cannot start: WARN `server unavailable key=orchestrator type=local status=failed`,
  the run continues without the tools, exit 0 (events/D4.*). No `required` analog.
- Unknown model: JSONL `error` event UnknownError "Unexpected server error" with a ref, exit 1; the
  real text (ProviderModelNotFoundError: Model not found: ...) is only on stderr with
  `--print-logs --log-level ERROR` (events/E-badmodel.jsonl).
- permission `ask` headless: auto-rejected; stderr "permission requested: bash (...); auto-rejecting",
  tool_use state error "The user rejected permission to use this specific tool call.", exit 0 (F1).
  permission `deny`: the tool is removed from the model's tool set (F2).
- `--variant <effort>` is silently accepted on a model without variants (I1).
- Concurrency: shared ~/.local/share/opencode/opencode.db. 4 of 23 concurrent starts failed at
  startup with exit 1 "database is locked" and no events (K2.err, SA-proj.err). Same-directory
  concurrency also contends on the snapshot git repo. A private XDG_DATA_HOME per launch removed the
  lock (SC), but auth.json lives in that data dir.
- `opencode serve` + `run --attach`: the client's OPENCODE_CONFIG does not reach the server; MCP
  servers come from the server's config only (R1).
- Skills are discovered under ~/.agents/skills/<name> (the Codex host's install path) and
  ~/.claude/skills; the project plugin dir .opencode/plugins/ receives session.created,
  session.idle, tool.execute.before and more.

## MCP call timeout (probed 2026-10-19, same CLI)
- Default: an MCP tool call is cut after 60 000 ms with tool state error `MCP error -32001: Request timed out` (events/T1.jsonl: a 75 s `sleep` tool).
- `mcp.timeout.execution` (in the published schema) is dropped by 1.18.30 with WARN `configuration compatibility diagnostic ... path=["mcp","timeout"] kind=unsupported action="Omitted native setting that cannot be represented in V1"`, under both the flat `mcp.<id>` and the `mcp.servers.<id>` shapes (T2, T3, T3-diagnostic.err).
- Per-server `mcp.<id>.timeout: 900000` (flat shape) is honoured: the 75 s call completed with `slept-75` (events/T4.jsonl, configs/cfg-slow-perserver.json).

## Plugin context injection (probed 2026-10-19)
- The plugin SDK on this machine (@opencode-ai/plugin 1.17.10 types) declares, among others: chat.message (output.message, output.parts), chat.params, chat.headers,
  experimental.chat.system.transform (output.system: string[]), experimental.chat.messages.transform, permission.ask, tool.execute.before/after,
  shell.env, command.execute.before, tool.definition. The docs page lists only a subset.
- Both paths put text in front of the model (events/Y2.jsonl, configs/inject-plugin.js, events/Y2-plugin.log): `experimental.chat.system.transform`
  pushing a line into output.system (called once per LLM step; the array is rebuilt each time), and `chat.message` appending to the user's existing
  text part. The model repeated both markers verbatim. Pushing a NEW part from chat.message without id/sessionID/messageID fails the run with
  ERROR "invalid user part before save" (first attempt, exit 1).
- The SDK client has client.tui.showToast, appendPrompt, publish for the TUI; not exercised headless.
- `--pure` disables plugins, so worker launches (which pass --pure) never load them; this path is for the operator host only.

## Brief-following on the free model (probed 2026-10-19; brief-run/)
- Harness: fake-shim.mjs serves the five agent tools with the shim's real descriptions and schemas, records every call (q3-calls-run*.jsonl), and
  answers `block` after 70 s; cfg-q3.json registers it with `timeout: 900000`; brief-q3.md is a real-shaped brief with a trivial task whose
  file name the operator must choose, using the opencode Reporting wording (tool names `orchestrator_<tool>`).
- Three runs of `opencode run --format json --pure -m opencode/big-pickle < brief-q3.md` (Q3-1..3.jsonl), two of them concurrent, all did the
  same thing: heartbeat with progress, one `block` of kind needsDecision asking for the file name (waited the 70 s), file created with the answered
  name and content, `git add`/`git commit` on the launch branch, heartbeat, `report` kind submit with three acceptance entries, exit 0 in 104-121 s.
  No curl or direct API use; no tool other than bash and the five shim tools.
