## Why

The OPENCODE-M3 review (2026-10-19) found three gaps in the OpenCode tests:

- ORC-61 asked to extend the real-git slice test for `commit: daemon` to the opencode kind. The daemon seal for opencode was covered only in the in-memory harness (test/loop/brief.test.ts), and test/slice/launch.test.ts covered `runner.claude.commit` only.
- test/e2e/opencode.test.ts (ORC-63) took the expected attempts from each event's own `payload.charged`, so a contended death within the allowance that was wrongly charged would still pass. task-lifecycle says such deaths record `charged: false`.
- test/host/opencode-host.test.ts (ORC-62) allowed 15 rewritten blocks between the Codex and OpenCode skill editions and only checked that each one held its anchor phrase, so text elsewhere in an anchored block could drift.

## What Changes

1. A slice test runs an `opencode` launch under `runner.opencode.commit: daemon` through the real `OpenCodeRunner` and its default template, with a fake `opencode` on PATH that runs the scripted agent's `submitDirty`. It asserts the orchestrator's commit on the launch branch: author and committer `orchestrator`, the summary as the message, only the agent's file, `sealedSha` at the head, and `committedByOrchestrator: true` on `agent.report`.
2. The e2e's counter-rule check becomes `checkContended`. It takes the allowance from `health.contendedRetries` (default `DEFAULT_CONTENDED_RETRIES`) and asserts `charged: false` for each task's first deaths up to the allowance and `charged: true` after them. It counts expected attempts from the allowance. Unit tests that run without opencode show it failing on a charged death within the allowance and on an uncharged one past it.
3. Each rewritten skill block in the host test is pinned to the first 16 hex digits of the sha256 of its normalised text, keyed by its anchor phrase. A change anywhere in the block fails the test and prints the block, until the hash is updated.

## Capabilities

- `worker-runners`: added "OpenCode e2e contended-death counter rule"; modified "Sandbox and commit policy" (one new scenario)
- `host-integration`: modified "OpenCode host" (rewritten blocks pinned; one new scenario)

## Impact

* test/slice/launch.test.ts
* test/e2e/opencode.test.ts
* test/host/opencode-host.test.ts
