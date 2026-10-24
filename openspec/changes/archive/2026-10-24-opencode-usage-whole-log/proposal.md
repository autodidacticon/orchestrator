## Why

`parseOpenCodeUsage` read only the last 256 KiB of the launch log. OpenCode reports usage per step, not as a running total, so every `step_finish` before that window was dropped without notice. The log also carries full tool outputs (file contents in `tool_use` parts) and the WARN-level stderr, so a task that reads a few large files passes 256 KiB and its tokens and `costUsd` come out too low; budgets and pricing read these numbers. The window was copied from the Codex parser, where usage is one `turn.completed` near the end. The OPENCODE-M3 review reproduced it: a log of [step_finish input 1000 cost 1, a 300 KiB tool_use line, step_finish input 5 cost 1] parsed to the second step only.

## What Changes

1. The OpenCode usage parser reads the whole log line by line and sums every `step_finish`. `OpenCodeRunner.readUsage` streams the file (new export `readOpenCodeUsage`), so memory stays bounded by the read chunk and the line cap rather than the log size.
2. A line longer than 64 KiB (`OPENCODE_USAGE_LINE_CAP`) is skipped without parsing its body: `step_finish` lines are a few hundred bytes, and the long lines are tool output.
3. `classifyOpenCodeFailure` keeps its 256 KiB tail: it looks for the last events.
4. worker-runners "OpenCode usage parsing" states that the whole log is read, the line cap, and why.

## Capabilities

- `worker-runners`: modified: "OpenCode usage parsing"

## Impact

* src/runner/opencode.ts
* test/health/usage.test.ts
