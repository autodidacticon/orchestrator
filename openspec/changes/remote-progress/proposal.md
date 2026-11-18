## Why

A remote worker (ORC-11, ORC-22) works in its own clone, so the daemon cannot read its tree. Before this change the reconcile step fingerprinted a remote launch through `RemoteWorkspace.fingerprint`, a constant, so a remote launch showed progress only when its agent called the API. An agent silent through one long step (a build, a test suite) let the lease lapse and lost the launch (ORC-85), and the daemon could not tell a remote agent that commits from one that is stuck (ORC-26, cloud-native M3).

## What Changes

- Reconcile (`observeFingerprint` in `src/health/progress.ts`) does not call `Workspace.fingerprint` for a remote launch.
- A heartbeat body may carry `fingerprint`: the clone's head sha, a colon and a hex hash. For a remote launch, a changed value is a progress signal of kind `commit` when the head changed, else `worktree`, and it is stored on the row. The first value is a baseline, and the same value again records nothing. Such a heartbeat is progress only through its fingerprint, or through a new `progress` text, so the loop's periodic heartbeats renew the lease without hiding a stuck agent. A malformed value is answered 400 naming `fingerprint`. For a local launch `fingerprint` is ignored.
- Stuck detection is unchanged and works on the stored remote fingerprint.
- The worker loop (`orchestrator-worker`) heartbeats every `lease.renewEveryMs` (a third of `leaseTtlMs`) from the claim until the agent exits. Each heartbeat carries the clone's fingerprint, computed by the function `GitWorkspace.fingerprint` uses (`treeFingerprint` in the new `src/workspace/fingerprint.ts`). A heartbeat answered 401 stops the heartbeats for that launch.

## Capabilities

### New Capabilities

None. `worker-pool` is introduced by the unarchived change `worker-loop`; this change adds a requirement to it.

### Modified Capabilities

- `health-monitoring`: "Progress signals" covers remote launches and the heartbeat `fingerprint`.
- `worker-pool`: new requirement "Loop heartbeat" (the heartbeat cadence).

## Impact

- `src/workspace/fingerprint.ts` (new: `treeFingerprint`, `FINGERPRINT_PATTERN`), `src/workspace/git-workspace.ts` (`fingerprint` delegates to it), `src/health/progress.ts` (`applyFingerprint`; remote skip in `observeFingerprint`), `src/loop/orchestrator.ts` (`recordProgress`, `heartbeatFingerprintError`), `src/worker/loop.ts` (`startLoopHeartbeat`, `heartbeatEveryMs`, `cloneFingerprint`, the `schedule` and `scriptedIdleMs` deps), `src/worker/scripted.ts` (`idleMs`).
- Tests: `test/health/progress.test.ts`, `test/worker/heartbeat.test.ts`. `test/slice/harness.ts` `makeSlice` takes a `clock`.
