## Why

The Codex milestone is a run on a live repository that imports an epic and publishes every task with usage recorded. Until now report, heartbeat and block had never been exercised through a real Codex CLI, so the live run would have been the first test. A gated e2e makes the claim repeatable. Its first run found a defect: the brief described only the HTTP API, Codex called it with `python3`/`urllib`, the `workspace-write` sandbox refused the connection (`Operation not permitted`), and every launch fell back to the report file.

## What Changes

- `test/e2e/codex.test.ts`, gated on `ORCH_E2E_CODEX=1` and skipped with a console warning when `codex` is not on PATH. It runs three dependent tasks plus a question task whose `block` is answered after 90 s, under `runner.kind: codex` with the default sandbox, commit policy and `ignoreUserConfig`. It asserts the published commits, the launch rows' `runner` and `tokens`, one `launch.usage` per launch, the unpriced cost, the daemon commit policy, and one completed `block` item in the question task's log. It prints the item types it saw and three probe lines.
- The brief of a `codex` launch tells the agent to call the operations through the `orchestrator` MCP server's tools and not to call the API from a command, because the sandbox blocks a command's network access.
- README's Tests paragraph names the e2e.

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `agent-protocol`: a requirement for the Codex brief's reporting text.

## Impact

- Code: `src/brief/compose.ts` (one paragraph for codex launches).
- Tests: `test/e2e/codex.test.ts` (new), `test/loop/brief.test.ts`.
- Behaviour: unchanged for claude-code launches.
