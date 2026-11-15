## Why

The review of CLOUD-M2 v1 (2026-11-13, ORC-85 at 82d0e1b) found, by reading the code, that the gentle lease expiry of `pull-lease-renewal` has gaps (ORC-90):

- `expireClaim` falls through to a failed attempt when the work-in-progress commit throws. A worker that holds `index.lock` when its lease expires makes `git add -A` fail, so the attempt is spent and the worktree removed, although the branch has commits that could be kept without any commit step.
- Startup recovery fails a claimed launch whose lease ran out while the daemon was down as `leaseExpired`, charged, with the worktree removed. The tick would have kept the branch.
- Any untracked file counts as progress (`status --untracked-files=all`). A check command that leaves an artefact turns an idle claim into a kept release, and the artefact is committed on the kept branch.
- The work loop stops renewing on the agent's `close`, not its `exit`. A grandchild that holds the stdout pipe keeps the lease alive until the silence limit.
- The claim response sends no `health` field, so the loop's silence limit always falls back to its 45-minute constant, while `pull-lease-renewal`'s design says it follows the daemon's `stuckFailAfterMs`.
- A spawned launch's brief carries the lease line, which does not apply to it: the tick renews its lease while its process lives.
- The Claude Code workflow test only string-matches `work.js`; nothing runs the path from the claimer's output to the worker prompt.

## What Changes

- **A failed work-in-progress commit keeps a branch with commits.** When `preserve` throws, the daemon reads the worktree head. If it is not the base sha, the expiry is a kept release at that head, without `wipCommit`. Otherwise it is a failed attempt, as before.
- **Recovery expires a claim as the tick does.** A `running` claimed launch whose lease ran out while the daemon was down goes through `expireClaim` at startup: kept with progress, failed without.
- **Untracked files are not expiry progress.** For a lease expiry, progress is a commit on the launch branch, a change to a tracked file, or a path the worker staged. An untracked file alone is not progress, and the work-in-progress commit leaves untracked files out (`git add -u`; staged paths are already in the index). A worker that wants a new file kept stages it. A release with `keep` is unchanged: the worker chose to keep, and everything is committed.
- **Renewal stops at the agent's exit.** The loop stops renewing when the agent process exits, unless the watcher is already ending its process group (then the loop holds the launch until the group is gone and releases it).
- **The claim states the silence limit.** The claim response carries `health: { stuckFailAfterMs }`. The loop uses it when positive, else its 45-minute default.
- **No lease line for a spawned launch.** `briefInput` leaves out `leaseTtlMs` in `spawn` mode, and a parked launch that `spawnDueLaunches` spawns has its worktree and brief prepared again, without the line, after it leaves `claimable`.
- **The workflow is run in a test.** A test runs `hosts/claude-code/workflows/work.js` with stub agents and checks that the claimed `leaseTtlMs` and `renewEveryMs` reach the worker prompt.

## Capabilities

### Modified Capabilities
- `pull-runner`: "Lease expiry" restates progress (no untracked files) and adds the failed-commit case; a new "Silence limit in the claim".
- `crash-recovery`: "Claim boundaries" expires an expired claim as the tick does; a new requirement states it with its scenarios.
- `agent-protocol`: new "No lease line for a spawned launch" and "Parked launch rebriefed before it is spawned".
- `host-integration`: "Work loop renews the lease" stops at the agent's exit.

This change modifies requirements that `pull-lease-renewal` adds ("Lease expiry", "Work loop renews the lease"). Archive `pull-lease-renewal` first.

## Impact

- Code:
  - `src/loop/orchestrator.ts`: `expireClaim` (untracked rule, failed-commit fallback), `briefInput` (no `leaseTtlMs` for a spawned launch), `claimResponse` (`health`).
  - `src/launch/recovery.ts`: an expired claim at startup calls `expireClaim`.
  - `src/loop/tick.ts`: `spawnDueLaunches` re-prepares a parked launch's worktree and brief before spawning it.
  - `src/workspace/workspace.ts`, `git-workspace.ts`, `git.ts`, `fake.ts`: `preserve(launch, { untracked })`, `dirtyFiles(worktree, { untracked })`. These four files are outside the task's listed scope; the rule cannot be applied without them.
  - `hosts/codex/bin/work.mjs`: renewal stops on `exit`; `silenceLimitMs` documentation.
- Tests: `test/loop/lease.test.ts`, `test/slice/claim-recovery.test.ts`, `test/host/work-loop.test.ts`.
- Behaviour change: a lease expiry whose only change is an untracked file is now a failed attempt; the ORC-85 slice test stages its file.
