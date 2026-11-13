## MODIFIED Requirements

### Requirement: Claimable launches
In `pull` and `mixed` modes a launch SHALL be parked as `claimable` once its worktree and brief exist. The task SHALL be `running` from the moment the launch row exists and SHALL hold a run slot while parked, so that the number of parked launches is bounded by `capacity`. The lease of a parked launch SHALL NOT expire; its TTL SHALL start at the claim, when `claimedAt` and `expiresAt` are set and `spawnedAt` stays unset. A claimed launch's lease SHALL be renewed by any API call under its token, by observed worktree progress, at admission when the task resumes from `waiting`, and by its work loop's renewal (see specs/pull-runner "Lease renewal by the work loop"), which is not progress. An expired lease on a claimed launch whose worktree shows progress since the claim SHALL be a kept release while the task's kept releases are under `daemon.maxKeptReleases`: `unstarted` with `attempts` unchanged and the branch kept (see specs/pull-runner "Lease expiry"). Otherwise it SHALL follow the existing failure path: `failed` with reason `leaseExpired`, `attempts` increased, the worktree swept, and a new launch prepared while attempts remain. `launches` SHALL increase by one for every launch row, claimed or spawned.

#### Scenario: Parked launch holds a slot
- **WHEN** capacity is 2 and two launches are parked
- **THEN** no third task is admitted until one of them ends

#### Scenario: Parked launch does not expire
- **WHEN** a launch stays parked for longer than the lease TTL
- **THEN** it is still `claimable` and its task is still `running`

#### Scenario: Abandoned claim fails the attempt
- **WHEN** a worker claims a launch and then makes no API call and no worktree change for longer than the lease TTL
- **THEN** the task is `failed` with reason `leaseExpired`, `attempts` is one, the worktree is removed, and a new claimable launch is prepared

#### Scenario: Resume renews the lease
- **WHEN** a claimed launch's task has been `waiting` for longer than the lease TTL and is answered and admitted
- **THEN** its lease expires `leaseTtlMs` after the admission, not before
