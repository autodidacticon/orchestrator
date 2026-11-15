## Why

The review of CLOUD-M2 v1 (2026-11-13, ORC-21 at 4ee804d) found four ways an unhealthy origin hurts a run with `git.pushIntegration` on (ORC-89):

- Recovery while origin is unreachable requeued a `publishing` job and left its squash at the clone's tip. A later job pushed that squash as a catch-up, then rebased the same task's sealed branch onto it. A branch that edits one file twice conflicted, and the task ran again although its work was on origin. If origin moved meanwhile, the clone diverged and every later job failed as `checkFailed`.
- `pushBranch` returned false for every failure, so a lost lease, a refusal and an outage looked the same. The job was requeued and checked again on every tick, with no backoff and no limit. A push that origin always refuses reran the check command forever, and the task stayed `submitted`.
- Remote git commands had no timeout. A stalled fetch or push held `Origin`'s queue, and the tick waited behind it (base selection and the milestone tag push).
- A milestone tag that the clone already held at another sha (one that `git clone` brought from origin) made `tagMilestone` throw. `pushMilestoneTags` then threw on every tick before admission, and `recover` threw at start.

The catch-up push also published trailer-less commits made by hand in the clone, after which they were no longer reported as foreign.

## What Changes

- New settings `git.remoteTimeoutMs` (default 120000), `git.pushRefusalLimit` (default 5) and `git.pushRetryBackoffMs` (default 30000).
- Every git command that talks to origin (fetch, push, `ls-remote`) runs in its own process group and is killed with its helpers after `git.remoteTimeoutMs`. While a remote command is queued or running, base selection keeps the last fetched head and the milestone tag push waits for a later tick, so the tick never waits behind origin.
- A failed push is classified from git's output as a lost lease, a refusal, or an unreachable origin. A lost lease requeues at once, as before. A refusal or an unreachable origin (a failed fetch at the start of a job included) requeues after a backoff that doubles per retry, up to 32 times the base. Refusals are counted per job in the store's key-value table. At `git.pushRefusalLimit` the task is blocked with kind `pushRefused` and the refusal's text, through a new `submitted -> blocked` row (actor verifier, trigger `pushRefused`), and no attempt is spent. An unreachable origin is never counted.
- Publishing recovery that cannot confirm the push (origin unreachable, lease lost, refused) undoes the local swap when the job's squash is still the clone's tip. A push that did land is found later by its trailer on origin.
- The catch-up push sends only publications: commits with a launch trailer, or commits older than the baseline. A trailer-less commit made in the clone is never pushed and stays foreign; the job counts it as a refusal, naming the commits. If the job's own squash is at the clone's tip, the catch-up publishes it as the job's publication instead of rebasing the branch onto it.
- `tagMilestone` never throws. A tag that the clone holds at another sha is a conflict (`where: clone`) and is not pushed. The tick, `pushMilestoneTags` and recovery all record a conflict through one path: one `milestone.tagConflict` event, and `tagPushed:<id>:<v>` set to `conflict:<sha>`.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `integration-pipeline`: bounded remote commands, classified push failures with backoff and a refusal limit, a catch-up push that sends publications only, and milestone tag conflicts that never throw.
- `crash-recovery`: publishing recovery while origin is unreachable.
- `task-lifecycle`: the `submitted -> blocked` row and the `pushRefused` blocked kind. The MODIFIED "Transition table enforcement" block is written on top of the unarchived `store-selection` change's version of the table (with its `worktreeLost` and `commitLost` rows). Archive `store-selection` first.

## Impact

- Code: `src/workspace/git.ts`, `src/workspace/origin.ts`, `src/workspace/git-workspace.ts`, `src/workspace/workspace.ts`, `src/verify/verifier.ts`, `src/verify/job.ts`, new `src/verify/push-retry.ts`, `src/loop/tick.ts`, `src/loop/orchestrator.ts` (Origin settings, the requeue branch, and the backoff filter only), `src/launch/recovery.ts`, `src/config.ts`, `src/state/transitions.ts`, `src/state/status.ts`.
- Tests: new `test/slice/origin-failures.test.ts`, and a `twoCommitsOneFile` scripted behavior. `test/slice/verifier.test.ts` now expects a tag conflict to be returned, not thrown.
- `pushRefused` is not offered to agents: the agent-facing block enums are unchanged.
- With `git.pushIntegration` off, only the tag change applies.
