## ADDED Requirements

### Requirement: Suite reproduction of the half-removed worktree read
The test suite SHALL reproduce on demand, without product code changes, a tick fingerprint read of a released launch's worktree that `git worktree remove` has deleted part way. The silent-agent work-loop test SHALL take the absence of progress from the release's decision and the launch row at removal, not from the row read afterwards.

#### Scenario: Silent-agent progress race on demand
- **WHEN** the work-loop test "the loop renews the lease of a silent agent" runs with `ORCH_TEST_REPRO=silent-agent-progress`, which holds the tick's fingerprint read until the release has ended the launch and removed a tracked file with `.git` still present
- **THEN** the ended launch's row afterwards has `lastSignal: worktree`, and the test still passes, because `launch.released` has `progressed: false` and the row at removal has `progressAt` equal to the claim time

### Requirement: Suite reproduction of an agent alive after its report
The scripted test agent SHALL stay alive `ORCH_TEST_AGENT_EXIT_DELAY_MS` milliseconds after its behaviour when that variable is set. A test that checks a launch's end or its worktree after its task is `done` SHALL first wait for the launch to end. The crash harness's `waitTerminal` SHALL also wait until no launch is `preparing`, `launching` or `live`.

#### Scenario: Reported agent still running
- **WHEN** `test/slice/launch.test.ts` and `test/crash/crash.test.ts` run with `ORCH_TEST_AGENT_EXIT_DELAY_MS=400`
- **THEN** every test in them passes, the crash invariant `liveLaunches == 0` included
