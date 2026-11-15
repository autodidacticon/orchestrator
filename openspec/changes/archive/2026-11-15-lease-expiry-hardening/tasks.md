## 1. Expiry

- [x] 1.1 `expireClaim`: on a throw from `preserve`, read the head; keep the branch at it when it is not the base sha
- [x] 1.2 `preserve(launch, { untracked: false })` for a lease expiry: untracked files are neither progress nor committed; staged paths are
- [x] 1.3 Recovery: an expired claimed launch at startup goes through `expireClaim`

## 2. Work loop and claim

- [x] 2.1 `work.mjs`: renewal stops at the agent's `exit` unless the watcher is ending the group
- [x] 2.2 Claim response carries `health: { stuckFailAfterMs }`

## 3. Brief

- [x] 3.1 `briefInput` leaves out `leaseTtlMs` in `spawn` mode and for a launch in `launching`
- [x] 3.2 `spawnDueLaunches` moves a parked launch to `launching`, then re-prepares its worktree and brief before spawning it

## 4. Tests

- [x] 4.1 Fake workspace: failed WIP commit with and without commits; untracked-only expiry; claim `health`; lease line by mode (`test/loop/lease.test.ts`)
- [x] 4.2 Real git: `index.lock` held at expiry; untracked-only; staged file kept and untracked left out; expiry at startup kept and failed (`test/slice/claim-recovery.test.ts`)
- [x] 4.3 Work loop: an agent that exits leaving a grandchild on its stdout loses the lease, not the silence limit; the Claude Code workflow run with stub agents (`test/host/work-loop.test.ts`)
- [x] 4.4 `npm test` green without `--retry`
