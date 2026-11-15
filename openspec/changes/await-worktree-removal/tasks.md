## 1. Serialize worktree commands

- [x] 1.1 `withWorktreeLock(repo, fn)` in `src/workspace/git.ts`: one promise chain per clone, keyed by real path; a rejection releases the next command
- [x] 1.2 `worktreeAdd`, `worktreeAddDetached`, `worktreeList`, `worktreeRemove` and the new `worktreeReattach` (prune, `branch -f`, add for a re-prepared launch) take it; `GitWorkspace.prepare` uses `worktreeReattach` in place of raw git calls

## 2. Confirmed removal

- [x] 2.1 `worktreeRemove`: `remove --force`, delete the directory, `prune`, then confirm the path is neither on disk nor listed; up to three attempts; never throws; returns whether it is gone
- [x] 2.2 `Workspace.remove(launch, opts?)` resolves to `false` when the worktree is left behind; `FakeWorkspace.failRemovals` scripts failures

## 3. Publish path

- [x] 3.1 `drainVerification` is async and awaited by `runTick`; each applied job's launch worktree removal is awaited (one attempt for a live launch)
- [x] 3.2 A left-behind worktree joins `Orchestrator.pendingRemovals`, retried at the start of every `drainVerification`; `startVerifierIfIdle` runs even if applying throws

- [x] 3.3 For a job whose task is now `done`, also remove the worktrees of the task's other ended or revoked launches still on disk
- [x] 3.4 `handleReport` re-authenticates and re-checks the lease inside the transaction after `sealSubmission` (401 revoked, 409 lease moved)

## 4. Startup recovery

- [x] 4.1 After the registered-worktree sweep, remove the existing worktree directory of every ended or revoked launch whose task is done; a failure joins `pendingRemovals`

## 5. Tests

- [x] 5.1 `test/slice/worktree-removal.test.ts`: lock ordering across path spellings; concurrent remove and add; stale registration and orphan directory; worktree gone at the end of the publishing tick (fails when the removal is not awaited); retry of a left-behind worktree; recovery removes an unregistered and a registered worktree of a done task (fails without the new recovery step); a submit revoked or re-leased during its seal is refused, including through a real `recover()` that revokes and relaunches mid-seal (all fail without 3.4); a failed attempt's left-behind worktree removed at publish (fails without 3.3)
- [x] 5.2 `crash at launch.afterSpawn then restart converges` passes 20 consecutive runs without `--retry`
