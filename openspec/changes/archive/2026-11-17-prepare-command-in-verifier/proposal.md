## Why

After `prepare-command` (ORC-130, task 84c) a launch worktree has its dependencies installed, but the verifier's temporary worktree has none, so the check command must still install them itself. ORC-133 (release 0.6.0, task 84d) runs the prepare command in the verifier's worktree immediately before the check command.

## What Changes

- `GitVerifierOptions` gains `prepareCommand?` and `prepareTimeoutMs?` (600000 when unset). `src/main.ts` passes the two file keys to the backend; they are read once.
- In `run`, after the rebase, the declared no-op test and the missing-check-command test, the verifier runs the prepare command through `runCheck` in the temporary worktree with the check command's environment and `closeWaitMs: 2000`, and no label or abort signal.
- A non-zero or null exit fails the job as `checkFailed` (`prepare command exited <code>`); a timeout as `checkTimeout` (`prepare command exceeded <ms>ms`). The check does not run, an attempt is spent, and the job's output is the message, a newline and the command's output tail.
- No failure count, backoff, block or clean test for the verifier's prepare command.

## Capabilities

### New Capabilities

### Modified Capabilities
- `integration-pipeline`: ADDED "Prepare command before the check". It names "Check and verified tree" and "Check environment" and modifies neither.

## Impact

- Code: `src/verify/verifier.ts` (`GitVerifierOptions` and `run`), `src/main.ts` (two lines in the backend literal).
- Tests: `test/slice/verifier.test.ts` (six new cases, each building its own backend with the config key unset).
- With `prepareCommand` unset nothing changes.
- Not proven: the `src/main.ts` wiring is shown by the diff only. `stop()` waits for the verifier job, so a stop can now wait `prepareTimeoutMs` plus 2000 ms plus the check's time; an install left running after the shutdown grace has no label and is not found at the next start (the check command has the same limit). The cost of one install per verification and whether a real package manager's install serves the test run are not measured.
