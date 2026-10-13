## MODIFIED Requirements

### Requirement: Transition table enforcement
The system SHALL permit exactly the transitions below and MUST reject any other transition with an error naming the current and requested status.

| From | To | Whose intent | Trigger |
|---|---|---|---|
| unstarted | blocked | orchestrator | brief validation failed, or a remediation candidate awaits review |
| unstarted | running | orchestrator | ready, brief valid, slot admitted; launch created |
| running | submitted | agent | submit report accepted and sealed |
| running | failed | agent | fail report |
| running | blocked | agent | block delivered through the fallback file after exit |
| running | waiting | agent | block through the long-poll |
| running | failed | orchestrator | process dead without a report, lease expired, or a claimed launch released after progress |
| running | unstarted | orchestrator | claimed launch released without progress |
| waiting | running | orchestrator | answer persisted and a slot admitted |
| waiting | blocked | orchestrator | maxWait elapsed or process dead |
| submitted | done | verifier | published |
| submitted | failed | verifier | checks red, undeclared empty diff, missing acceptance evidence, or integration cap hit |
| submitted | unstarted | verifier | rebase conflict under the cap |
| failed | unstarted | orchestrator | attempts below maxAttempts |
| failed | blocked | orchestrator | attempts exhausted |
| blocked | unstarted | human | unblock or answer |
| done or cancelled | unstarted | human | reopen or uncancel when revocable |
| running, waiting, submitted, or done | unstarted | human | cascade reopen of an upstream node |
| any non-terminal | cancelled | human | cancel |
| milestone unstarted | done | orchestrator | closure satisfied, not gated |
| milestone unstarted | submitted | orchestrator | closure satisfied, gated |
| milestone submitted | done | human | accept |
| milestone submitted | blocked | human | reject |
| milestone done or submitted | unstarted | orchestrator | milestone reset: upstream reopened, or deps changed on reload |

#### Scenario: Listed transition is applied
- **WHEN** a task is `failed` with attempts below the maximum and the orchestrator requests `unstarted`
- **THEN** the transition is applied

#### Scenario: Unlisted transition is rejected
- **WHEN** a transition from `unstarted` directly to `done` is requested for a task
- **THEN** the transition is rejected and the overlay is unchanged

#### Scenario: Milestone never runs
- **WHEN** a transition to `running` is requested for a milestone
- **THEN** the transition is rejected

#### Scenario: Cascade row applies to a running dependent
- **WHEN** T2 is `running` and a human cascades a reopen of T1 with trigger `cascade`
- **THEN** T2 becomes `unstarted` and its lease is cleared

#### Scenario: Milestone reset row
- **WHEN** MVP is `done` and the orchestrator requests `unstarted` with trigger `milestoneReset`
- **THEN** the transition is applied, and the same request by an agent is rejected

#### Scenario: Release without progress returns to unstarted
- **WHEN** a claimed launch is released before any progress was observed
- **THEN** the orchestrator applies `running -> unstarted` with `attempts` unchanged and the lease cleared

## ADDED Requirements

### Requirement: Claimable launches
In `pull` and `mixed` modes a launch SHALL be parked as `claimable` once its worktree and brief exist. The task SHALL be `running` from the moment the launch row exists and SHALL hold a run slot while parked, so that the number of parked launches is bounded by `capacity`. The lease of a parked launch SHALL NOT expire; its TTL SHALL start at the claim, when `claimedAt` and `expiresAt` are set and `spawnedAt` stays unset. A claimed launch's lease SHALL be renewed by any API call under its token, by observed worktree progress, and at admission when the task resumes from `waiting`. An expired lease on a claimed launch SHALL follow the existing failure path: `failed` with reason `leaseExpired`, `attempts` increased, the worktree swept, and a new launch prepared while attempts remain. `launches` SHALL increase by one for every launch row, claimed or spawned.

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
