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
| running | failed | orchestrator | process dead without a report, lease expired, or a claimed launch released after progress without keep |
| running | unstarted | orchestrator | claimed launch released without progress, or released with keep after progress |
| waiting | running | orchestrator | answer persisted and a slot admitted |
| waiting | blocked | orchestrator | maxWait elapsed, process dead, or a claimed launch released |
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

#### Scenario: Kept release after progress returns to unstarted
- **WHEN** a claimed launch with commits is released with `keep`
- **THEN** the orchestrator applies `running -> unstarted` with trigger `released`, `attempts` unchanged, the lease cleared, and `carry.interrupted` set

### Requirement: Counters
`launches` SHALL increase by one for every spawned process and SHALL never be reset; it names the branch `task/<id>/l<launches>` and the worktree. `attempts` SHALL increase by one when a launch ends in `failed` by the agent's fail report, by process death without a report, by lease expiry, or by a verifier red check or cap hit, and SHALL NOT increase on daemon-caused relaunch, on integration conflict, or on a release with `keep`. `integrationRetries` SHALL increase by one on each rebase conflict. `interruptions` SHALL increase by one on every release with `keep` that stores an `interrupted` context and SHALL be reset to zero when the task submits. `attempts` and `integrationRetries` SHALL be reset to zero on human unblock, reopen, and uncancel, and on every node reset by a cascade reopen.

#### Scenario: Conflict does not spend an attempt
- **WHEN** a submitted task hits a rebase conflict under the cap
- **THEN** `integrationRetries` is one, `attempts` is unchanged, and `launches` increases when the task is relaunched

#### Scenario: Unblock resets budgets
- **WHEN** a human unblocks a task that had two attempts and one integration retry
- **THEN** both counters are zero and `launches` is unchanged

#### Scenario: Cascade resets budgets
- **WHEN** T2 had one attempt and one integration retry and is reset by a cascade reopen of T1
- **THEN** T2's `attempts` and `integrationRetries` are zero and its `launches` is unchanged

#### Scenario: Kept release does not spend an attempt
- **WHEN** a claimed launch on its second attempt is released with `keep` after progress and `maxAttempts` is 2
- **THEN** `attempts` stays at one, `interruptions` is one, the task is `unstarted`, and `launches` increases when it is relaunched

#### Scenario: Interruptions reset on submit
- **WHEN** a task with `interruptions` 2 submits
- **THEN** `interruptions` is zero
