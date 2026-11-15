## Context

The verifier publishes by compare-and-swap on the clone's `refs/heads/<branch>`. With the clone moving to an emptyDir (ORC-20), origin must hold every publication and milestone tag, and must be what the daemon compares against. Humans may also push to origin. This design covers how the clone, origin and the store stay consistent across lost leases, network failures and a kill at any point.

## Goals / Non-Goals

**Goals:**
- Origin's integration branch holds every published trailer commit, in the same first-parent order as the clone.
- A push lost to someone else's commit never loses either commit.
- A kill between the local swap and the push is finished at recovery, exactly once.
- With `git.pushIntegration` off, nothing contacts a remote.

**Non-Goals:**
- Pushing task branches (`task/<id>/l<n>`).
- Reconciling a clone that diverged from origin by hand edits.
- The Kubernetes wiring (ORC-20).

## Decisions

### One `Origin` per daemon, serialized
`Origin` wraps the remote and runs fetch and push calls through one promise chain. The workspace fetches from `integrationHead` every tick (throttled by `git.fetchIntervalMs`) and the verifier fetches every job. Without the chain they could race for the tracking ref's lock. The `Orchestrator` constructor creates the instance from config and calls an optional `useOrigin` on the workspace and verifier it was given. That keeps the gated method set and `main.ts` unchanged.

### Local swap, then push with a lease; undo on failure
The order the brief asks for is kept: `update-ref` CAS on the clone, then `crashPoint('verify.afterPublish')`, then `git push --force-with-lease=refs/heads/<b>:<expectedHead> origin <squash>:refs/heads/<b>`. Any push failure undoes the local swap (CAS squash back to expectedHead) and returns `requeue`. This covers both a lost lease and an unreachable origin. So the clone is never left ahead of origin except by a kill, and recovery handles a kill. After a successful push the tracking ref is set to the squash explicitly, so base selection sees the publication without another fetch. The existing crash point is reused as the kill point between swap and push, so the crash matrix needs no new point.

### Start every job from origin
`run` fetches, then continues as below. A failed fetch requeues the job, with the reason on the `verify.requeued` event and in the log. A missing remote (`OriginConfigError`) fails the job instead, naming `git.originUrl`.
1. If the launch trailer is already on origin, a push landed but its answer was lost. Fast-forward and return `published` at that commit.
2. Otherwise compare the clone with origin:
   - behind: fast-forward the clone and the primary worktree;
   - ahead, or origin has no branch: push the clone's head with a lease (the first run after turning pushing on, when earlier publications exist only in the clone);
   - diverged: fail the job with a message naming both shas.

Diverged is not reset automatically: the clone may hold published work, and a reset would drop it silently. Origin's head becomes `expectedHead`.

### Recovery checks origin first
`recoverPublishing` fetches, then:
1. If the trailer is on origin, the job is `published`.
2. If the trailer is only in the clone, at the job's `squashSha`, and origin is still at the job's `expectedHead`, push once with that lease and return `published`.
3. Otherwise undo the swap if the squash is still the tip, and requeue.

A second recovery finds the trailer on origin and pushes nothing, which gives exactly once. If origin is unreachable at recovery the job is requeued. When origin is back, the next run either finds the landed trailer (step 1 of the run) or republishes.

### Base selection and the milestone pin read origin
`integrationHead` returns origin's tracking head, or the clone's head while the clone is strictly ahead (unpushed publications), so a base always contains every published dependency. A failed fetch keeps the last observed head and is not retried before the interval. While the verifier's push is in flight (`Origin.inFlight`), the clone's swapped head is not used as a base, since its lease may still fail.

### Foreign commits
With origin, a commit is foreign when it is in the clone, absent from origin and not before the baseline (`<b> ^<baseline> ^origin/<b>`), and lacks the launch trailer. Human commits on origin are expected. A commit made in the clone stays flagged until the next job pushes the clone's head; the clone is not a place for work.

### Milestone tags
`tagMilestone` creates the local tag idempotently and pushes it without force; a tag origin already holds at the same sha is a no-op. The push outcome (`TagPushResult`: pushed, failed, or conflict) is returned, never thrown, so the unchanged recovery path that re-tags a submitted milestone cannot fail on a remote error. `tagged:` records the local tag as before; `tagPushed:` records the push. When pushing is on, phase 3 tolerates a failed push. `pushMilestoneTags` retries every tick for gated milestones in `submitted` or `done` whose `tagPushed:<id>:<v>` marker is missing, so an accepted milestone still gets its tag. A tag on origin at another sha raises `TagConflictError`; it is recorded once (`tagPushed` = `conflict:<sha>`, event `milestone.tagConflict`, error log) and never moved or retried. Existing runs that already have `tagged:` markers are pushed on the first tick, because the new marker is separate.

## Risks / Trade-offs

- [A remote that cannot be reached requeues the job every tick] → Accepted: each attempt is one fetch, no attempt is spent, and the job publishes when origin returns.
- [A diverged clone fails the job and spends an attempt] → A loud failure is preferred to silently dropping published work. The message tells the operator to reconcile.
- [A tag conflict needs a human] → Reported once by event and log; the tag is never moved.
- [Tests use a bare repository on disk rather than the in-cluster git-daemon fixture] → The behaviour under test is git's push and lease semantics, which are the same over `file://`. `deploy/` is out of this task's scope; ORC-20 exercises the in-cluster origin.
