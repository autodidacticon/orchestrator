## Why

In the OPENCODE-M4 review run of `test/e2e/opencode-work.test.ts` (2026-10-24) a worker on `opencode/big-pickle` had its submit refused with `dirtyWorktree`, the provider logged `stream error` at 07:11:58 UTC, and `opencode run` then stayed alive with no output for over 12 minutes until the test tore it down at its 20-minute limit. `hosts/codex/bin/work.mjs` waits for its child to exit and nothing ends a child that has gone silent or whose launch the daemon has already ended: the daemon fails a silent claimed launch (lease expiry, or stuck detection) but has no process to reap, so the loop sits on a dead launch while the run waits for a worker. The e2e printed none of the loop's stderr, so the loop's own view of the hang was lost.

## What Changes

1. While the agent runs, the work loop watches the launch through `GET /v1/status` every `--poll-ms` and ends the agent's process group (SIGTERM, then SIGKILL after 5 s) when the daemon has ended the launch (failed, stuck, lease expired, cancelled, superseded), when the launch reported more than 30 s ago and the agent has not exited, or when the agent has written no output for longer than the silence limit while its task runs.
2. The silence limit is `--max-silence-ms` when given, else the claim's `health.stuckFailAfterMs` when the daemon sends one, else 45 minutes (the daemon's default `health.stuckFailAfterMs`); 0 turns it off. Silence is not counted while the task waits on an answer.
3. A launch the loop ended that the worker still holds is released without keep, naming the reason; a launch the daemon ended is left to the daemon's verdict. Either way the outcome is `hung`, which counts toward `--max-failures`, and the loop claims again.
4. The SIGINT/SIGTERM path ends agent process groups with the same SIGTERM-then-SIGKILL escalation.
5. The opencode and codex work e2es print the loop's stderr when they fail, a `waitFor` timeout included.

## Capabilities

- `host-integration`: modified: "Work loop by runner kind"; added: "Work loop ends a hung agent", "Work loop silence limit", "Work loop after ending an agent"

## Impact

* hosts/codex/bin/work.mjs
* test/host/work-loop.test.ts, test/e2e/opencode-work.test.ts, test/e2e/codex-work.test.ts
* No daemon change: the claim does not carry `health.stuckFailAfterMs` today (see design.md); the loop reads it when a later daemon sends it.
