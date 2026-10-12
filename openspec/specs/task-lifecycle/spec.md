# Task Lifecycle Specification

## Purpose
Node states, allowed transitions by actor, admission, counters, leases, retry, the reopen guard, cancellation, and milestone review for every node in the task graph.

## Requirements

### Requirement: Node states
Each node SHALL have exactly one status from `unstarted`, `running`, `waiting`, `submitted`, `done`, `failed`, `blocked`, and `cancelled`. A node with no overlay entry SHALL be treated as `unstarted`. Each overlay entry SHALL carry `attempts`, `integrationRetries`, `launches`, an optional lease, and `updatedAt`. `failed` and `blocked` SHALL carry a structured reason, `waiting` SHALL carry the question and any answer, and `cancelled` SHALL carry a reason and `releasesDependents`.

#### Scenario: Missing entry is unstarted
- **WHEN** a node exists in the graph but has no overlay entry
- **THEN** its status is reported as `unstarted` with all counters at zero

### Requirement: Sole writer
Only the orchestrator process SHALL write the status overlay. Agents and humans SHALL submit intents as events, and the orchestrator SHALL apply the resulting transitions.

#### Scenario: Agent report is applied by the orchestrator
- **WHEN** an agent posts a `submit` report
- **THEN** the event is recorded first and the orchestrator transitions the task to `submitted`

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
| any non-terminal | cancelled | human | cancel |
| milestone unstarted | done | orchestrator | closure satisfied, not gated |
| milestone unstarted | submitted | orchestrator | closure satisfied, gated |
| milestone submitted | done | human | accept |
| milestone submitted | blocked | human | reject |

#### Scenario: Listed transition is applied
- **WHEN** a task is `failed` with attempts below the maximum and the orchestrator requests `unstarted`
- **THEN** the transition is applied

#### Scenario: Unlisted transition is rejected
- **WHEN** a transition from `unstarted` directly to `done` is requested for a task
- **THEN** the transition is rejected and the overlay is unchanged

#### Scenario: Milestone never runs
- **WHEN** a transition to `running` is requested for a milestone
- **THEN** the transition is rejected

### Requirement: Admission
The orchestrator SHALL admit `unstarted` ready tasks and resumable `waiting` tasks into run slots up to the configured capacity, admitting resumables before new launches and otherwise in first-in first-out order. A `waiting` task SHALL NOT hold a run slot, and the number of `waiting` tasks SHALL be bounded by `maxWaiting`.

#### Scenario: Waiting frees the slot
- **WHEN** capacity is one and the running task A blocks with a question
- **THEN** a ready task B is admitted while A is `waiting`

#### Scenario: Resume requires a free slot
- **WHEN** capacity is one, task A is `waiting` with an answer persisted, and task B is running
- **THEN** A stays `waiting` until B's launch ends and is then admitted before any new task

#### Scenario: Waiting cap enforced
- **WHEN** `maxWaiting` tasks are already waiting and another running task blocks
- **THEN** that block is answered with a timeout and the task becomes `blocked` with its question preserved

### Requirement: Counters
`launches` SHALL increase by one for every spawned process and SHALL never be reset; it names the branch `task/<id>/l<launches>` and the worktree. `attempts` SHALL increase by one when a launch ends in `failed` by the agent's fail report, by process death without a report, by lease expiry, or by a verifier red check or cap hit, and SHALL NOT increase on daemon-caused relaunch or on integration conflict. `integrationRetries` SHALL increase by one on each rebase conflict. `attempts` and `integrationRetries` SHALL be reset to zero on human unblock, reopen, and uncancel.

#### Scenario: Conflict does not spend an attempt
- **WHEN** a submitted task hits a rebase conflict under the cap
- **THEN** `integrationRetries` is one, `attempts` is unchanged, and `launches` increases when the task is relaunched

#### Scenario: Unblock resets budgets
- **WHEN** a human unblocks a task that had two attempts and one integration retry
- **THEN** both counters are zero and `launches` is unchanged

### Requirement: Leases
A `running` or `waiting` task SHALL hold a lease recording `launchId`, `token`, `claimedAt`, `spawnedAt`, `expiresAt`, `baseSha`, and `graphRev`. The lease TTL SHALL be the maximum tolerable silence. A heartbeat, any API call, and an open long-poll SHALL renew the lease. The orchestrator SHALL treat an expired lease on a `running` task as failure.

#### Scenario: Silence past the TTL fails the task
- **WHEN** a running agent makes no API call for longer than the lease TTL
- **THEN** the task becomes `failed` with reason `leaseExpired`, `attempts` increases, and the process is reaped

#### Scenario: Long-poll keeps the lease alive
- **WHEN** an agent is parked in `block` with the connection open
- **THEN** its lease does not expire while the connection stays open

### Requirement: Retry and exhaustion
When a task becomes `failed` and `attempts` is below `maxAttempts` (default 2), the orchestrator SHALL return it to `unstarted` and the next launch's brief MUST include the prior failure report and any verifier output. When `attempts` reaches `maxAttempts`, the orchestrator SHALL move the task to `blocked` with the last reason.

#### Scenario: One automatic retry with context
- **WHEN** a task fails on its first attempt
- **THEN** it is relaunched and the new brief contains the prior failure report

#### Scenario: Exhaustion blocks
- **WHEN** a task fails on its second attempt with `maxAttempts` at 2
- **THEN** it becomes `blocked` and appears in `stallRoots`

### Requirement: Reopen guard
A `done` or `cancelled` node SHALL be revocable only when no dependent is started, where started means `running`, `waiting`, `submitted`, or `done`. Reopen and uncancel SHALL reset `attempts` and `integrationRetries` and SHALL NOT reset `launches`. There SHALL be no override flag; the escape hatch is to cancel the dependents first.

#### Scenario: Reopen refused while a dependent runs
- **WHEN** T1 is done and T2, which depends on T1, is running
- **THEN** reopening T1 is rejected with a reason naming T2

#### Scenario: Reopen allowed after the dependent fails
- **WHEN** T1 is done and every dependent is `unstarted`, `failed`, `blocked`, or `cancelled`
- **THEN** reopening T1 succeeds and T1 is `unstarted` with budgets reset

#### Scenario: Done milestone guards its constituents
- **WHEN** MVP is done and T3 is a direct dependency of MVP
- **THEN** reopening T3 is rejected until MVP is reopened

### Requirement: Cancellation
A human SHALL be able to cancel any node that is not `done` or `cancelled`, supplying a reason and `releasesDependents` (default false). Cancelling a `running` or `waiting` task SHALL cause the orchestrator to reap its process on the next tick, and cancelling a `submitted` task SHALL drop its queued verifier job.

#### Scenario: Cancel a running task
- **WHEN** a human cancels a running task
- **THEN** the task is `cancelled`, its process is terminated within one tick, and its branch is retained

#### Scenario: Release lets dependents proceed
- **WHEN** T1 is cancelled with `releasesDependents: true`
- **THEN** T2 and T3 become ready and their briefs state that T1 was cancelled and why

### Requirement: Milestone review
A human SHALL accept a `submitted` milestone only against its pinned `integrationSha` and `reviewVersion`. Rejecting a milestone SHALL move it to `blocked` with reason `milestoneRejected` and the reviewer's note, and the orchestrator SHALL NOT retry it. After repair, a human unblock SHALL return it to `unstarted`, and it SHALL be resubmitted as a new review version only when its dependencies are satisfied again.

#### Scenario: Reject then repair then accept
- **WHEN** MVP is rejected, a new task T7 is added as a dependency of MVP, MVP is unblocked, and T7 is done
- **THEN** MVP is `submitted` with `reviewVersion` 2 and a new `integrationSha`, and accepting it records that sha and version

#### Scenario: Rejection does not loop
- **WHEN** MVP is rejected and nothing else changes
- **THEN** MVP stays `blocked` across subsequent ticks

### Requirement: Structured blocked reasons
A `blocked` status SHALL carry a reason with a kind from `needsDecision`, `needsAccess`, `impossible`, `dependencyCancelled`, `outOfScope`, `insufficientSpec`, and `milestoneRejected`, plus a message, and for `needsDecision` any options and the eventual answer.

#### Scenario: Question survives into the next brief
- **WHEN** a task is blocked with kind `needsDecision` and a human answers
- **THEN** the task returns to `unstarted` and its next brief contains the question and the answer

### Requirement: Fresh process per launch
Every launch SHALL be a new process with a new worktree and branch. Resuming after `blocked` SHALL be a new launch whose brief carries the answer. Resuming after `waiting` SHALL continue the same process once admitted.

#### Scenario: Blocked resume is cold
- **WHEN** a task that was `blocked` is unblocked with an answer
- **THEN** a new launch starts with `launches` incremented and the answer in its brief

#### Scenario: Waiting resume is warm
- **WHEN** a `waiting` task is answered and admitted
- **THEN** the same process receives the answer through its open or re-issued long-poll and `launches` is unchanged
