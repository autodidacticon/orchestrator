## Why

ORC-94 (archived as `2026-11-15-suite-reliability`) met its criterion through "name the flaky test with its cause", but the review of CLOUD-M2 v2 found that one named cause does not hold and two flaky tests have no cause. The run's check command still uses `--retry 2`. This change finds each cause with a reproduction (a way to make the test fail on demand), fixes the tests, and names the product defects as proposals. No file under `src/` changes.

## The tests the suite-reliability notes name, and what was found

### `work-loop.test.ts` "the loop renews the lease of a silent agent ..." — corrected cause

The note (tasks.md 4.4) said: "Probable cause, not confirmed: `fingerprint` (`src/workspace/git-workspace.ts` 191-193) runs `git status` and `git diff-index` with `allowFail`, so a git call that fails while the release removes the worktree hashes empty output and is recorded as `worktree` progress."

That cannot happen for this test. Its worktree is clean, and empty `status` and `diff-index` output hashes exactly like a clean tree (both `01ba4719c80b6fe9`). A read that fails gives the baseline fingerprint, and one that runs after `.git` is gone throws, which `observeFingerprint` swallows.

**Cause found.** The fingerprint changes when a git call *succeeds* in a half-removed worktree:

1. A tick lists the claimed launch as live and calls `observeFingerprint`, whose git calls are awaited (`src/loop/tick.ts` 115).
2. Meanwhile the loop's release (`Orchestrator.release`, after the silence limit) ends the launch and removes its worktree.
3. `git worktree remove --force` deletes the worktree's entries in directory order. On this machine (APFS) that order is `.orchestrator shared.txt README.md .git`, so `.git` goes last. Between those unlinks, `git status` in the worktree succeeds and lists the tracked files as deleted. The head is unchanged and the hash is new.
4. `observeFingerprint` records that as a `worktree` signal through `recordSignal`, on the launch row that has already ended. `progressAt` moves to about the release time ("about 11s after the claim, near the release", as observed in ORC-94).

**Evidence.**

- Unlinking one tracked file with `.git` present gives the same head and a different hash.
- Sampling `GitWorkspace.fingerprint` in a loop during a real `GitWorkspace.remove` of a 3000-file worktree: 5 removals gave 11 samples with the same head and a different hash, 60 samples that threw, and 0 equal.
- With the slice's two-file worktree the window is microseconds: 30 removals gave 0 changed samples. This fits a failure seen once under load, and not at all in the recorded twenty runs.

**Reproduction.** Run with `ORCH_TEST_REPRO=silent-agent-progress`, which `injectRemovalRace` in `test/host/work-loop.test.ts` reads. It holds the first tick fingerprint of the claimed launch until the release has ended the launch and its removal is part way. Part way means the state `git worktree remove` passes through: `shared.txt` gone, `.git` present. The held read then runs, and the real removal follows.

With the old assertions the test fails every time:

```
expected 1794760564360 to be 1794760553134
❯ test/host/work-loop.test.ts:378  expect(first.progressAt).toBe(first.worker!.claimedAt)
```

That is 11.2 s after the claim.

**Fix in the test.** The test now checks what the release decided, which the race cannot change:

- the `launch.released` payload has `progressed: false` and `kept: false`;
- `attempts` is 0;
- `progressAt` and `lastSignal`, read from the launch row as it stood when the release began removing the worktree (`rowsAtRemoval`), are the claim's.

Under the reproduction, the test also checks that the race took place: the final row's `lastSignal` is `worktree`. It passes both with and without the reproduction.

**Product defect (proposal, not fixed here).** `observeFingerprint` and `recordSignal` (`src/health/progress.ts`) write a progress signal to a launch that ended while the git calls ran. `renewLease` is guarded by lease ownership, so the lease is not affected. The ended row's `progressAt`/`lastSignal` are wrong, though, and a `launch.unstuck` event can be appended for an ended launch. Proposed fix: re-read the launch after the await and drop the signal unless it is still live.

### `crash.test.ts` "crash at launch.afterSpawn then restart converges"

The note named the unawaited worktree removal on publish. ORC-94-p1 (`2026-11-15-await-worktree-removal`) showed two causes and fixed both in `src/`:

- the removal racing `git worktree add`;
- a submit accepted for a launch revoked during its seal.

Its reproductions are in `test/slice/worktree-removal.test.ts`. "a published task whose agent is still live has no worktree at the end of the tick that marks it done" fails when the removal is not awaited. "a pre-crash agent submitting while recovery revokes and relaunches is refused, ..." runs a real `recover()` that revokes and relaunches mid-seal, and fails without the re-check. On this tree all ten tests of that file pass. The crash test passed 20 of 20 at `591efdf` and in every run of the series below.

### `work-loop.test.ts` "past --max-silence-ms ..." and `crash.test.ts` "crash at tick.afterPhase1 then restart converges" — cause unknown

Both were seen once, as timeouts, in the original ORC-94 measurement: the first at its then 90 s test timeout, the second at `waitTerminal(90_000)`. Neither has been reproduced.

What was tried:

- 20 targeted runs of the two tests, together with "cascade crash at tick.afterPhase1" and "pull-mode crash at tick.afterPhase1" (`-t "past --max-silence-ms|crash at tick.afterPhase1 then restart"`, `ORCH_TEST_PG=off`). The first runs had a full suite running alongside. All 80 test runs passed. "past --max-silence-ms" normally takes about 11.5 s and "crash at tick.afterPhase1" about 2.2 s.
- Two full-suite sweeps with the agent exit delayed by 1500 ms and 400 ms (below).
- The 20-run series below.

None of these failed the two tests in a way that matches the original timeouts. The cause is recorded as **unknown**. What is known:

- The work-loop test's inner bounded waits (30 s + 40 s, plus the loop's 20 s idle exit) could exceed its old 90 s timeout. ORC-94 raised it to 150 s.
- A timeout of the crash test is no longer masked by `ENOTEMPTY` (ORC-94 4.1). A recurrence now reports its real state: worktrees left, tags missing, and (this change) launches not ended.

## Found while measuring

### `launch.test.ts` "commitAndSubmit: worktree created and removed, branch retained, task done, launch ended"

The first baseline run of this task failed here (`expected 'live' to be 'ended'`, Postgres mode). An experiment was loading the machine at the time.

**Cause.** A task can reach `done` before its agent process has exited. Within `health.reportGraceMs` (30 s by default), a tick leaves a reported launch `live` while its process is alive (`src/loop/tick.ts` 101). The test read the launch row right after the task became `done`.

**Reproduction.** `ORCH_TEST_AGENT_EXIT_DELAY_MS=1500`: the scripted agent (`test/agents/scripted.ts`) stays alive that long after its behaviour. The test then fails the same way every time.

**Fix.** The test waits for the launch to end and its worktree to go, and checks `endReason: reported`.

**Same race in other tests.** A full suite under `ORCH_TEST_AGENT_EXIT_DELAY_MS=400` found it in two more places, both fixed in the tests:

- "recovery: stray worktree is swept" planted its stray while the launch was still live, and recovery rightly keeps a live launch's worktree. The test now also waits for the launch to end.
- In the crash suite, 15 tests (the spawn-mode `verify.*`, `milestone.afterTag` and `tick.*` points, and the whole cascade scenario) stopped the daemon with a reported launch still `live`, and the invariant `liveLaunches == 0` failed. The crash harness's `waitTerminal` now also waits until no launch is `preparing`, `launching` or `live`. Its timeout message lists those launches. In the cascade scenario, which ticks only on wake every 30 s, such a run takes about 40 s instead of about 11 s, within its 180 s timeout.

With the fixes, `launch.test.ts` and `crash.test.ts` pass 63 of 63 under `ORCH_TEST_AGENT_EXIT_DELAY_MS=400`.

**Product defect (proposal, not fixed here), `codex.test.ts` "composes the shim registration, ...".** It fails under the 400 ms delay. Since ORC-94-p1, the publish removes the worktree of a launch that is still live (one attempt per tick). The fake codex, still running after its report, then fails to write `.orchestrator/last-message.txt` (`ENOENT`) and prints no `turn.completed`. A real codex that writes its last message into the worktree after its report call could hit the same thing. The test is left as it is. With no injected delay it passed in every run of the series below.

### `operator-mcp.test.ts` "records the tracker at import and drives the outbox: ..." — found by the measurement

The first measurement series on this change (at `4df56ad`) failed once: `ORCH_TEST_PG=off` run 10, all other 19 runs green. The import answered `{ status: 200, accepted: false }` at `test/slice/operator-mcp.test.ts` 452, with no rejection reasons.

**Cause.** Two reloads of the graph file can overlap: the daemon's tick (`loadGraph` at `src/loop/tick.ts` 25, every 150 ms in this test) and the import route's own reload (`writeGraphAndReload`, `src/operator/routes.ts` 91). `FileGraphSource.poll` (`src/graph/source.ts` 43-52) stores `lastMtime` after its `stat` and before it reads the file. If the tick's poll takes the new mtime first, the route's poll then sees an unchanged mtime and `lastRev === knownRev`, and returns nothing. In this test no graph is active yet, so both are `undefined`. The route then answers by comparing the active rev with the written one, finds no graph or the old one, and says `accepted: false` with no reasons. The tick's reload makes the written graph active a moment later. The same overlap can also answer an incompatible import as `accepted: false` with no reasons, if the tick's reload rejected it.

**Reproduction.** `test/slice/import-reload-race.test.ts` runs the route in process with a file graph source. Under `ORCH_TEST_REPRO=import-reload-race` it starts `orch.loadGraph()` just before the route's poll, and lets that reload record the new mtime before the route polls. The written graph becomes active, the route answers `accepted: false` with no reasons, and the test fails (6 of 6 runs). Without the variable it passes. The operator MCP test itself runs the daemon as a child process, so the injection sits at the route, the same code path the MCP `import_graph` and `import_issues` tools reach over HTTP.

**Fix in the test.** `operator-mcp.test.ts` imports through `importAdopted`. An answer of `accepted: false` with no reasons counts as accepted only once the status tool's `graphRev` equals the answer's `rev`, within 5 s. An answer with reasons stays a rejection. Its five import calls use it.

**Product defect (proposal, not fixed here).** The import route's answer can contradict what the daemon adopted. Proposed fix: serialize `loadGraph` (a reload waits for one in flight), or have `FileGraphSource.poll` record `lastMtime` and `lastRev` together after the read. Then the route's answer reflects its own write.

### `toolchain/compose.test.ts` "the subprocess runner fills the slot from its getter at spawn and runs a slot-less command verbatim" — found by the measurement

The second series (at `ae2d347`) failed once here, in `ORCH_TEST_PG=required` run 4: `expected '' to be 'Bash(docker:*)'`.

**Cause, in the test.** The spawned command is `echo ... > file`. The shell creates the file for the redirect before `echo` writes to it. The test's `waitForFile` returned as soon as the file existed, so a read in that gap got an empty file. No product code is involved.

**Reproduction.** `ORCH_TEST_REPRO=compose-partial-read` rewrites the test's commands to `{ sleep 0.3; echo ...; } > file`, which holds the gap open. With the old wait the test fails every time (3 of 3, `expected '' to be 'Bash(git:*) Bash(npm test:*)'`).

**Fix in the test.** `waitForFile` waits for the newline `echo` ends with. The same exists-only wait was in `test/runner/codex.test.ts` (an `echo > out.txt`) and `test/runner/opencode.test.ts` (the launch log, which the runner opens at spawn before the fake writes to it). Neither was seen failing. Both waits now also wait for the content: the newline, or the expected text.

## What Changes

- `test/host/work-loop.test.ts`: `rowsAtRemoval`; `injectRemovalRace` under `ORCH_TEST_REPRO=silent-agent-progress`; the silent-agent assertions as above.
- `test/agents/scripted.ts`: `ORCH_TEST_AGENT_EXIT_DELAY_MS`.
- `test/slice/launch.test.ts`: the two waits above.
- `test/crash/harness.ts`: `waitTerminal` waits for every launch to end.
- `test/slice/import-reload-race.test.ts` (new): the import route answered while another reload runs, with `ORCH_TEST_REPRO=import-reload-race`.
- `test/slice/operator-mcp.test.ts`: `importAdopted` for its five imports.
- `test/toolchain/compose.test.ts`, `test/runner/codex.test.ts`, `test/runner/opencode.test.ts`: file waits that wait for the content, not only the file; `ORCH_TEST_REPRO=compose-partial-read` in the first.
- The completion report gives the measurement: 10 consecutive full runs without `--retry` with `ORCH_TEST_PG=required` and 10 with `ORCH_TEST_PG=off`. It is in tasks.md 4.

## Capabilities

### New Capabilities

### Modified Capabilities
- `health-monitoring`: adds "Suite reproductions of progress and report-grace races" (test-only knobs and what the affected tests assert).
- `graph-import`: adds "Suite reproduction of an import racing a reload".

## Impact

- Tests only: `test/host/work-loop.test.ts`, `test/agents/scripted.ts`, `test/slice/launch.test.ts`, `test/crash/harness.ts`, `test/slice/operator-mcp.test.ts`, `test/slice/import-reload-race.test.ts`, `test/toolchain/compose.test.ts`, `test/runner/codex.test.ts`, `test/runner/opencode.test.ts`. No change under `src/`.
- Proposals reported with the task: drop progress signals for a launch that ended during the fingerprint read; keep a live reported launch's worktree until its process exits (or make the codex last-message path survive its removal); make the import route's answer agree with the reload it caused.
- The suite-reliability note for "renews the lease of a silent agent" (archived tasks.md 4.4) is corrected here, not in the archive.
