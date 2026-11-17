## Why

A worker in a sandbox without network cannot install dependencies, so it cannot run the check command in its worktree (ORC-130, release 0.6.0 task 84c). The daemon has the network; it can install before the agent starts.

## What Changes

- Two top-level file keys beside `checkCommand`, read at start: `prepareCommand` (optional) and `prepareTimeoutMs` (default 600000). Not overrides, not detected, not in the config report.
- New module `src/launch/prepare.ts`. After each `Workspace.prepare` of a launch (admission, the spawn pass for a parked launch, recovery's relaunch) the daemon starts the command in the background, labelled `orch-prepare-<launchId>`, through `runCheck`. The row stays `preparing` (or `launching` in the spawn pass). A tick applies the outcome: on success, after a clean test, `launch.prepared` and then park or spawn (the lease renewed first); on failure, `launch.prepareFailed`, the launch ended with `prepareCommandFailed`, and the task back to `unstarted` with no attempt spent.
- `runCheck` gains an optional sixth parameter `{ label, signal, closeWaitMs }`; the error handler marks `spawnError`. The verifier's caller passes nothing and behaves as before.
- The transition table gains `running -> unstarted` by the orchestrator with trigger `prepareFailed`.
- A task that left its launch while the command runs ends the launch once the command was killed and ended; `stop()` aborts every command and applies nothing.
- With the key set, recovery ends a parked launch the configured command has not run for (`notPrepared`) and fails its task at no cost.

## Capabilities

### New Capabilities

### Modified Capabilities
- `pull-runner`: ADDED "Prepare command", "Prepare failure", "Prepare command and a task that left".
- `crash-recovery`: ADDED "Prepare command at recovery".
- `task-lifecycle`: MODIFIED "Transition table enforcement" (one row, one scenario).

## Impact

- Code: `src/config.ts`, `src/verify/verifier.ts` (`runCheck` only), `src/launch/prepare.ts` (new), `src/launch/launch.ts` (`parkLaunch` extracted), `src/launch/recovery.ts`, `src/loop/core.ts`, `src/loop/tick.ts`, `src/loop/orchestrator.ts`, `src/state/transitions.ts`.
- Tests: `test/loop/prepare.test.ts`, `test/slice/prepare.test.ts` (real repository and processes), `test/state/transitions.test.ts`.
- With `prepareCommand` unset nothing changes.
- Not here: the failure count, the backoff and the block (task 84f); status fields, work loops, brief bullet and time budget (task 84e); the verifier's worktree (task 84d); README text.
- Release condition: with this change alone a command that always fails runs again on every tick; task 84f, in the same release, ends that.
- Not proven here: `pgrep -f` finding the label on Linux, where `/bin/sh` is another shell, shows only when the slice test runs there; without `pgrep` a command left by a crash is not found. Removal of a large ignored install tree, concurrent installs sharing a package cache, and whether a sandboxed worker can read an install linked outside the worktree are not measured.
