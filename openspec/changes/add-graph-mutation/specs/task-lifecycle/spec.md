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
| running | failed | orchestrator | process dead without a report, or lease expired |
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

### Requirement: Counters
`launches` SHALL increase by one for every spawned process and SHALL never be reset; it names the branch `task/<id>/l<launches>` and the worktree. `attempts` SHALL increase by one when a launch ends in `failed` by the agent's fail report, by process death without a report, by lease expiry, or by a verifier red check or cap hit, and SHALL NOT increase on daemon-caused relaunch or on integration conflict. `integrationRetries` SHALL increase by one on each rebase conflict. `attempts` and `integrationRetries` SHALL be reset to zero on human unblock, reopen, and uncancel, and on every node reset by a cascade reopen.

#### Scenario: Conflict does not spend an attempt
- **WHEN** a submitted task hits a rebase conflict under the cap
- **THEN** `integrationRetries` is one, `attempts` is unchanged, and `launches` increases when the task is relaunched

#### Scenario: Unblock resets budgets
- **WHEN** a human unblocks a task that had two attempts and one integration retry
- **THEN** both counters are zero and `launches` is unchanged

#### Scenario: Cascade resets budgets
- **WHEN** T2 had one attempt and one integration retry and is reset by a cascade reopen of T1
- **THEN** T2's `attempts` and `integrationRetries` are zero and its `launches` is unchanged

### Requirement: Reopen guard
A `done` or `cancelled` node SHALL be revocable only when no non-milestone dependent reachable through any chain of milestones is started, where started means `running`, `waiting`, `submitted`, or `done`. Milestone dependents SHALL never block a reopen. Reopen and uncancel SHALL reset `attempts` and `integrationRetries`, SHALL NOT reset `launches`, SHALL store a revision context for the next brief when the node has a prior launch, and SHALL reset every `done` or `submitted` milestone downstream of the node. There SHALL be no flag that skips the guard silently; the escape hatch is `reopen` with `cascade`, which returns its plan.

#### Scenario: Reopen refused while a dependent runs
- **WHEN** T1 is done and T2, which depends on T1, is running
- **THEN** reopening T1 is rejected with a reason naming T2

#### Scenario: Reopen allowed after the dependent fails
- **WHEN** T1 is done and every dependent is `unstarted`, `failed`, `blocked`, or `cancelled`
- **THEN** reopening T1 succeeds and T1 is `unstarted` with budgets reset

#### Scenario: Done milestone does not guard its constituents
- **WHEN** MVP is done, T3 is a direct dependency of MVP, and nothing else depends on T3 or on MVP
- **THEN** reopening T3 succeeds, T3 is `unstarted`, and MVP is `unstarted` with a `milestone.reset` event naming T3 as the upstream

#### Scenario: Started task behind a milestone still guards
- **WHEN** MVP is done, T3 is a direct dependency of MVP, and T8, which depends on MVP, is running
- **THEN** reopening T3 is rejected with a reason naming T8 and not MVP

### Requirement: Milestone review
A human SHALL accept a `submitted` milestone only against its pinned `integrationSha` and `reviewVersion`. Rejecting a milestone SHALL move it to `blocked` with reason `milestoneRejected` and the reviewer's note, and the orchestrator SHALL NOT retry it. After repair, a human unblock SHALL return it to `unstarted`, and it SHALL be resubmitted as a new review version only when its dependencies are satisfied again. An acceptance SHALL NOT survive the reopening of a task in the milestone's closure: the milestone reset discards it and the milestone SHALL be reviewed again at its next version.

#### Scenario: Reject then repair then accept
- **WHEN** MVP is rejected, a new task T7 is added as a dependency of MVP, MVP is unblocked, and T7 is done
- **THEN** MVP is `submitted` with `reviewVersion` 2 and a new `integrationSha`, and accepting it records that sha and version

#### Scenario: Rejection does not loop
- **WHEN** MVP is rejected and nothing else changes
- **THEN** MVP stays `blocked` across subsequent ticks

#### Scenario: Accepted milestone is reviewed again after an upstream reopen
- **WHEN** MVP was accepted at version 1 and T3 in its closure is reopened and done again
- **THEN** MVP is `submitted` at version 2 with the new integration head pinned, and accepting it against version 1 is refused as stale

## ADDED Requirements

### Requirement: Milestone reset
When a task is reopened, uncancelled, or reset by cascade, every milestone reachable downstream from it whose status is `done` or `submitted` SHALL transition to `unstarted` with the event `milestone.reset` carrying the reason `upstreamReopened`, the upstream task, the status it left, and its `reviewVersion`. A reload that changes a done or submitted milestone's `deps` SHALL reset it the same way with reason `depsChanged`. A reset SHALL retain `reviewVersion` and every existing tag, SHALL clear `accepted` and `integrationSha`, and for a submitted milestone SHALL drop the pending review so that `accept` and `reject` against the old version fail. A `blocked` milestone SHALL NOT be reset. When a reset milestone becomes due again it SHALL complete as before: `done` when not gated, and `submitted` with `reviewVersion` incremented and the tag `milestone/<id>/v<reviewVersion>` created at the newly pinned head when gated.

#### Scenario: Submitted milestone drops its review
- **WHEN** MVP is `submitted` at version 1 and T4 in its closure is reopened
- **THEN** MVP is `unstarted`, `awaitingReview` no longer lists it, and accepting MVP at version 1 is refused

#### Scenario: Accepted milestone resets and resubmits at the next version
- **WHEN** MVP was accepted at version 1 with tag `milestone/MVP/v1`, T3 is reopened, and T3 is published again
- **THEN** MVP passed through `unstarted` with `accepted` cleared, is `submitted` at version 2 with `integrationSha` at the new head, tag `milestone/MVP/v2` exists, and tag `milestone/MVP/v1` still points at its original sha

#### Scenario: Automatic milestone resets and completes again
- **WHEN** M1 is a non-gated done milestone over T1 and T1 is reopened and published again
- **THEN** M1 is `unstarted` after the reopen and `done` again in the tick that publishes T1

### Requirement: Cascade reopen
`reopen` with `cascade` SHALL compute the plan as the target together with every started node reachable downstream through any chain of dependents, tasks and milestones, each with its current status as `from`, and SHALL be refused naming the task when any verifier job of a node in the plan is `publishing`. Otherwise the orchestrator SHALL record the plan, return it, and apply it in one tick, dependents before their dependencies, as a sequence of per-node transactions: a `running` or `waiting` node has its process reaped and its launch ended with reason `cascade`; a `submitted` node has its verifier job dropped when the job is `queued`, `checking`, or `verified`, and is deferred to the next tick while its job is `publishing`; a `done` node and the target return to `unstarted`; a done or submitted milestone resets with reason `upstreamReopened`. Every reset task SHALL have `attempts` and `integrationRetries` set to zero, `launches` retained, and a revision context stored with cause `upstreamReopened` and the target as `upstream`, or cause `reopened` for the target itself. After a cascade is applied no started task SHALL depend on an unstarted node.

#### Scenario: Plan equals the started closure
- **WHEN** T1, T3, and T4 are done, T2 is running, MVP is submitted, T5 is unstarted, and T1 is reopened with cascade
- **THEN** the returned plan resets T1, T2, T3, T4, and MVP with their statuses as `from` and does not mention T5

#### Scenario: Live dependent is killed and reset
- **WHEN** T2 is running on launch L when T1 is reopened with cascade
- **THEN** within one tick L's process is gone, L is `ended` with reason `cascade`, T2 is `unstarted` with budgets zero, and T2's next brief carries a revision context with upstream T1 and prior branch `task/T2/l1`

#### Scenario: Submitted dependent's job is dropped
- **WHEN** T2 is submitted with a queued verifier job when T1 is reopened with cascade
- **THEN** the job is `dropped`, no publication happens for it, and T2 is `unstarted`

#### Scenario: Refused while publishing
- **WHEN** T2's verifier job is `publishing` when T1 is reopened with cascade
- **THEN** the request is refused naming T2, nothing changes, and the same request succeeds after the job has settled

#### Scenario: Property after cascade
- **WHEN** random cascades are applied through the real tick to random reachable states
- **THEN** no task whose status is `running`, `waiting`, `submitted`, or `done` has a dependency whose status is `unstarted`
