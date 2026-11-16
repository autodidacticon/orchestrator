## 1. Silent-agent lease test

- [x] 1.1 Check the archived cause against the code: empty `status`/`diff-index` output hashes like a clean tree, so a failing git call cannot change the fingerprint
- [x] 1.2 Find the cause: a fingerprint read that succeeds in a worktree `git worktree remove` has half deleted (tracked files gone, `.git` last), recorded by `observeFingerprint` on the ended launch
- [x] 1.3 Reproduce it on demand: `ORCH_TEST_REPRO=silent-agent-progress` (`injectRemovalRace`); with the old assertions the test fails every time (`progressAt` 11.2 s after the claim)
- [x] 1.4 Fix the test: assert the release's `progressed: false`, `attempts` 0, and the row at removal (`rowsAtRemoval`)
- [x] 1.5 Report the product defect (signal recorded on an ended launch) as a proposal

## 2. Report-grace race

- [x] 2.1 `ORCH_TEST_AGENT_EXIT_DELAY_MS` in `test/agents/scripted.ts`; "commitAndSubmit: worktree created and removed ..." fails every time at 1500 ms
- [x] 2.2 Fix `launch.test.ts` "commitAndSubmit ..." and "recovery: stray worktree is swept" to wait for the launch to end
- [x] 2.3 Crash harness `waitTerminal` waits for no unended launch; `launch.test.ts` and `crash.test.ts` pass 63 of 63 at 400 ms
- [x] 2.4 Report the codex slice failure at 400 ms (worktree removed under a live reported launch) as a proposal

## 3. Other named tests

- [x] 3.1 `crash at launch.afterSpawn then restart converges`: cite the ORC-94-p1 reproductions in `test/slice/worktree-removal.test.ts` (10 of 10 pass on this tree)
- [x] 3.2 "past --max-silence-ms" and "crash at tick.afterPhase1": 20 targeted runs (80 test runs, the first ones beside a full suite) and two delayed-exit sweeps did not reproduce them; cause recorded as unknown

## 4. Measurement

- [x] 4.1 Ten consecutive full runs without `--retry` with `ORCH_TEST_PG=required` and ten with `ORCH_TEST_PG=off`, one run at a time, on the final commit; counts and any failed run with its test in the completion report
- [x] 4.2 First series, at `4df56ad` (sections 1 to 3 only): `required` 10 of 10 green (891 passed, 16 skipped, no skip line); `off` 9 of 10 green (831 passed, 76 skipped, one skip line each). Run 10 of `off` failed in `operator-mcp.test.ts` "records the tracker at import and drives the outbox: ..." (`accepted: false`), which led to section 5. The series was then run again on the commit with section 5.

## 5. Import answered while a reload runs

- [x] 5.1 Cause: the daemon's tick and the import route both reload the graph file; `FileGraphSource.poll` stores `lastMtime` before it reads, so the poll that comes second returns nothing and the route answers `accepted: false` with no reasons, while the other reload adopts the graph
- [x] 5.2 Reproduce it on demand: `test/slice/import-reload-race.test.ts` with `ORCH_TEST_REPRO=import-reload-race` fails 6 of 6 runs; passes without it
- [x] 5.3 Fix the test: `importAdopted` in `operator-mcp.test.ts` judges a reasonless `accepted: false` by the status tool's `graphRev`
- [x] 5.4 Report the product defect (the import answer can contradict the adopted graph) as a proposal
- [x] 5.5 Second series, at `ae2d347`: `required` runs 1 to 3 green (892 passed); run 4 failed in `toolchain/compose.test.ts` "the subprocess runner fills the slot ..." (`expected '' to be 'Bash(docker:*)'`), which led to section 6. The series was run again on the commit with section 6.

## 6. File read before it was written

- [x] 6.1 Cause, in the test: the shell creates the `>` target before `echo` writes; `waitForFile` returned once the file existed
- [x] 6.2 Reproduce it on demand: `ORCH_TEST_REPRO=compose-partial-read` holds `echo` 300 ms after the file is created; with the old wait the test fails 3 of 3
- [x] 6.3 Fix the test: wait for the written line; the same wait fixed in `codex.test.ts` and `opencode.test.ts` (not seen failing)
- [x] 6.4 Final series, at `9379bcd` (sections 1 to 6), one full `npx vitest run` at a time with no `--retry`: `ORCH_TEST_PG=required` 10 of 10 green (each 94 files passed, 6 skipped; 892 tests passed, 16 skipped; 163 to 177 s); then `ORCH_TEST_PG=off` 10 of 10 green (each 92 files passed, 8 skipped; 832 tests passed, 76 skipped; 157 to 196 s). No run failed.
