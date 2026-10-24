## Context

Four tests failed intermittently in full runs without `--retry` and passed alone (OPENCODE-M3 review, 2026-10-19). The task asked to diagnose the ENG-2 double launch in test/slice/import.test.ts first, and to decide whether it is a test or a scheduler issue.

## Diagnosis: the ENG-2 double launch

Reproduction: six parallel `npx vitest run test/slice/import.test.ts` processes, repeated, gave 4 failures in 30 runs at e6a1c45. The test was instrumented to dump ENG-2's events and its first launch's log on failure. Every failure showed the same sequence:

```
transition unstarted→running (admitted)   launch.created attempt 1   launch.live
launch.failed { charged: true }           transition running→failed (deadOrExpired)
transition failed→unstarted (retry)       launch.created attempt 2   … done
```

and the first launch's log:

```
fatal: Unable to create '<repo>/.git/worktrees/<launchId>/index.lock': File exists.
Another git process seems to be running in this repository, or the lock file may be stale
Error: Command failed: git commit -q -m ENG-2: ENG-2.txt
```

One run showed `['ENG-2','ENG-4','ENG-3','ENG-4']`, the same death on ENG-4, so nothing is specific to ENG-2 or to scopes.

The agent's `git commit` lost the worktree's index lock to the daemon. Each tick computes the progress fingerprint of every live launch (`GitWorkspace.fingerprint`: `git status --porcelain` and `git diff HEAD` in the worktree). Both commands opportunistically refresh the index and write it back, taking `index.lock` for that moment. The slice harness ticks every 60 ms, and under load the window is wide enough for the agent's commit to hit it. The scripted agent does not retry a failed commit, so it exits without a report; the daemon records `exitedWithoutReport`, charges the attempt, and relaunches.

**The scheduler is correct.** `admit` ran the right tasks in the right order every time; the second `launch.created` is a legitimate retry after a death. No change to `src/loop/schedule.ts`.

**The daemon has a bug.** A real agent can hit the same lock: Claude Code usually retries a failed commit, but a scripted or less tolerant worker dies, and a daemon-side seal (`commit: daemon`) racing the same tick's fingerprint can fail the same way.

## Decision

Set `GIT_OPTIONAL_LOCKS=0` in the base environment of the daemon's git wrapper (`src/workspace/git.ts`). Git documents this variable as disabling exactly the optional locks taken by read-only commands such as `status`; commands that write still lock. Setting it once in the wrapper covers the fingerprint, `dirtyFiles`, and any later observer, and costs only the index refresh. That refresh is a cache, and the agent's own git commands do it.

Alternatives rejected:
- Setting the variable only in the test environment (`vitest.config.ts` `test.env`). The tests would pass and the production race would stay.
- Passing `--no-optional-locks` per call. That works, but every new read-only call site has to remember it.
- Making the scripted agent retry its commit. That hides the race from the tests only.

`src/workspace/git.ts` is outside the task's listed scope. The defect is there, and the acceptance criterion asks for a code fix where the cause is a daemon bug rather than a test problem.

## The other three tests

- test/slice/verifier.test.ts "the check runs with an isolated ORCH_HOME": the wait condition `done || attempts >= 1` is also satisfied by the charged death above (attempt 1 dies on the commit race, attempt 2 starts), and the test then asserted `done` while T1 was running. The wait now ends when T1 is `done` or its first verifier job is `failed`/`conflict`, which is the outcome the assertions distinguish. A red check still fails fast.
- test/slice/codex-work.test.ts "two loops drain…" and test/e2e/scripted.test.ts restart adoption: not reproduced. After the fix, neither failed in 8 runs each (four parallel processes × 2 rounds) or in the five full sequential runs below. Their failures were not captured, so the cause is not established. The index-lock race may contribute: in the e2e test the agent commits in a fingerprinted worktree, and a death there would produce the second launch the restart test rejects. In the codex test the daemon seals under `commit: daemon`, and that seal may meet a fingerprint in the same process. The codex test's reported 90 s timeout may also be plain load. Since nothing failed, their waits and timeouts are unchanged. If either recurs, the next step is to dump its events and launch log on failure, as was done for the import slice.

## Evidence

- Import slice, six parallel processes × 6 rounds over import + verifier slices after the fix: 0 failures (before: 4 of 30 import-only runs failed).
- Codex work-loop slice + e2e scripted, four parallel × 2 rounds: 0 failures.
- Full suite `npx vitest run` (no `--retry`), 5 consecutive sequential runs on the development machine after the fix: all 5 exited 0. Before the fix, one baseline run also passed, but the import slice alone failed 4 of 30 times under parallel load.
