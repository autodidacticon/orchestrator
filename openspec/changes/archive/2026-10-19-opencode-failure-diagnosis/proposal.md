## Why

Without a classifier an opencode launch that dies at startup, runs without its shim, or has every command rejected ends as a bare `exitedWithoutReport`, and a startup-contention death burns a retry the task did nothing to earn.

## What Changes

1. `classifyOpenCodeFailure(text)` in src/runner/opencode.ts over the launch log (stdout JSONL and stderr in one file): parse JSONL lines; keep stderr lines, dropping `duplicate skill name` lines. Reasons in try order: `mcpStartupFailed` when a WARN line matches `server unavailable key=orchestrator` (even if the turn completed: the agent worked blind); `unknownModel` from an ERROR line matching `ProviderModelNotFoundError|Model not found`; `authFailed` from an ERROR line matching `401|unauthori[sz]ed|invalid api key|api key .*(missing|not set)|token (has )?expired|authentication (failed|error|required)` (the bare word `authentication` is not a failure); `startupContended` when no event was parsed and a stderr line is `database is locked`; `permissionDenied` when any `tool_use` part has `state.error` matching `rejected permission` or a stderr line matches `auto-rejecting`, with the command in the detail; `turnFailed` for any other `error` event (detail = its message, or the ERROR line that carries the same `ref`); undefined once a `step_finish` with `reason: "stop"` was seen and nothing above matched; `exitBeforeTurn` when no event was parsed, with the last stderr line matching `error|fatal|failed` as detail.
2. `OpenCodeRunner.readFailure` reads the launch log as the Codex runner does.
3. `startupContended` is retryable without charge: `exitedWithoutReport` does not count a launch whose runner failure is `startupContended` against the task's retry budget, up to `health.contendedRetries` (default 3) per task, after which it counts as usual; the relaunch is immediate. The event carries the reason so status shows it.
4. Fixtures: the classifier tests read test/fixtures/opencode/events/{E-badmodel.jsonl, D4.jsonl, D4.err, F1-ask.jsonl, F1-ask.err, K2.err, SA-proj.err, C2.jsonl, F2-deny.jsonl}, already committed (cc43c94) and never edited; new synthetic files are allowed only for an auth failure (none was observed) and are named as synthetic in the README.

## Capabilities

- `health-monitoring`: modified: "Process liveness"
- `task-lifecycle`: modified: "Retry and exhaustion", "Health failure reasons"

## Impact

* src/runner/opencode.ts, src/loop/orchestrator.ts (exitedWithoutReport), src/config.ts (health.contendedRetries)
* test/runner/opencode.test.ts, test/health/*.test.ts, test/fixtures/opencode/README.md

## Record

Reconstructed at archive time on 2026-10-19. The worker for ORC-60 edited `openspec/specs` directly in commit 96beb10 instead of writing a change directory; the deltas below are computed from what that commit did to each requirement block, and this proposal and the task list come from the ORC-60 issue text.

Commit summary: classifyOpenCodeFailure (src/runner/opencode.ts) reads the launch log: it parses JSONL events, keeps stderr lines with ANSI stripped and the `duplicate skill name` warnings dropped, and names failures in try order: mcpStartupFailed (WARN `server unavailable" key=orchestrator`, even after a completed turn), unknownModel and authFailed (from ERROR lines or error-event messages; detail is the line's error="..." value), startupContended (no events and `database is locked`), permissionDenied (a tool_use part rejected for permission, giving tool and command, else an `auto-rejecting` line), turnFailed (any other error event; detail is the ERROR line with the same ref, else error.data.message), undefined once a step_finish with reason "stop" was seen, and exitBeforeTurn (no events; detail is the last error, fatal or failed stderr line, if any). OpenCodeRunner.readFailure reads the log the way the Codex runner does. Orchestrator.failExited (called from tick's handleDeadLaunch, which recovery also goes through) records a `launch.failed` event {reason?, detail?, charged} for every launch that dies without a report. A startupContended death goes straight back to unstarted with attempts unchanged, up to health.contendedRetries (unset means 3) uncharged deaths per task, counted from those events; later ones are charged as usual. task-lifecycle (Health failure reasons, Retry and exhaustion) and health-monitoring (Process liveness) are updated, and the fixtures README maps each file to its origin and test. Commits c832ce4 and 8365b6a.
