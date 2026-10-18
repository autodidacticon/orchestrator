## Context

ORC-47 left four facts unverified after its probes: that `tool_timeout_sec` governs a long `block` in a real run; the `--json` item shape for a completed MCP tool call; that the daemon commit policy seals a real Codex worktree; and whether Codex writes anything into the worktree at exit. This change's e2e settles them against codex-cli 0.163.0 (logged in with a ChatGPT account, model `gpt-6-astra` at effort `medium`, the runner defaults: `workspace-write`, `daemon` commits, `--ephemeral`, `--ignore-user-config`). Runs: 2026-10-18 on macOS (Darwin 25.5.0).

## Decisions

**Graph.** The three tasks of claude.test.ts, with "Commit it." dropped from the descriptions because a daemon-policy agent leaves its changes uncommitted, plus Q1, which depends on T1 so the check command `test -f hello.txt` holds on its tree. Q1's description asks the agent to call `block` once with `needsDecision` before writing anything. The test answers it once it has waited 90 s, measured from the waiting status's `askedAt`. Capacity is 2.

**Timeout sizing.** `maxWaitMs` is 5 min, so the daemon's long poll carries the 90 s answer in one call and `tool_timeout_sec` is 360. With the harness's 60 s `maxWaitMs`, the daemon would answer `{timeout:true}` at 60 s and the agent would call `block` again, so the "exactly one completed block item" assertion could not tell a client timeout from a daemon timeout. Codex's documented default MCP tool timeout is 60 s, so a 90 s call that completes as one item shows the override is applied.

**What counts as a rejection.** A dirty-worktree 409 is not recorded as an event, so the test wraps `Orchestrator.handleReport` and records any 409. Under the daemon policy a dirty worktree is committed rather than refused, so "no 409" proves little on its own. The stronger evidence for "artifacts absent" is the file list of the four task commits, which the test prints and checks contains nothing Codex-specific and nothing under `.orchestrator/`.

**Pricing.** ORC-43 prices at record time, not at read time: configuring `budgets.prices` after the launches end would not change `status()`. The e2e therefore asserts only the unpriced case (`runUsd` 0, `unpricedLaunches` equal to the launch count) and the priced case stays in the fake-codex slice.

**Diagnostics.** On failure the test copies the launch logs, the event log and the launch rows to `<tmpdir>/orch-codex-keep-*` before the harness removes the run directory, and prints the path. The item types are printed before any assertion that can throw.

## Finding: the Codex brief must name the MCP tools

The first run stalled with T1 blocked after two launches. The brief described only the HTTP API. Codex read `brief.json`, posted the report with `python3`/`urllib`, got `URLError <urlopen error [Errno 1] Operation not permitted>` (the `workspace-write` sandbox has no network), wrote the fallback report file and exited. No `mcp_tool_call` item appeared. Both fallback submits ended `deadOrExpired` (the retry budget was exhausted). One agent also read the orchestrator's own source outside its worktree (reads are allowed under `workspace-write`) to learn the report schema.

The fix is one paragraph in the Reporting section of a `codex` brief: call the operations through the `orchestrator` MCP server's tools, do not call the API from a command because the sandbox blocks its network access, and use the fallback file only when an MCP call fails. After it, every report went through MCP and the e2e asserts no `agent.fallback` event. The text is codex-only, so the claude-code brief is byte-identical. Why the two fallback submits failed rather than verified was not investigated: with the brief fixed the path is not taken. It is a follow-up.

## Probe results (codex-cli 0.163.0, two passing runs)

- **Item types seen across the launch logs:** `agent_message`, `command_execution`, `file_change`, `mcp_tool_call`. The first, failing run saw only `agent_message` and `command_execution`.
- **Completed MCP tool call shape:** `{"type":"item.completed","item":{"id":"item_1","type":"mcp_tool_call","server":"orchestrator","tool":"block","arguments":{"kind":"needsDecision","message":"Which word should answer.txt contain?","seq":1},"result":{"content":[{"type":"text","text":"{\"status\":200,\"answer\":\"pineapple\"}"}],"structured_content":null},"error":null,"status":"completed"}}`. `tool` is the bare tool name; `server` is the registration id.
- **Tool timeout honoured: true.** Q1 held one `block` item, `status: completed`, carrying the answer, after waits of 90068 ms and 90042 ms with `tool_timeout_sec` 360. No error item and no second `block` call.
- **Daemon seal under workspace-write: true.** All four submits carry `committedByOrchestrator: true`; no agent asked for `git add` or `git commit`.
- **Codex artifacts absent: true.** No 409; the task commits hold exactly `hello.txt`, `shout.sh`, `README.md`, `answer.txt`. With `--ephemeral`, Codex left nothing in the worktree outside `.orchestrator/` (which the seal excludes); the worktree is removed after publish, so `.orchestrator/` itself was not inspected.
- **Usage:** one `launch.usage` per launch, `usageSource: codex`. Second run, input/output tokens: T1 86463/341, T2 87477/662, Q1 195916/584, T3 102720/576. `cost.runUsd` 0 and `unpricedLaunches` 4 without `budgets.prices`.
- **Wall time:** about 125 s per run, 90 s of it Q1's wait.

These close ORC-47's open questions on tool timeout, item shape, daemon seal and worktree artifacts.

## Risks

- Paid, and depends on a logged-in ChatGPT account and codex-cli 0.163.0 behaviour; a model that ignores the brief's instruction would fall back to the report file again, and the test fails on that.
- The 90 s wait makes the test slow.
