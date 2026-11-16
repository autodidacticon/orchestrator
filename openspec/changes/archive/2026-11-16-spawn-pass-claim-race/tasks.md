## 1. Claim race

- [x] 1.1 `spawnDueLaunches` reads each listed launch and its task again, and moves it to `launching` in the same store transaction only while it is still `claimable` and still the task's running lease
- [x] 1.2 Test (`test/loop/modes.test.ts`): hold the first launch's prepare open, claim the second, and assert that the second stays live with its worker, without a pid, without a remove or prepare, with an unchanged brief, and with no second agent

## 2. Failed spawn

- [x] 2.1 A removal that returns false, a prepare that throws, or a spawn that throws ends the launch with `spawnFailed`, the stage and the error, and fails the attempt (charged) when the launch still holds the task's running lease
- [x] 2.2 After the store work, the pass kills by launch id and removes the worktree, best effort; a worktree left behind joins the pending removals
- [x] 2.3 Tests: a one-shot failing prepare leaves no `launching` row, ends the launch with its reason and launches the task again, and the new launch is spawned after its window; a failing removal does not prepare over the worktree

- [x] 2.4 Admission's launch start (`launchOrAbandon`) ends a launch whose prepare or spawn threw and fails the attempt, rather than letting the error end the tick
- [x] 2.5 Tests: a prepare that always fails ends `blocked` with no `preparing` or `launching` row and no tick that throws; a spawn that throws (mixed pass and spawn-mode admission) ends the launch at stage `spawn` and launches the task again

## 3. Checks

- [x] 3.1 `openspec validate spawn-pass-claim-race --strict`
- [x] 3.2 `npm test` green without `--retry`
