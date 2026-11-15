## Why

`drainVerification` (src/loop/tick.ts) started `git worktree remove --force` and `prune` for a published task's launch without awaiting it, swallowed every error and never retried. The removal raced the same tick's phase 4, where the next launch runs `git worktree add` in the same clone, and the verifier's own temporary worktree commands. A `prune` or `remove` overlapping an `add` can fail the add or leave the first worktree behind, and nothing ever removed it afterwards. ORC-94 named this as the cause of `crash at launch.afterSpawn then restart converges` failing about 1 in 10 runs without `--retry`. With the removal awaited, that test still failed once in 20 runs, from a second cause (the submit fence below), so both are fixed here.

## What Changes

- Every `git worktree` command of the daemon (launch add, re-attach, remove, prune, list, and the verifier's temporary worktrees) runs under one per-clone lock, keyed by the clone's real path, so no two overlap.
- Removing a worktree is `remove --force`, then deleting the directory, then `prune`, and is confirmed: the path is neither on disk nor registered. Up to three attempts; it never throws and reports whether the worktree is gone.
- `drainVerification` is async and awaits the removal of each applied job's launch worktree. A worktree left behind joins a pending set that the next tick retries until it is gone. A launch that is still live gets one attempt per tick, since its agent may still be in the directory.
- When a job's task is now `done`, the tick also removes the worktrees of the task's other ended or revoked launches still on disk.
- Fencing across the submit's seal. A run of the 20-run series failed after the drain fix: the pre-crash agent's submit passed authentication, and recovery revoked its launch and relaunched the task while the submit was sealing. The submit was then accepted for the revoked launch, because after the seal only `status == running` was re-checked. The relaunched agent got 409 and exited, and its worktree was kept, since its task was `submitted`. The publish removed only the job's launch worktree. `handleReport` now re-authenticates and re-checks the lease inside the recording transaction: a revoked launch gets 401, and a moved lease gets 409.
- Startup recovery, after the registered-worktree sweep, removes the worktree directory of every ended or revoked launch whose task is `done`, including a directory git no longer lists.

## Capabilities

### New Capabilities

### Modified Capabilities
- `integration-pipeline`: adds "Worktree commands are serialized per clone" and "Worktree removal on publish".
- `crash-recovery`: adds "Worktrees of done tasks removed at startup"; modifies "Fencing" (a submit re-checks its launch and lease after sealing).

## Impact

- `src/workspace/git.ts` (`withWorktreeLock`, `worktreeReattach`, confirmed `worktreeRemove`), `src/workspace/git-workspace.ts`, `src/workspace/workspace.ts` (`remove` resolves to `false` when the worktree is left behind; `RemoveOptions`), `src/workspace/fake.ts` (`failRemovals`), `src/loop/tick.ts`, `src/loop/orchestrator.ts` (`pendingRemovals`), `src/launch/recovery.ts`.
- Tests: `test/slice/worktree-removal.test.ts`; a comment in `test/crash/harness.ts`.
