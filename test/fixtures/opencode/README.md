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

## A rejected `ask` ends the run (probed 2026-10-19, ORC-63; same CLI and model)
- Found by the first real e2e run (test/e2e/opencode.test.ts): every derived-ruleset launch that hit an `ask` died right after that step,
  so the brief's "ask with `needsAccess`" never happened. The same prompt ("run uname -s with bash; if rejected, reply FALLBACK-OK") was run
  under `permission: { "*": "ask", read: "allow", bash: { "*": <mode>, "git *": "allow" } }` with `--pure --print-logs --log-level WARN`:
- events/P-ask.jsonl, events/P-ask.err: bash `"*": "ask"`. stderr `permission requested: bash (uname -s); auto-rejecting`, the tool_use
  error "The user rejected permission to use this specific tool call.", `step_finish` reason `tool-calls`, then nothing: exit 0, the model
  never sees the error. F1-ask.jsonl ends the same way.
- events/P-deny.jsonl: bash `"*": "deny"`. The tool_use error is "The user has specified a rule which prevents you from using this
  specific tool call. ..." with the rule list, and a second step follows in which the model answers `FALLBACK-OK` (`reason: "stop"`).
  Its stderr was empty and is not kept.
- The evidence for the derived ruleset's `deny` catch-alls (ORC-65); read by test/runner/opencode.test.ts (P-ask with P-ask.err gives
  `permissionDenied`, P-deny gives no diagnosis).

## Chained commands under the bash rules (probed 2026-10-19, ORC-65; same CLI and model)
- Each run asked the model to run one bash command verbatim under `permission: { "*": "deny", read/glob/grep/list/edit/write: "allow", bash: <rules> }`
  in a scratch git repo (`<scratch>`), with `--pure --print-logs --log-level WARN --dir <scratch>`. configs/X-<name>.json holds each run's
  permission and command; stderr held only `duplicate skill name` lines and is not kept. The rule: each simple command of a chain is matched
  on its own.
  - events/X-chain-allowed.jsonl: `git rev-parse --show-toplevel && git add a.txt && git commit -m probe && git status --short && true`
    under `git *` and `true` ran, and the commit was made.
  - events/X-chain-offpattern.jsonl: `git status --short && uname -s` under `git *` was denied: one off-pattern part denies the call, so
    `git *` is not matched as a glob over the whole string.
  - events/X-whole-string.jsonl: `true && true` under the single pattern `true && true` was denied: a whole-chain pattern never matches.
  - events/X-pipe-offpattern.jsonl: `git log --oneline | head -1` under `git *` was denied: each command of a pipe is matched.
  - events/X-semicolon-allowed.jsonl: `git status --short; true` under `git *` and `true` ran.
  - events/X-redirect.jsonl: `git log --oneline > log.txt` under `git *` ran: a redirection is not a separate command.
  - events/X-cd-chain.jsonl: `cd . && git status --short` under `git *` ran: `cd` is not matched against the bash rules.
  - events/X-check-segments.jsonl: `node --version && true` under the exact patterns `node --version` and `true` ran: a multi-word exact
    pattern matches its command. This is the check-command derivation.
- A probe's lesson: opencode takes its directory from `$PWD`, not the spawn cwd, so a child given another cwd needs `PWD` or `--dir`.
- Read by test/runner/opencode.test.ts (the off-pattern, pipe and whole-string runs: a deny refusal continued past gives no diagnosis).

## Real e2e run (recorded 2026-10-19, ORC-63)
- e2e-T1.jsonl, e2e-T2.jsonl, e2e-T3.jsonl: the JSONL events of each task's first launch in a passing
  `ORCH_E2E_OPENCODE=1 ORCH_E2E_OPENCODE_RECORD=1` run of test/e2e/opencode.test.ts (stderr dropped, redacted as below by the test).
  T2 holds the `orchestrator_block` call answered after 75 s. Written only under ORCH_E2E_OPENCODE_RECORD=1; not read by a test yet.

## Redaction
These files were redacted once, before they were saved, and are byte copies of the redacted output from then on: scratch paths are
replaced by `<scratch>`, the home directory by `~`, and GitLab model ids by `duo-chat-<model>`. Tests read them in place and edit none of them.

## Files and the tests that read them
- events/F1-ask.jsonl: test/health/usage.test.ts (`parseOpenCodeUsage`: cache reads folded into input; `OpenCodeRunner.readUsage`).
- events/F1-ask.err: test/health/usage.test.ts (stderr interleaved with the events is skipped).
- events/SA-proj2.jsonl: test/health/usage.test.ts (every step summed, `turns` = the `reason: "stop"` steps; the log cut before the first
  `step_finish` yields no usage).
- events/K2.err: test/health/usage.test.ts (stderr alone yields no usage).
- events/T1-T4.jsonl, configs/cfg-slow-perserver.json: the source of the `mcp.orchestrator.timeout` decision tested in test/runner/opencode.test.ts
  (`maxWaitMs + 60000`, never `mcp.timeout`); not read by a test.
- The failure classifier (`classifyOpenCodeFailure`, `OpenCodeRunner.readFailure`) in test/runner/opencode.test.ts reads, each a real probe
  output of 2026-10-18 committed in cc43c94:
  - events/E-badmodel.jsonl: stdout of `-m opencode/gpt-bogus-9` (the opaque `error` event alone gives `turnFailed`; with an ERROR line
    `unknownModel`).
  - events/D4.err, events/D4.jsonl: stderr and stdout of a run whose `mcp.orchestrator` command could not start (`mcpStartupFailed` after a
    completed turn; D4.err's `duplicate skill name` lines are the noise the classifier drops).
  - events/F1-ask.jsonl, events/F1-ask.err: stdout and stderr of `permission.bash: ask` with `echo marker-7731` (`permissionDenied`).
  - events/F2-deny.jsonl: stdout of `permission.bash: deny`, the tool removed and the turn completed (no diagnosis).
  - events/K2.err: stderr of one of the 23 concurrent starts on the shared database; events/SA-proj.err: the same in the same-project run
    (`startupContended`).
  - events/C2.jsonl: stdout of a completed run that called `orchestrator_ping` (the completed turn behind the noise and contention cases).
- Synthetic inputs: none of the files here. The ERROR lines for an unknown model (`ProviderModelNotFoundError: Model not found:
  opencode/gpt-bogus-9`, seen on stderr with `--log-level ERROR` but not saved) and for a failed login (never observed) are inline strings
  in test/runner/opencode.test.ts, marked there.
- The other files are evidence only, for the facts above.
