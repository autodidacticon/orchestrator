## 1. Postgres for the tests

- [x] 1.1 `test/setup/postgres.ts` (vitest `globalSetup`): decide the source once per run (`TEST_DATABASE_URL` checked with one connection, else one `initdb`/`pg_ctl` cluster, else none) and `provide` it to the test files
- [x] 1.2 `ORCH_TEST_PG`: `auto`, `off`, `required`; any other value fails the run; `required` without Postgres fails the run; a run without Postgres prints one line naming the reason
- [x] 1.3 The cluster is started in the main process; teardown stops it; a detached watchdog whose stdin is a pipe from the main process stops it and removes its directory when the pipe closes (teardown, or the main process killed); a synchronous `exit` handler as a further fallback
- [x] 1.4 `test/state/pg-db.ts` reads the provided source with `inject`; on the cluster each test file gets its own database (`CREATE DATABASE ... TEMPLATE template0`), dropped by `stopTestPostgres`
- [x] 1.5 `deployment-identity.test.ts` no longer prints its own skip line

## 2. Signals

- [x] 2.1 `store-selection.test.ts` "a stalled server ..." (SIGSTOP of the backend pid) runs only on the run's own cluster, like its slice twin
- [x] 2.2 `work-loop.test.ts` kills a hung fake only when `ps` shows its command line under the test's own directory; the orphan grandchild is a `node -e` carrying the marker path, not `sleep`

## 3. Randomized journal test

- [x] 3.1 The fuzz writes `verifier_jobs` (create, update), `proposals` (create, update) and `payload_overlays`
- [x] 3.2 Each randomized run asserts that its accepted batches wrote every table in `TABLES`

## 4. Load-dependent failures

- [x] 4.1 Crash harness `cleanup` is async: it kills its daemons and workers, waits for them to exit, waits (without signalling) for the agents the daemon spawned, and removes the directory with retries, so `ENOTEMPTY` no longer replaces the test's real error
- [x] 4.2 The hung-agent work-loop tests get a 150s timeout: their bounded inner waits (30s + 40s + the loop's 20s idle exit) no longer exceed the test timeout
- [x] 4.3 Races found by running two full suites at once (no `--retry`), each fixed in the test:
  - `launch.test.ts` "recovery: stray worktree is swept" planted its stray before the done task's worktree was removed (`git worktree add`: already exists); it now waits for the removal
  - `crash.test.ts` cascade crash points: a tick still running when the point was armed could crash before the reopen arrived (T1 then published once, not twice). The test now arms only after the daemon log has been quiet for 1.5s (this scenario ticks only on wake, so a restarted daemon's startup ticks are over by then). It restarts and re-arms, up to five times, until the reopen is recorded before the crash
  - The crash harness's `waitTerminal` returned as soon as the states were terminal, but `drainVerification` removes a done task's worktree without awaiting it (`src/loop/tick.ts` 235-237), and the milestone tag lands after the submitted transition. A stop right after could find no tag (`e2e` "milestone tag"). It now also waits for no launch worktree and every submitted milestone's tag; on timeout it names each leftover worktree's launch row, files and pid-log lines
  - `slice/harness.ts` `cleanup` removed its directory while a reaped agent still wrote into it (`ENOTEMPTY`, seen in "missing acceptance evidence fails the submission"); it now waits up to 3s for the agents in its pid log to exit. It then kills any still alive whose `ps` command line lies under the harness directory: a relaunch its own in-process orchestrator spawned around the stop outlives the reap. Finally it retries the removal for up to 15s
- [x] 4.4 Named, not fixed (causes in `src/`, outside this change):
  - `crash.test.ts` "crash at launch.afterSpawn then restart converges": timed out about once in 40 targeted runs under load in the first attempt. In the recorded twenty runs (4.6) it failed in two of ten runs without Postgres (runs 2 and 3) and in none with Postgres, both times in the first form below: T1's agent submitted after the restart, T1 was published, and its worktree (`.git` present, launch ended `exited`) was never removed. `waitTerminal` now requires every launch worktree to be gone, so this leak, which the earlier harness did not look for, fails the test. After the crash, T1 runs twice (the orphaned first agent and a second launch). The removal of a done task's worktree on publish (`src/loop/tick.ts` 235-237) is not awaited, swallows errors and is never retried. It runs `git worktree remove --force` and `git worktree prune` alongside the next tick's `git worktree add`. Seen two ways: the first launch's full worktree (`.git` present) is never removed, or T2's `git worktree add` fails (`tick failed`) and T2 stays running with no launch
  - `work-loop.test.ts` "the loop renews the lease of a silent agent ...": once in the first attempt's runs (not in the recorded twenty), `progressAt` moved about 11s after the claim, near the release. Probable cause, not confirmed: `fingerprint` (`src/workspace/git-workspace.ts` 191-193) runs `git status` and `git diff-index` with `allowFail`, so a git call that fails while the release removes the worktree hashes empty output and is recorded as `worktree` progress
- [x] 4.5 Not reproduced in any of these runs (the recorded twenty included), cause not established: the work-loop "past --max-silence-ms" timeout and the 90s `crash at tick.afterPhase1` timeout of the original measurement. The work-loop tests' timeouts were raised and the crash harness no longer masks a timeout with `ENOTEMPTY`
- [x] 4.6 Ten consecutive full runs without `--retry`, with and without Postgres, one run at a time, at c38720a: with Postgres (one cluster per run) all ten green, 836 passed and 16 skipped each, no skip line; with `ORCH_TEST_PG=off` eight green (780 passed, 72 skipped, one `postgres: the Postgres suites are skipped (ORCH_TEST_PG=off)` line each), runs 2 and 3 failed only in `crash at launch.afterSpawn then restart converges` (4.4)
