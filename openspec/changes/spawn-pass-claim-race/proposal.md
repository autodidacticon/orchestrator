## Why

The review of CLOUD-M2 v2 (ORC-96) found two faults in the mixed-mode spawn pass (`spawnDueLaunches` in `src/loop/tick.ts`), by reading the code:

- The pass lists the `claimable` launches once and then awaits `remove`, `prepare` and `spawnLaunch` for each one. A worker's claim can land on a later launch in the list during one of those awaits. The pass still holds the old row, so it writes `launching` over the claim, removes the worktree the worker is using, prepares it again and spawns a second agent. The lease check does not catch this, because a claim keeps the launch id.
- The pass sets `launching` before any await. If `workspace.remove` returns false, or if `workspace.prepare` or `spawnLaunch` throws, the launch stays `launching` with no process. Only a daemon restart ends it, when recovery revokes it.

## What Changes

- For each launch, the pass reads the row and the task again just before it moves the launch to `launching`. The read and the write happen in one synchronous store transaction, the same way the claim does its select and write. A launch that has been claimed, or that is no longer the task's running lease, is skipped.
- A removal that returns false is treated as a failure. The pass does not prepare over a worktree that is still there.
- If the removal, the prepare or the spawn fails, the launch is ended with `endReason: spawnFailed`, the stage and the error. If the launch is still the task's running lease, the task's attempt fails with `exitedWithoutReport` (detail `spawnFailed: true` and the stage) under the charged `deadOrExpired` trigger. The task is then retried with a new launch, or blocked once its attempts are used up. The failure is charged, so a failure that keeps repeating cannot loop forever without cost. A half-started process is then killed by launch id, and the worktree is removed. If the worktree cannot be removed, it joins the pending removals that later ticks retry.
- Admission's launch start handles failures the same way. The failed task goes back to `unstarted`, and admission in the same tick launches it again through `prepareLaunch`. If that prepare also throws, or a spawn in `spawn` mode throws, the error used to end the tick and leave the task `running` on a `preparing` or `launching` row. Now the launch is ended and the attempt is failed, as above. Under a prepare that always fails, the task ends in `blocked` instead of hanging until a restart. A throw before the launch row exists (the integration head unreadable) still propagates and leaves the task unstarted.

## Capabilities

### New Capabilities

### Modified Capabilities
- `pull-runner`: adds "Spawn pass reads each launch before it spawns it", "Failed spawn of a parked launch", "Failed spawn fails the attempt", "Failed launch at admission" and "Cleanup after a failed spawn".

## Impact

- `src/loop/tick.ts` (`spawnDueLaunches`, new `abandonSpawn` and `launchOrAbandon`), `test/loop/modes.test.ts`.
- The failure uses the existing `exitedWithoutReport` kind and the charged `deadOrExpired` trigger, because no new failure kind is added. This differs from recovery's uncharged `failUnpreparable`. Recovery runs once per start, but this path runs on every tick, so an uncharged failure here could loop without end.
- One gap remains: recovery's own relaunch of a revoked `preparing` or `launching` launch (`startLaunch` in `recover`) can still throw at startup when its prepare fails. Recovery is out of scope here.
