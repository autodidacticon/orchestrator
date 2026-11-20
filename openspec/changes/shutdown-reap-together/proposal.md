## Why

A reaping shutdown reaped the daemon's live launches one after another, and since #136 each reap waits for the launch's whole process group (SIGTERM, up to the kill grace of 2000 ms, SIGKILL, at most 1000 ms more). The whole shutdown runs under the daemon's 8 s deadline. A launch whose group outlives SIGTERM holds the loop for 2 to 3 s, so the deadline passed during the third or fourth such launch, or before the first when the shutdown first waited for a long check. The launches after it got no signal at all and kept running after the daemon was gone, against operator-control "Shutdown", which says a reaping shutdown SHALL terminate every live agent process (GH-163).

## What Changes

- `src/runner/subprocess.ts`: new exported `killTrees(pids, graceMs)`. It sends SIGTERM to every target before any wait, waits for all of them against one deadline of the kill grace, sends SIGKILL to every target still present and waits at most 1000 ms more. Each pid keeps `killTree`'s rules (dead pid skipped, group leader as a group, other pid alone, SIGKILL also to the group of a pid that leads none); a pid listed twice counts once; it never rejects. `killTree(pid, graceMs)` is `killTrees([pid], graceMs)`. `SubprocessRunner.reapAll` hands it the pids of its launches with its kill grace.
- `AgentRunner` gains the required `reapAll(launches)`: "SIGTERM to every launch, one grace, SIGKILL. Idempotent." `MultiRunner.reapAll` hands each kind's launches to that kind's runner, all kinds at the same time, skips a kind with no runner, waits until every call has settled and then rejects with the first error. `InprocRunner.reapAll` drops each launch from its alive set. `reapAll` joins `RUNNER_METHODS` in `src/state/gate.ts`.
- `Orchestrator.stop` with `reap`: after the tick in flight it takes the live launches no worker holds and, when there is one, calls `reapAll` once with all of them; then per launch, in listing order, it records the usage, moves the task as before and ends the launch `reaped`. The reap now comes before the waits for the prepare commands and the verifier job.
- Tests: `test/agents/term-agent.ts`, `test/runner/reap-all.test.ts`, `test/loop/shutdown-reap.test.ts`, `test/slice/shutdown-reap.test.ts`.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `operator-control`: ADDED "Shutdown: launches reaped together" and "Shutdown: reap before the verifier wait". "Shutdown" stays as written.
- `health-monitoring`: ADDED "Usage accounting: launches reaped together". "Usage accounting: reap waits for the process group" stays as written.

## Impact

- `src/runner/subprocess.ts`, `src/runner/runner.ts`, `src/runner/multi.ts`, `src/runner/inproc.ts`, `src/state/gate.ts`, `src/loop/orchestrator.ts`.
- A rejected `reapAll` now leaves every launch of that shutdown `live`; before, the launches reaped ahead of the rejected one were ended.
- Not changed: `SHUTDOWN_GRACE_MS` and its timer, the kill grace, the graceful shutdown, claimed launches, `killByLaunchId`, the tick's own reaps, `src/main.ts`, `src/loop/tick.ts`, `src/launch/prepare.ts`, `src/verify/**`, `src/operator/**`.
- Not proven: a long tick in flight is still awaited first; a check longer than the time left is still abandoned; that `claude`, `codex` or `opencode` exit on SIGTERM; the `shutdown` route with five launches (it reaches the same function as the signal).
