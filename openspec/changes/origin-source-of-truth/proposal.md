## Why

ORC-20 moves the daemon's clone to an emptyDir, so anything that must outlive a pod deletion has to reach origin first. Today nothing is pushed. Published commits, task branches and milestone tags exist only in the daemon's clone, and the verifier compares and swaps against the clone's own ref. This change (ORC-21, moved into M2 on 2026-11-12) makes origin the source of truth for the integration branch when `git.pushIntegration` is on, and leaves the laptop default untouched.

## What Changes

- New config block `git`:
  - `originUrl` (optional): the clone's `origin` remote is added or re-pointed to it.
  - `pushIntegration` (default `false`): the switch for everything below.
  - `fetchIntervalMs` (default 30 s): how often base selection and milestone pinning may fetch.
- New `src/workspace/origin.ts` (`Origin`): one per daemon, shared by the workspace and the verifier, so fetches and pushes run one at a time. It fetches `+refs/heads/<branch>:refs/remotes/origin/<branch>`, pushes with `--force-with-lease`, pushes tags without force, and raises `TagConflictError` when origin already holds a tag at another sha.
- `GitVerifierBackend.run` fetches first and brings the clone to origin before it observes `expectedHead`:
  - behind: fast-forward;
  - ahead: push the clone's publications;
  - diverged: fail the job.
- A launch whose trailer is already on origin is published as found. After the local compare-and-swap, the squash is pushed with `--force-with-lease=refs/heads/<branch>:<expectedHead>`. A rejected or failed push undoes the local swap and requeues.
- `recoverPublishing` looks for the launch trailer on origin first. A trailer only in the clone is pushed once with the job's lease. A lost lease undoes the swap and requeues.
- `foreignCommits` considers only commits in the clone that origin lacks, so human commits that arrive on origin are expected.
- `GitWorkspace.integrationHead` reads origin's head, or the clone's head while the clone holds publications origin has not received. `tagMilestone` pushes the tag.
- The tick retries a milestone tag push every tick for submitted and accepted gated milestones until it lands. Progress is recorded as `tagPushed:<id>:<v>`, and a conflicting tag is reported once as `milestone.tagConflict`.
- The `Orchestrator` constructor builds the `Origin` from config and hands it to the workspace and the verifier (`useOrigin`), so `main.ts` and the harnesses need no change.

## Capabilities

### New Capabilities

### Modified Capabilities
- `integration-pipeline`:
  - New requirement "Origin as source of truth".
  - "Repository layout", "Base selection", "Compare-and-swap publication", "Foreign commit detection" and "Milestone tagging" now say what changes when `git.pushIntegration` is on.
- `crash-recovery`: "Recovery per boundary" resolves a `publishing` job against origin first and finishes an interrupted push.

## Impact

- Code:
  - New: `src/workspace/origin.ts`.
  - Changed: `src/verify/verifier.ts`, `src/workspace/git-workspace.ts`, `src/config.ts` (`git` block), `src/loop/orchestrator.ts` (constructor wiring, requeue reason in the event and log), `src/verify/job.ts` (`requeue` carries an optional reason), `src/workspace/workspace.ts` (`tagMilestone` returns a `TagPushResult`) and `src/loop/tick.ts` (`pushMilestoneTags`, recorded tag push outcome in phase 3).
- Tests: new `test/slice/origin.test.ts`, run against a bare origin fixture.
- Default off: with `git.pushIntegration` false no `Origin` exists, no git command names a remote, and behaviour is byte-for-byte the previous one.
- Task branches are not pushed. That is left to a follow-up if ORC-20 needs them to survive a pod deletion.
