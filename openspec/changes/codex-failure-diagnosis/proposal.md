## Why

A launch whose process dies without a report fails with one generic `exitedWithoutReport` message, and the runner interface cannot say why. Codex has distinct early failures that the probes of 2026-10-18 recorded: an unknown model (an `error` event, then `turn.failed`, exit 1), a required MCP server that does not start (exit 1 before any turn, the error on stderr), an MCP tool call refused for approval, a missing or rejected login, and a sandbox denial (`.git ... Operation not permitted` in a `command_execution` item). Each of these surfaces as a dead launch with no usage and a retry that fails the same way, so attempts are spent and the operator learns nothing.

## What Changes

- `AgentRunner.readFailure?(launch): Promise<{ reason, detail? } | undefined>`. `MultiRunner` routes it by the kind on the row, like `readUsage`. `ClaudeCodeRunner` does not implement it, so a Claude launch behaves as before.
- `CodexRunner.readFailure` reads the launch log (stdout JSONL and stderr in one file) through the pure `classifyCodexFailure(text)`. The reasons are `unknownModel`, `authFailed`, `mcpStartupFailed`, `mcpApprovalRefused`, `sandboxDenied`, `turnFailed` (any other `turn.failed` or `error`), and `exitBeforeTurn` (no turn started and nothing else matched). A run whose turn completed with none of these gives undefined, as does a missing log. `detail` is the message or log line that shows the reason.
- A dead launch without a fallback file fails with `exitedWithoutReport` as before. When the runner has a diagnosis, the message is `process exited without a report: <reason>: <detail>`, the failure's `detail.runnerFailure` holds `{ reason, detail }`, and the `launch.ended` event carries `runnerFailure`. The recovery path (`process gone at recovery`) does the same.
- The next attempt's brief already carries the prior failure as JSON; it gains a line naming the runner's diagnosis and telling the agent to avoid that cause or ask.
- No new failure kind and no new state: the reason is runner-provided detail on `exitedWithoutReport`.

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `task-lifecycle`: `Health failure reasons` records the runner's diagnosis as detail on `exitedWithoutReport`.
- `health-monitoring`: `Process liveness` says the dead-launch record carries the runner's reason.

## Impact

- Code: `src/runner/runner.ts` (`RunnerFailure`, `readFailure?`), `src/runner/codex.ts` (`readFailure`, `classifyCodexFailure`, `CodexFailureReason`), `src/runner/multi.ts`, `src/runner/inproc.ts` (`failureScript`), `src/loop/orchestrator.ts` (`exitedWithoutReport`, `endLaunch` extra payload), `src/loop/tick.ts`, `src/launch/recovery.ts`, `src/brief/compose.ts`, `src/index.ts`.
- Fixtures: `test/fixtures/codex/E-events.jsonl` now shows a refused MCP call instead of a plain successful run; `git-events.jsonl` and `G-events.jsonl` serve as complete runs.
- Behaviour: a dead Codex launch still spends an attempt and retries; the reason is visible in the failure, the event log, and the next brief.
