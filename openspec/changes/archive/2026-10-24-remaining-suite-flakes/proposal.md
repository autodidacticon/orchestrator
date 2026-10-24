## Why

ORC-73 (suite-without-retry) left two of its four flakes undiagnosed: test/e2e/scripted.test.ts "plain restart adopts a mid-task agent; --reap-on-exit stops it" and test/slice/codex-work.test.ts "two loops drain…". In the CODEX-M5/OPENCODE-M4 review, the third of three sequential `npx vitest run` (no `--retry`) failed at scripted.test.ts:75 (`expected undefined to be defined`). Both failures turn out to come from daemon or loop bugs, not from slow waits (design.md):

- The store's constructor switched a new file to WAL before it set the busy timeout. When two processes open a new store at once, SQLite answers `SQLITE_BUSY` ("database is locked") without calling the busy handler. A daemon that lost that race exited at startup. The restart test's poll opens the store at about the moment the daemon does, so the daemon could die and no launch ever went live.
- The work loop stopped because it took any node in `status.awaitingReview` as a review waiting on a human. That list also holds tasks that are submitted and waiting for the verifier. Both loops stopped while T1 and T3 were verifying, before T2 became claimable.

## What Changes

1. `src/state/sqlite.ts`: the busy timeout is set first, and the WAL switch and the schema creation are retried with a short blocking backoff for up to five seconds while SQLite reports `SQLITE_BUSY`.
2. `src/loop/orchestrator.ts`: `status` gains `verifying`, the submitted tasks, the same list the event digest already has. `src/operator/routes.ts` takes the digest's `verifying` from it.
3. `hosts/codex/bin/work.mjs` `stopVerdict`: while `verifying` is non-empty the run is not quiet, and a review is an `awaitingReview` entry that is not in `verifying`. The Claude Code workflow's claimer prompt (`hosts/claude-code/workflows/work.js`) gets the same rule.
4. Tests: the restart test waits on the persisted `launch.live` event through `run.waitUntil`, which opens the store only after the daemon has created it, fails at once with the daemon log when the daemon exits, and checks that the launch is still live. The codex-work test dumps the event log when its wait times out. New tests: a concurrent store open (test/state/sqlite.test.ts with helper test/state/hold-new.ts), `status.verifying` (test/loop/scenarios.test.ts), and `stopVerdict` cases with verifying tasks (test/slice/codex-work.test.ts).

## Capabilities

- `crash-recovery`: modified "Store transactions": a concurrent open of a new store waits.
- `operator-control`: modified "Status report": `verifying`.
- `host-integration`: modified "Work loop by runner kind": the stop rule ignores verifying tasks and is not quiet while any exist. The block is built on the one in `work-loop-ends-hung-agent` (ORC-79), which modifies the same requirement, so archive that change first.

## Impact

* src/state/sqlite.ts, src/loop/orchestrator.ts, src/operator/routes.ts, hosts/codex/bin/work.mjs, hosts/claude-code/workflows/work.js. These are outside the task's listed scope: the causes are there, and the acceptance criterion allows a fix in code shown by a test.
* test/e2e/scripted.test.ts, test/slice/codex-work.test.ts, test/state/sqlite.test.ts, test/state/hold-new.ts, test/loop/scenarios.test.ts
