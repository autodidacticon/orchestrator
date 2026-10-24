## Context

ORC-73 left two flakes "not reproduced". In the CODEX-M5/OPENCODE-M4 review, one of three sequential full runs without `--retry` at a094d2b failed at test/e2e/scripted.test.ts:75 with `AssertionError: expected undefined to be defined`. The task asked for a reproduction under load, the events before each failure, and a fix in code where the cause is in code.

## Codex work loop: "two loops drain…"

**Reproduction.** Six parallel `npx vitest run test/slice/codex-work.test.ts -t "two loops"` processes for five rounds at ffabcde: 3 of 30 failed. The test was instrumented to dump the event log and the loop's stderr on failure. There were two failure shapes:

- `expected '…' to match /stops: the run is finished/` (2 runs). The loop's stderr ends with
  ```
  cx-1: T2 codex exited (code 0) …
  cx-1: stops: nothing is claimable for codex and the run waits on a human
  cx-2: stops: nothing is claimable for codex and the run waits on a human
  ```
  The loops exited with code 0, but on the wrong rule.
- `waitFor timed out` after 90 s (1 run; this is the "90 s timeout" ORC-73 put down to load). The events (ms from the start) show:
  ```
  1016 transition T3 running→submitted   1053 transition T1 running→submitted
  1058/1099 launch.ended (reported)      1113 operator.claim cx-1, cx-2   (both 404)
  1201 T3 submitted→done                 1281 T1 submitted→done
  1315 T2 unstarted→running              1389 launch.claimable T2        … nothing more
  ```
  Both loops polled after their tasks were sealed and before the verifier published them. Each saw nothing claimable and nothing live, and stopped. T2, which depends on T1, was parked 280 ms later, and no loop was left to claim it.

**Cause: a defect in the loop's stop rule.** `stopVerdict` (hosts/codex/bin/work.mjs) stops a quiet loop when `openQuestions` or `awaitingReview` is non-empty, "a question or review waits on a human". `status.awaitingReview` is `q.awaitingReview`, every node in `submitted`, so it also holds tasks that are waiting for the verifier. The event digest already separates the two (`awaitingReview`: milestones; `verifying`: tasks), but the loop reads `status`. The same bug could stop a real run's loops whenever a check takes longer than one poll. Then nobody claims the dependents, or the retry after a red check.

**Fix.**
- `status` gains `verifying`, the submitted tasks, computed where the digest's list now comes from.
- In `stopVerdict` the run is not quiet while `verifying` is non-empty, because a check's result can make work claimable. Only an `awaitingReview` entry outside `verifying` counts as a review. An older daemon without `verifying` gets the old behaviour.
- The Claude Code workflow's claimer prompt had the same rule and gets the same change.

Known edge, left as is: when `needsConfig` names `checkCommand`, submitted tasks are held until the operator configures one. They stay in `verifying`, so the loop is never quiet and long-polls until the operator acts, where before it stopped on "waits on a human". A guard on `needsConfig` in `stopVerdict` would restore the stop. The task did not ask for it, and a waiting loop loses nothing.

Alternative rejected: making `status.awaitingReview` milestone-only, like the digest. That is the cleaner name, but it also changes `stalled`-adjacent consumers, test/loop/harness.ts `runToQuiet` (which stops on any `awaitingReview`), and the session-start hooks. Adding a field changes no existing consumer.

## Scripted restart: scripted.test.ts:75

**What :75 means.** The test starts the daemon and polls every 150 ms for 15 s, opening the store each time (`new SqliteStore`, swallowing every error), for a live launch's pid. `pid` stays undefined only if no launch was live at any poll for 15 s. Instrumented runs show the launch is normally live after 300–600 ms, even with six parallel copies and the full suite running. The agent (`slowSubmit:2500`) then stays live for at least 2.5 s. So a slow daemon or a missed window does not explain 15 s. Across 48 instrumented runs, no poll threw after the first successful open and no poll took more than 4 ms. That leaves a daemon that is not running.

**Cause: the daemon dies at startup when its store open races the test's.** This is the only test in the file whose poll opens the store without first checking that the file exists. Its first poll (about 150 ms) therefore lands near the daemon's own first open (about 100 ms from spawn, measured), and either side may create the file. `SqliteStore`'s constructor ran `PRAGMA journal_mode = WAL` before `PRAGMA busy_timeout`. Switching a new file to WAL needs an exclusive lock. When two connections open a new file together, both hold a shared lock and want the exclusive one, and SQLite returns `SQLITE_BUSY` from the switch *without calling the busy handler*, so as to avoid a deadlock. `src/main.ts:114` does not catch it, and the daemon exits.

Evidence:
- Three processes opening one new store at a common instant, 30 rounds: 88 of 90 opens threw `Error: database is locked`. With only the busy timeout moved first: 56 of 90, because the handler is not called on that path. With the retry below: 0 of 90.
- The real daemon started while a helper process (test/state/hold-new.ts) holds a new store in rollback-journal mode under an exclusive lock exits with code 1:
  ```
  ERROR fatal {"err":"Error: database is locked\n    at new SqliteStore (src/state/sqlite.ts:90:13)\n    at main (src/main.ts:114:17)"}
  ```
  With the fix it waits, then logs `listening` and admits T1 and T5.
- I tried three times to kill the daemon in the test's own shape, by polling the store from the test process at offsets around the daemon's measured first open. That gave 0 of 8, 0 of 8 and 0 of 20 deaths: the overlap window is a few milliseconds when the machine is idle, and it widens only under the I/O load of a full run. The diagnosis therefore rests on two things. First, the inference above: live in 0.3–0.6 s, live for at least 2.5 s, no store errors after the first open, so 15 s with no live launch means no daemon. Second, the deterministic held-lock reproduction.
- The test's failure dump never ran in the review, so the reviewer's failing run is not available. This mechanism is the only one found that holds a launch away from `live` for 15 s, and the test's poll is the only other process that opens the store at daemon startup.

**Fix in code.** `src/state/sqlite.ts` sets the busy timeout first, then runs the WAL switch and the schema through `execRetryingBusy`: it retries on an `SQLITE_BUSY` result code (`errcode & 0xff === 5`) with a 5→100 ms blocking backoff (`Atomics.wait`) until the same five seconds. That matches what the "Store transactions" requirement already promised: a connection that finds the database locked waits instead of failing at once. A real daemon meets the same race when an operator CLI command, the MCP server or a hook opens the store as the daemon starts.

**Test changes.** The wait now matches the assertions that follow it (a mid-task agent, alive after the stop):
- `livePid` waits through `run.waitUntil`, which opens the store only once the file exists, so the test never creates the store.
- It reads the pid from the persisted `launch.live` event instead of sampling `status: 'live'`.
- It throws at once with the daemon log if the daemon has exited.
- It then asserts that the launch is still live, with the task's events in the message.
- `slowSubmit` goes from 2500 to 4000 ms, so the stop happens well inside the task.
- The post-restart loop and the T9 wait use the same helpers.

## Evidence after the fix

- codex-work "two loops", 6 parallel × 5 rounds: 30 of 30 passed (before: 27 of 30).
- scripted "plain restart", 6 parallel × 5 rounds: 30 of 30 passed.
- New tests: test/state/sqlite.test.ts "opening a new store that another process is creating waits…" (fails with "database is locked" on the old constructor); test/loop/scenarios.test.ts `status.verifying`; `stopVerdict` cases in test/slice/codex-work.test.ts.
- Five consecutive sequential `npx vitest run` (no `--retry`): see the task report.
