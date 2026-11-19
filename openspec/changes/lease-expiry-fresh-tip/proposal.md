## Why

When a remote launch's lease expires, the tick reads the launch branch tip at origin to choose between a kept release and a `leaseExpired` failure. If the read does not settle within the tick's short wait, the expiry is skipped and the read stays cached. When the worker then renews its lease, nothing drops that read, and the next expiry acts on it: an old "no tip" fails an attempt whose work is on origin, and an old sha keeps the release at an out-of-date `carry.interrupted.headSha`, leaving later commits out of the next launch. A read for a launch that ends by report, release or cancel also stays cached forever (ORC-144, found in the CLOUD-M3 review).

## What Changes

- A tick's read of a branch tip is tagged with the lease's `expiresAt`. A cached read whose tag differs from the launch's current `expiresAt` is dropped and a new read started, so a read from before a lease renewal never decides a later expiry.
- Every end of a launch (`Orchestrator.endLaunch`) drops the launch branch's cached read.

## Capabilities

### Modified Capabilities

- `pull-runner`: "Lease expiry" says a read of the branch tip belongs to one lease expiry, a renewed lease starts a new read at the next expiry, and a launch's end drops its read; new scenario "Remote expiry after a renewed lease".

## Impact

- `src/workspace/origin.ts` (`branchTipFromTick` takes a tag), `src/loop/orchestrator.ts` (`expireRemoteClaim` passes the lease's `expiresAt`, `endLaunch` forgets the read).
- Tests in `test/slice/remote-release.test.ts`.
