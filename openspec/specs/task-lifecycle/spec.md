# Task Lifecycle Specification

## Purpose
Node states, allowed transitions by actor, admission, counters, leases, retry, the reopen guard, cancellation, milestone review, milestone resets, and cascade reopen for every node in the task graph, where a lease is renewed by observed process liveness as well as by API calls, so that silence from a live agent is a health matter rather than a lease failure, and where reopening a task resets every done or submitted milestone downstream of it while a reopen with cascade resets the whole started closure downstream of it, dependents before their dependencies, and where in `pull` and `mixed` modes a launch is parked as `claimable` once prepared, holding its run slot with a lease that starts only at the claim, and the release of a claimed launch returns the task to `unstarted` without spending an attempt when no progress was observed and fails it, spending one, otherwise.

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
The system SHALL permit exactly the transitions listed in the requirements whose names begin with "Transition table:" and MUST reject any other transition with an error naming the current and requested status.

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

#### Scenario: Fresh-clone losses spend no attempt
- **WHEN** startup on a fresh clone applies `submitted -> failed` with trigger `commitLost` or `running -> failed` with trigger `worktreeLost`
- **THEN** `attempts` is unchanged and the task is retried through `failed -> unstarted`

#### Scenario: A refused push blocks the task
- **WHEN** the verifier's job for a submitted task fails as `pushRefused`
- **THEN** the verifier applies `submitted -> blocked` with trigger `pushRefused` and `attempts` unchanged, and the same request by an agent is rejected

#### Scenario: A failed prepare command returns the task to unstarted
- **WHEN** a launch's prepare command fails while its task runs on it, below `prepareFailureLimit` failures in a row
- **THEN** the orchestrator applies `running -> unstarted` with trigger `prepareFailed`, `attempts` and the carry unchanged and the lease cleared, and the same request by an agent is rejected

#### Scenario: Prepare failures at the limit block the task
- **WHEN** a task's prepare command fails for the `prepareFailureLimit`-th time in a row
- **THEN** the orchestrator applies `running -> blocked` with trigger `prepareFailed`, `attempts` and the carry unchanged, and the same request by an agent is rejected

#### Scenario: A remote run blocks a task whose kind commits as the daemon
- **WHEN** on a remote run the orchestrator admits a task whose runner kind has commit policy `daemon`
- **THEN** it applies `unstarted -> blocked` with trigger `remoteNeedsAgentCommit` and creates no launch, and the same request by an agent is rejected

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
`launches` SHALL increase by one for every spawned process and SHALL never be reset; it names the branch `task/<id>/l<launches>` and the worktree. `attempts` SHALL increase by one when a launch ends in `failed` by the agent's fail report, by process death without a report, by lease expiry, or by a verifier red check or cap hit, and SHALL NOT increase on daemon-caused relaunch, on integration conflict, or on a release with `keep`.

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

### Requirement: Leases
A `running` or `waiting` task SHALL hold a lease recording `launchId`, `token`, `claimedAt`, `spawnedAt`, `expiresAt`, `baseSha`, and `graphRev`. A heartbeat, any API call, and an open long-poll SHALL renew the lease.

#### Scenario: Silent but alive agent keeps its lease
- **WHEN** a running agent with a recorded pid makes no API call for longer than the lease TTL while its process is alive
- **THEN** its lease is renewed each tick, the task stays `running`, and `attempts` is unchanged

#### Scenario: Silence past the TTL fails an unobserved launch
- **WHEN** the runner reports `unknown` liveness for a running launch and no API call arrives for longer than the lease TTL
- **THEN** the task becomes `failed` with reason `leaseExpired`, `attempts` increases, and any process the runner can reach is reaped

#### Scenario: Long-poll keeps the lease alive
- **WHEN** an agent is parked in `block` with the connection open
- **THEN** its lease does not expire while the connection stays open

#### Scenario: Outage longer than the TTL
- **WHEN** the daemon is down for longer than the lease TTL while an agent process survives, then restarts
- **THEN** the launch is adopted, its lease is renewed before any expiry check, and the task stays `running`

### Requirement: Retry and exhaustion
When a task becomes `failed` and `attempts` is below `maxAttempts` (default 2), the orchestrator SHALL return it to `unstarted` and the next launch's brief MUST include the prior failure report and any verifier output. When `attempts` reaches `maxAttempts`, the orchestrator SHALL move the task to `blocked` with the last reason.

#### Scenario: Contended startups relaunch without charge
- **WHEN** a task's first two launches die and the runner diagnoses each as `startupContended`, and the third launch submits and is published
- **THEN** the task is `done` with `attempts` 0, and the two `launch.failed` events carry `reason: startupContended` and `charged: false`

#### Scenario: The allowance runs out
- **WHEN** a task's fourth launch dies `startupContended` with `health.contendedRetries` at 3
- **THEN** the death is charged: `attempts` is one and its `launch.failed` event carries `charged: true`

#### Scenario: Restart deaths share the allowance
- **WHEN** with `health.contendedRetries` at 1, a task's first launch dies `startupContended` while the daemon runs and its second dies `startupContended` while the daemon is down
- **THEN** recovery charges the second death: its `launch.failed` event carries `charged: true` and `attempts` is one

#### Scenario: One automatic retry with context
- **WHEN** a task fails on its first attempt
- **THEN** it is relaunched and the new brief contains the prior failure report

#### Scenario: Exhaustion blocks
- **WHEN** a task fails on its second attempt with `maxAttempts` at 2
- **THEN** it becomes `blocked` and appears in `stallRoots`

### Requirement: Reopen guard
A `done` or `cancelled` node SHALL be revocable only when no non-milestone dependent reachable through any chain of milestones is started, where started means `running`, `waiting`, `submitted`, or `done`. Milestone dependents SHALL never block a reopen.

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

#### Scenario: Accepted milestone is reviewed again after an upstream reopen
- **WHEN** MVP was accepted at version 1 and T3 in its closure is reopened and done again
- **THEN** MVP is `submitted` at version 2 with the new integration head pinned, and accepting it against version 1 is refused as stale

### Requirement: Structured blocked reasons
A `blocked` status SHALL carry a reason with a kind from `needsDecision`, `needsAccess`, `impossible`, `dependencyCancelled`, `outOfScope`, `insufficientSpec`, `milestoneRejected`, `pushRefused`, `prepareFailed`, and `remoteNeedsAgentCommit`, plus a message, and for `needsDecision` any options and the eventual answer.

#### Scenario: Question survives into the next brief
- **WHEN** a task is blocked with kind `needsDecision` and a human answers
- **THEN** the task returns to `unstarted` and its next brief contains the question and the answer

#### Scenario: A refused push names origin's text
- **WHEN** a task is blocked with kind `pushRefused`
- **THEN** its message holds the text origin answered the push with, and an unblock returns it to `unstarted` with its budgets reset

#### Scenario: Repeated prepare failures name the command
- **WHEN** a task is blocked with kind `prepareFailed`
- **THEN** its message names the prepare command, the count and the last reason and holds no command output, and an unblock returns it to `unstarted` with its count of prepare failures removed

#### Scenario: An agent cannot block with an orchestrator kind
- **WHEN** an agent's block call names kind `prepareFailed` or `pushRefused`
- **THEN** it is answered 400 and the task stays `running`

#### Scenario: A kind that commits as the daemon on a remote run
- **WHEN** a task is blocked with kind `remoteNeedsAgentCommit`
- **THEN** its message names the runner kind and the commit policy `daemon`, and no launch exists for it

### Requirement: Fresh process per launch
Every launch SHALL be a new process with a new worktree and branch. Resuming after `blocked` SHALL be a new launch whose brief carries the answer. Resuming after `waiting` SHALL continue the same process once admitted.

#### Scenario: Blocked resume is cold
- **WHEN** a task that was `blocked` is unblocked with an answer
- **THEN** a new launch starts with `launches` incremented and the answer in its brief

#### Scenario: Waiting resume is warm
- **WHEN** a `waiting` task is answered and admitted
- **THEN** the same process receives the answer through its open or re-issued long-poll and `launches` is unchanged

### Requirement: Health failure reasons
A `running` task SHALL become `failed` with reason `stuck` when stuck detection escalates and with reason `timeBudget` when its launch exceeds the launch time budget. Both SHALL use the orchestrator's `running -> failed` transition, SHALL increase `attempts`, and SHALL follow the retry and exhaustion rules like any other failure, so the next brief carries the reason as the prior failure.

#### Scenario: Stuck failure spends an attempt and retries with context
- **WHEN** a task on its first attempt is failed with reason `stuck` and `maxAttempts` is 2
- **THEN** `attempts` is one, the task returns to `unstarted`, and its next brief names `stuck` as the prior failure

#### Scenario: Time budget failure exhausts
- **WHEN** a task on its last attempt is failed with reason `timeBudget`
- **THEN** it becomes `blocked` and appears in `stallRoots` with that reason

#### Scenario: Runner diagnosis carried into the retry
- **WHEN** a task on its first attempt with `maxAttempts` 2 has a launch whose process exits without a report and the runner diagnoses `unknownModel` with the error text as detail
- **THEN** the task fails with reason `exitedWithoutReport`, `attempts` is one, and the next brief names `unknownModel` and the detail as the runner's diagnosis of the previous launch

#### Scenario: Codex log classification
- **WHEN** the Codex runner reads a log with only the stderr line ``Error: MCP server `probe` is required but failed to start``
- **THEN** it returns `mcpStartupFailed` with that line as detail

#### Scenario: Approval refusal after which the turn completed
- **WHEN** the Codex runner reads the probe log in which `probe.probe_write` failed with `MCP tool call requires approval, but approval policy is never` and `turn.completed` follows
- **THEN** it returns `mcpApprovalRefused` naming `probe.probe_write`

#### Scenario: Denied command reported only by the agent
- **WHEN** the Codex runner reads the git probe log, whose `command_execution` items all succeeded and whose final `agent_message` quotes `fatal: Unable to create '.../.git/worktrees/.../index.lock': Operation not permitted`
- **THEN** it returns `sandboxDenied` with that line as detail

#### Scenario: Denied command followed by a successful one
- **WHEN** a failed `command_execution` item says `Operation not permitted` and a later `command_execution` item succeeded
- **THEN** it returns `sandboxDenied` naming the denied command

#### Scenario: Ordinary lines are not failures
- **WHEN** a log holds the stderr line `Using authentication from CODEX_HOME` and a failed `mcp_tool_call` whose error is `EACCES: permission denied`, and its turn completed
- **THEN** it returns neither `authFailed` nor `mcpApprovalRefused`

#### Scenario: Complete run gives no diagnosis
- **WHEN** the Codex runner reads a log whose turn completed with no failed MCP call and no denied command
- **THEN** it returns no diagnosis and the failure is recorded as without one

#### Scenario: OpenCode unknown model
- **WHEN** the OpenCode runner reads E-badmodel.jsonl alone
- **THEN** it returns `turnFailed` with `Unexpected server error. Check server logs for details.`; with the ERROR line `ProviderModelNotFoundError: Model not found: opencode/gpt-bogus-9` added it returns `unknownModel` naming `opencode/gpt-bogus-9`

#### Scenario: OpenCode shim unavailable after a completed turn
- **WHEN** the OpenCode runner reads D4.err and D4.jsonl, whose turn completed
- **THEN** it returns `mcpStartupFailed` with the `server unavailable` line

#### Scenario: OpenCode permission rejected
- **WHEN** the OpenCode runner reads F1-ask.jsonl and F1-ask.err
- **THEN** it returns `permissionDenied` with `echo marker-7731` in the detail, and P-ask.jsonl with P-ask.err gives `permissionDenied` naming `uname -s`; F2-deny.jsonl, where the tool was removed and the turn completed, gives no diagnosis

#### Scenario: OpenCode deny refusal continued past
- **WHEN** the OpenCode runner reads P-deny.jsonl or X-chain-offpattern.jsonl, where a bash call got the deny error and the model went on to a `reason: "stop"` step
- **THEN** it gives no diagnosis

#### Scenario: OpenCode startup contention and noise
- **WHEN** the OpenCode runner reads K2.err or SA-proj.err alone
- **THEN** it returns `startupContended`; a log whose only stderr is `duplicate skill name` warnings and whose turn completed gives no diagnosis, and an empty log gives `exitBeforeTurn` without detail

#### Scenario: Uncharged startupContended relaunch observed end to end
- **WHEN** in the real OpenCode run (`ORCH_E2E_OPENCODE=1`) concurrent launches against the shared OpenCode database die at startup with `database is locked`
- **THEN** each such death records `launch.failed` with reason `startupContended` and `charged: false`, the task is relaunched, and its `attempts` equals its launch count minus one minus its uncharged deaths
- **AND** a run in which no start was contended asserts nothing about the rule

#### Scenario: Runner without a diagnosis
- **WHEN** the launch's runner does not implement `readFailure`
- **THEN** the task fails with reason `exitedWithoutReport` and the message `process exited without a report`, as before

### Requirement: Milestone reset
When a task is reopened, uncancelled, or reset by cascade, every milestone reachable downstream from it whose status is `done` or `submitted` SHALL transition to `unstarted` with the event `milestone.reset` carrying the reason `upstreamReopened`, the upstream task, the status it left, and its `reviewVersion`. A `blocked` milestone SHALL NOT be reset.

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
`reopen` with `cascade` SHALL compute the plan as the target together with every started node reachable downstream through any chain of dependents, tasks and milestones, each with its current status as `from`, and SHALL be refused naming the task when any verifier job of a node in the plan is `publishing`.

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

### Requirement: Claimable launches
In `pull` and `mixed` modes a launch SHALL be parked as `claimable` once its worktree and brief exist. The task SHALL be `running` from the moment the launch row exists and SHALL hold a run slot while parked, so that the number of parked launches is bounded by `capacity`.

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

### Requirement: Transition table: leaving unstarted
The system SHALL permit the transitions below:

| From | To | Whose intent | Trigger |
|---|---|---|---|
| unstarted | blocked | orchestrator | brief validation failed, or a remediation candidate awaits review |
| unstarted | blocked | orchestrator | remoteNeedsAgentCommit: on a remote run the task's runner kind has commit policy `daemon`; no launch is created |
| unstarted | running | orchestrator | ready, brief valid, slot admitted; launch created |

#### Scenario: Admission launches the task
- **WHEN** the orchestrator requests `unstarted -> running` with trigger `admitted` for a task with `launches` 2
- **THEN** the transition is applied and `launches` is 3

#### Scenario: Only the orchestrator blocks an unstarted task
- **WHEN** an agent requests `unstarted -> blocked` with trigger `remoteNeedsAgentCommit`
- **THEN** the transition is rejected

### Requirement: Transition table: agent reports on a running task
The system SHALL permit the transitions below:

| From | To | Whose intent | Trigger |
|---|---|---|---|
| running | submitted | agent | submit report accepted and sealed |
| running | failed | agent | fail report |
| running | blocked | agent | block delivered through the fallback file after exit |
| running | waiting | agent | block through the long-poll |

#### Scenario: Agent fail report spends an attempt
- **WHEN** an agent requests `running -> failed` for a task with `attempts` 1
- **THEN** the transition is applied and `attempts` is 2

#### Scenario: Block through the long-poll keeps the lease
- **WHEN** an agent requests `running -> waiting` with the task's lease in the patch
- **THEN** the transition is applied and the lease is kept, while `running -> submitted` without a patch clears it

### Requirement: Transition table: orchestrator fails a running task
The system SHALL permit the transitions below:

| From | To | Whose intent | Trigger |
|---|---|---|---|
| running | failed | orchestrator | process dead without a report, lease expired, or a claimed launch released after progress without keep |
| running | failed | orchestrator | worktreeLost: a claimed launch's worktree is gone at startup on a fresh clone; attempts unchanged |

#### Scenario: Expired lease on an unobserved launch
- **WHEN** the runner reports `unknown` liveness for a running launch and its lease expires
- **THEN** the orchestrator applies `running -> failed`, `attempts` increases, and the next brief carries `leaseExpired` as the prior failure

### Requirement: Transition table: released claimed launch
The system SHALL permit the transitions below:

| From | To | Whose intent | Trigger |
|---|---|---|---|
| running | unstarted | orchestrator | claimed launch released without progress, or released with keep after progress |

#### Scenario: Only the orchestrator releases
- **WHEN** an agent requests `running -> unstarted` with trigger `released`
- **THEN** the transition is rejected, and the same request for a milestone by the orchestrator is rejected too

### Requirement: Transition table: prepare failures
The system SHALL permit the transitions below:

| From | To | Whose intent | Trigger |
|---|---|---|---|
| running | unstarted | orchestrator | prepareFailed: the prepare command failed in the launch's worktree, below `prepareFailureLimit` failures in a row; attempts and carry unchanged |
| running | blocked | orchestrator | prepareFailed: the prepare command failed `prepareFailureLimit` times in a row; attempts and carry unchanged |

#### Scenario: A failed prepare keeps the carry
- **WHEN** the orchestrator applies `running -> unstarted` with trigger `prepareFailed` to a task with `attempts` 1, `launches` 2 and a carry
- **THEN** `attempts` stays 1, `launches` stays 2, the carry is kept and the lease is cleared

### Requirement: Transition table: waiting task
The system SHALL permit the transitions below:

| From | To | Whose intent | Trigger |
|---|---|---|---|
| waiting | running | orchestrator | answer persisted and a slot admitted |
| waiting | blocked | orchestrator | maxWait elapsed, process dead, or a claimed launch released |

#### Scenario: maxWait blocks a waiting task
- **WHEN** a task stays `waiting` past `maxWaitMs`
- **THEN** the orchestrator applies `waiting -> blocked` and the task's question is kept in its blocked reason

### Requirement: Transition table: verifier outcomes
The system SHALL permit the transitions below:

| From | To | Whose intent | Trigger |
|---|---|---|---|
| submitted | done | verifier | published |
| submitted | failed | verifier | checks red, undeclared empty diff, missing acceptance evidence, or integration cap hit |
| submitted | unstarted | verifier | rebase conflict under the cap |
| submitted | blocked | verifier | pushRefused: origin refused the publication push `git.pushRefusalLimit` times; attempts unchanged |

#### Scenario: Rebase conflict returns the task to unstarted
- **WHEN** the verifier requests `submitted -> unstarted` with trigger `conflict` for a task with `attempts` 1 and `integrationRetries` 1
- **THEN** the transition is applied, `integrationRetries` is 2, and `attempts` is 1

### Requirement: Transition table: lost commit, retry and exhaustion
The system SHALL permit the transitions below:

| From | To | Whose intent | Trigger |
|---|---|---|---|
| submitted | failed | orchestrator | commitLost: a queued job's sealed commit is missing at startup on a fresh clone; attempts unchanged |
| failed | unstarted | orchestrator | attempts below maxAttempts |
| failed | blocked | orchestrator | attempts exhausted |

#### Scenario: Retry keeps the attempt count
- **WHEN** the orchestrator requests `failed -> unstarted` with trigger `retry` for a task with `attempts` 1
- **THEN** the transition is applied and `attempts` stays 1

### Requirement: Transition table: human transitions
The system SHALL permit the transitions below:

| From | To | Whose intent | Trigger |
|---|---|---|---|
| blocked | unstarted | human | unblock or answer |
| done or cancelled | unstarted | human | reopen or uncancel when revocable |
| running, waiting, submitted, or done | unstarted | human | cascade reopen of an upstream node |
| any non-terminal | cancelled | human | cancel |

#### Scenario: Cancel from any non-terminal status
- **WHEN** a human requests `cancelled` for a task or milestone that is `unstarted`, `running`, `waiting`, `submitted`, `failed`, or `blocked`
- **THEN** the transition is applied

#### Scenario: Unblock resets the budgets
- **WHEN** a human requests `blocked -> unstarted` for a task with `attempts` 1, `integrationRetries` 1 and `launches` 2
- **THEN** `attempts` and `integrationRetries` are zero and `launches` stays 2

### Requirement: Transition table: milestones
The system SHALL permit the transitions below:

| From | To | Whose intent | Trigger |
|---|---|---|---|
| milestone unstarted | done | orchestrator | closure satisfied, not gated |
| milestone unstarted | submitted | orchestrator | closure satisfied, gated |
| milestone submitted | done | human | accept |
| milestone submitted | blocked | human | reject |
| milestone done or submitted | unstarted | orchestrator | milestone reset: upstream reopened, or deps changed on reload |

#### Scenario: A gated milestone is submitted at its first version
- **WHEN** the orchestrator requests `unstarted -> submitted` for a gated milestone with an `integrationSha` in the patch
- **THEN** the transition is applied, `reviewVersion` is 1, and `integrationSha` is recorded

#### Scenario: Milestone reset keeps the review version
- **WHEN** the orchestrator requests `done -> unstarted` with trigger `milestoneReset` for a milestone at `reviewVersion` 2 that was accepted
- **THEN** `reviewVersion` stays 2 and `accepted` is cleared

### Requirement: Integration retries counter
`integrationRetries` SHALL increase by one on each rebase conflict.

#### Scenario: Each conflict counts
- **WHEN** a submitted task with `integrationRetries` 1 hits a rebase conflict under the cap
- **THEN** `integrationRetries` is 2 and `attempts` is unchanged

### Requirement: Interruptions counter
`interruptions` SHALL increase by one on every release with `keep` that stores an `interrupted` context and SHALL be reset to zero when the task submits.

#### Scenario: Kept releases count until the task submits
- **WHEN** a claimed launch with progress is released with `keep` twice and the task's next launch submits
- **THEN** `interruptions` is one after the first release, two after the second, and zero after the submit

### Requirement: Budget resets
`attempts` and `integrationRetries` SHALL be reset to zero on human unblock, reopen, and uncancel, and on every node reset by a cascade reopen.

#### Scenario: Uncancel resets the budgets
- **WHEN** a human uncancels a cancelled task with `attempts` 1, `integrationRetries` 1 and `launches` 2
- **THEN** its `attempts` and `integrationRetries` are zero and its `launches` is still 2

### Requirement: Lease renewal by observed liveness
For a launch whose process the daemon can observe, the daemon SHALL also renew the lease on every tick while the runner reports the process alive, including the first tick after adoption, so that the lease TTL bounds silence only for launches the daemon cannot observe. Silence from a live process SHALL NOT fail the task; it is handled by stuck detection.

#### Scenario: A live process outlasts the TTL
- **WHEN** a running launch whose process the runner reports alive makes no API call for longer than the lease TTL
- **THEN** the tick renews its lease to a later `expiresAt`, the task stays `running`, and `attempts` and `launches` are unchanged

### Requirement: Expired lease fails a running task
The orchestrator SHALL treat an expired lease on a `running` task as failure with reason `leaseExpired`.

#### Scenario: The retry names the expired lease
- **WHEN** a running task's lease expires while the runner reports `unknown` liveness for its launch
- **THEN** the task fails with `attempts` increased and the next launch's brief carries the prior failure with kind `leaseExpired`

### Requirement: Launch death record
Every launch that dies without a report SHALL be recorded as a `launch.failed` event carrying the runner's `reason` and `detail` when it gave a diagnosis, and `charged`, whether the death is observed by a tick or by startup recovery.

#### Scenario: Every death without a report is recorded
- **WHEN** a task's first launch dies with the runner diagnosing `exitBeforeTurn` and its second dies with no diagnosis
- **THEN** two `launch.failed` events are recorded, `{ reason: exitBeforeTurn, charged: true }` and `{ charged: true }`, and the task is `blocked`

### Requirement: Uncharged startupContended deaths
A death the runner diagnoses as `startupContended` SHALL NOT be charged while the task has had fewer than `health.contendedRetries` (default 3) uncharged contended deaths, counted from the `launch.failed` events and never reset. The count SHALL be read in the same store transaction that appends the `launch.failed` event. Later contended deaths SHALL be charged like any other failure. `0` charges every one.

#### Scenario: The allowance is set to zero
- **WHEN** `health.contendedRetries` is 0 and a task's first launch dies `startupContended`
- **THEN** the death is charged: `attempts` is one and `launches` is two

### Requirement: Uncharged contended death returns the task to unstarted
On an uncharged `startupContended` death the task SHALL return to `unstarted` at once through the orchestrator's `running -> unstarted` (`released`) transition, with `attempts` unchanged, the transition event carrying `reason: startupContended`, and the next brief carrying the `exitedWithoutReport` failure as the prior failure.

#### Scenario: A contended death found at restart
- **WHEN** a task's live launch dies `startupContended` while the daemon is down and the restarted daemon recovers it
- **THEN** its `launch.failed` event carries `charged: false`, the task is `unstarted` with `attempts` 0 through a `released` transition with reason `startupContended`, and the next tick launches it again

### Requirement: Reopen and uncancel effects
Reopen and uncancel SHALL reset `attempts` and `integrationRetries`, SHALL NOT reset `launches`, SHALL store a revision context for the next brief when the node has a prior launch, and SHALL reset every `done` or `submitted` milestone downstream of the node.

#### Scenario: A reopened task is briefed with its previous launch
- **WHEN** T3 was published from launch `task/T3/l1` under a done gated milestone MVP and T3 is reopened
- **THEN** T3 is `unstarted` with budgets zero, MVP is `unstarted`, and T3's next brief carries a revision context with cause `reopened` and prior branch `task/T3/l1`

### Requirement: No silent skip of the reopen guard
There SHALL be no flag that skips the reopen guard silently; the escape hatch is `reopen` with `cascade`, which returns its plan.

#### Scenario: Plain reopen names its blockers
- **WHEN** T1 is done, T2 is running and T3 is submitted, both depending on T1, and a human reopens T1 without `cascade`
- **THEN** the reopen is refused with blockers T2 and T3 and T1 stays `done`, while the same reopen with `cascade` returns the plan

### Requirement: Acceptance does not survive a reopen
An acceptance SHALL NOT survive the reopening of a task in the milestone's closure: the milestone reset discards it and the milestone SHALL be reviewed again at its next version.

#### Scenario: The old acceptance is refused after the reopen
- **WHEN** MVP was accepted at version 1 and T3 in its closure is reopened
- **THEN** MVP is `unstarted` with `accepted` cleared, and accepting it against version 1 is refused

### Requirement: Blocked kinds reserved to the orchestrator and the verifier
Only the verifier SHALL set `pushRefused`, and agents MUST NOT block with it. Only the orchestrator SHALL set `prepareFailed`, and agents MUST NOT block with it. Only the orchestrator SHALL set `remoteNeedsAgentCommit`, and agents MUST NOT block with it.

#### Scenario: An agent cannot block as a remote commit refusal
- **WHEN** a running agent's block call names kind `remoteNeedsAgentCommit`
- **THEN** it is answered 400 and the task stays `running`

### Requirement: Milestone reset on changed deps
A reload that changes a done or submitted milestone's `deps` SHALL reset it the same way as a milestone reset by a reopened task (see "Milestone reset") with reason `depsChanged`.

#### Scenario: A submitted milestone gains a dependency on reload
- **WHEN** MVP is `submitted` at version 1 and a reload adds the done task T5 to its `deps`
- **THEN** a `milestone.reset` event with reason `depsChanged`, from `submitted`, and `reviewVersion` 1 is recorded, and MVP is `submitted` again at version 2 in the same tick

### Requirement: Milestone reset effects
A milestone reset SHALL retain `reviewVersion` and every existing tag, SHALL clear `accepted` and `integrationSha`, and for a submitted milestone SHALL drop the pending review so that `accept` and `reject` against the old version fail.

#### Scenario: Reset clears the acceptance and keeps the version
- **WHEN** MVP was accepted at version 1 and T3 in its closure is reopened
- **THEN** MVP is `unstarted` with `reviewVersion` 1, `accepted` and `integrationSha` cleared, and accepting it against version 1 is refused

### Requirement: Reset milestone completes again
When a reset milestone becomes due again it SHALL complete as before: `done` when not gated, and `submitted` with `reviewVersion` incremented and the tag `milestone/<id>/v<reviewVersion>` created at the newly pinned head when gated.

#### Scenario: A gated milestone is tagged at its next version
- **WHEN** MVP was reset at version 1 and its closure is done again
- **THEN** MVP is `submitted` with `reviewVersion` 2, and the tags `milestone/MVP/v1` and `milestone/MVP/v2` exist, each at the head pinned for its version

### Requirement: Cascade application: live and submitted nodes
When the cascade is not refused, the orchestrator SHALL record the plan, return it, and apply it in one tick, dependents before their dependencies, as a sequence of per-node transactions: a `running` or `waiting` node has its process reaped and its launch ended with reason `cascade`; a `submitted` node has its verifier job dropped when the job is `queued`, `checking`, or `verified`, and is deferred to the next tick while its job is `publishing`.

#### Scenario: Live and submitted dependents are cut off in one tick
- **WHEN** T2 is running on launch L and T3 is submitted with a queued verifier job when T1 is reopened with cascade
- **THEN** nothing changes until the next tick, and in that tick L's process is gone, L is `ended` with reason `cascade`, and T3's job is `dropped`

### Requirement: Cascade application: done nodes and milestones
When the cascade is not refused, the orchestrator SHALL record the plan, return it, and apply it in one tick, dependents before their dependencies, as a sequence of per-node transactions: a `done` node and the target return to `unstarted`; a done or submitted milestone resets with reason `upstreamReopened`.

#### Scenario: Done target and submitted milestone in the plan
- **WHEN** the pending cascade plan of target T1 lists T1 as `done` and milestone MVP as `submitted`
- **THEN** applying it returns T1 to `unstarted` with trigger `reopen` and resets MVP with reason `upstreamReopened` and upstream T1

### Requirement: Cascade budgets and revision context
Every task reset by a cascade reopen SHALL have `attempts` and `integrationRetries` set to zero, `launches` retained, and a revision context stored with cause `upstreamReopened` and the target of the cascade as `upstream`, or cause `reopened` for the target itself.

#### Scenario: Target and dependent revision contexts
- **WHEN** T1 is reopened with cascade while its dependent T2 is running on its first launch
- **THEN** T2's `attempts` and `integrationRetries` are zero, T1's next brief carries a revision context with cause `reopened`, and T2's next brief carries one with cause `upstreamReopened` and upstream T1

### Requirement: No started task on an unstarted node after a cascade
After a cascade is applied no started task SHALL depend on an unstarted node.

#### Scenario: Recovery finishes an interrupted cascade
- **WHEN** the daemon stops after a cascade of T1 reset T3 and before it reset T2 and T1, and then restarts
- **THEN** recovery resets T2 and T1 without a second transition for T3, so none of T1, T2 and T3 is left started

### Requirement: Parked launch lease
The lease of a parked launch SHALL NOT expire; its TTL SHALL start at the claim, when `claimedAt` and `expiresAt` are set and `spawnedAt` stays unset.

#### Scenario: The lease starts at the claim
- **WHEN** a parked launch stays parked for three lease TTLs and is then claimed
- **THEN** the task has spent no attempt, and the claim answers with `leaseExpiresAt` one lease TTL after the claim

### Requirement: Claimed launch lease renewal
A claimed launch's lease SHALL be renewed by any API call under its token, by observed worktree progress, at admission when the task resumes from `waiting`, and by its work loop's renewal (see specs/pull-runner "Lease renewal by the work loop"), which is not progress.

#### Scenario: The work loop's renewal keeps a silent launch without progress
- **WHEN** a claimed launch's agent is silent for five lease TTLs while its work loop renews every third of the TTL
- **THEN** the launch stays `live` with `attempts` 0, and it is still reported stuck because the renewal is not progress

### Requirement: Expired lease on a claimed launch
An expired lease on a claimed launch whose worktree shows progress since the claim SHALL be a kept release while the task's kept releases are under `daemon.maxKeptReleases`: `unstarted` with `attempts` unchanged and the branch kept (see specs/pull-runner "Lease expiry"). Otherwise it SHALL follow the existing failure path: `failed` with reason `leaseExpired`, `attempts` increased, the worktree swept, and a new launch prepared while attempts remain.

#### Scenario: Expiry after a commit is kept
- **WHEN** a claimed launch's lease expires and its worktree has a commit since the claim
- **THEN** the launch ends with reason `leaseExpired`, `attempts` is 0, `interruptions` is 1, and the next launch's brief names the prior branch

#### Scenario: Expiry without progress spends the attempt
- **WHEN** a claimed launch's lease expires after a heartbeat and no change in its worktree
- **THEN** `attempts` is 1, `launches` is 2, and the next launch's brief carries the prior failure `leaseExpired`

### Requirement: Launch count for claimed and spawned launches
`launches` SHALL increase by one for every launch row, claimed or spawned.

#### Scenario: A launch row prepared for a claim counts
- **WHEN** a claimed launch's lease expires without progress and a new claimable launch is prepared for its task
- **THEN** the task's `launches` is 2

### Requirement: Runner failure diagnosis
A task whose launch's process ended without a report SHALL fail with reason `exitedWithoutReport`. When the runner can say why, its diagnosis SHALL be recorded as runner-provided detail on that reason, not as a new failure reason or state: the message SHALL be `<base message>: <reason>[: <detail>]` and `detail.runnerFailure` SHALL be `{ reason, detail? }`. The next attempt's brief SHALL carry it in the context from previous attempts, naming the reason and the detail.

#### Scenario: Diagnosis recorded on the failure
- **WHEN** a launch's process exits without a report and the runner diagnoses `unknownModel` with the error text as detail
- **THEN** the `launch.ended` event carries `runnerFailure` with that reason and detail, and the next brief's prior failure has kind `exitedWithoutReport`, a message naming `unknownModel` and the detail, and `detail.runnerFailure` set to `{ reason, detail }`

### Requirement: Codex runner reasons, 1 of 7: mcpStartupFailed
The Codex runner's reasons, in the order they are tried, SHALL be:
- `mcpStartupFailed`: a required MCP server that failed to start or initialize, from an error or from stderr; the detail is that line;

#### Scenario: A required MCP server failed to initialize
- **WHEN** the Codex runner reads a log with empty stdout and the probe's stderr, whose ERROR line says the required MCP servers failed to initialize
- **THEN** it returns `mcpStartupFailed` with that ERROR line as detail

### Requirement: Codex runner reasons, 2 of 7: authFailed
The Codex runner's reasons, in the order they are tried, SHALL be:
- `authFailed`: an error naming a 401, an unauthorized request, a missing login (`not logged in`, `codex login`), an invalid or missing API key, an expired token, or an authentication failure, error, or requirement. The bare word `authentication` SHALL NOT match: Codex prints `Using authentication from CODEX_HOME` on a normal run;

#### Scenario: A missing login
- **WHEN** the Codex runner reads a log whose `turn.failed` says `401 Unauthorized`, or whose stderr says ``Error: not logged in; run `codex login` ``
- **THEN** it returns `authFailed`, while a completed turn after the line `Using authentication from CODEX_HOME` gives no diagnosis

### Requirement: Codex runner reasons, 3 of 7: unknownModel
The Codex runner's reasons, in the order they are tried, SHALL be:
- `unknownModel`: an `error` event, an `error` item, or `turn.failed` saying the model does not exist or its metadata was not found; the detail names the model;

#### Scenario: Model metadata not found
- **WHEN** the Codex runner reads a log whose `error` item says ``Model metadata for `gpt-nope` not found.`` followed by `turn.failed`
- **THEN** it returns `unknownModel` with that message as detail

### Requirement: Codex runner reasons, 4 of 7: mcpApprovalRefused
The Codex runner's reasons, in the order they are tried, SHALL be:
- `mcpApprovalRefused`: a failed `mcp_tool_call` item whose error carries Codex's approval wording (`requires approval`, `approval policy`), as in `MCP tool call requires approval, but approval policy is never`; a tool error such as `EACCES: permission denied` SHALL NOT match. The refusal SHALL be diagnosed even when the turn completed afterwards, which is what Codex does;

#### Scenario: An EACCES tool error is not an approval refusal
- **WHEN** the Codex runner reads a log with a failed `mcp_tool_call` whose error is `EACCES: permission denied` and a completed turn
- **THEN** it gives no diagnosis, while the probe log with the refused `probe.probe_write` call gives `mcpApprovalRefused` naming it

### Requirement: Codex runner reasons, 5 of 7: sandboxDenied and turnFailed
The Codex runner's reasons, in the order they are tried, SHALL be:
- `sandboxDenied`: any failed `command_execution` item whose output says `Operation not permitted` (as for `.git` under `workspace-write`), not only the last one; the detail is that command and the line;
- `turnFailed`: any other `turn.failed` or `error`;

#### Scenario: The denied command is named
- **WHEN** the Codex runner reads a log whose failed `command_execution` for `git commit -m probe` says `Operation not permitted` and a later command succeeded
- **THEN** it returns `sandboxDenied` with the command and the denied line as detail

### Requirement: Codex runner reasons, 6 of 7: sandboxDenied from the agent and from stderr
The Codex runner's reasons, in the order they are tried, SHALL be:
- `sandboxDenied`, from the agent: when nothing above matched, an `agent_message` whose text says `Operation not permitted`, because the probes show Codex omitting the denied `git add` and `git commit` from the JSONL and leaving the error only in the agent's message; the detail is that line;
- `sandboxDenied`, from stderr: a stderr line saying `Operation not permitted` before any turn completed;

#### Scenario: Both git probes
- **WHEN** the Codex runner reads either real git probe log, in which no `command_execution` item failed
- **THEN** it returns `sandboxDenied` with the `fatal: Unable to create '...index.lock': Operation not permitted` line from the agent's message as detail

### Requirement: Codex runner reasons, 7 of 7: exitBeforeTurn
The Codex runner's reasons, in the order they are tried, SHALL be:
- `exitBeforeTurn`: no turn started and nothing above matched; the detail is the last stderr line that reads as an error (`error`, `fatal`, or `failed`), and there is no detail otherwise.

#### Scenario: An exit before any turn
- **WHEN** the Codex runner reads a log that holds only a banner and `Error: something went wrong`, or an empty log
- **THEN** it returns `exitBeforeTurn` with `Error: something went wrong` as detail for the first and with no detail for the second

### Requirement: OpenCode runner log
The OpenCode runner SHALL read the same kind of log as the Codex runner (`opencode run --format json` JSONL and the `--print-logs --log-level WARN` stderr in one file, the last 256 KiB). It SHALL strip ANSI colours from stderr lines and drop the `duplicate skill name` warnings OpenCode prints about the user's skill directories.

#### Scenario: Skill warnings are noise
- **WHEN** the OpenCode runner reads a log whose stderr holds only `duplicate skill name` warnings and whose JSONL holds a completed turn
- **THEN** it gives no diagnosis, and a log of only those warnings gives `exitBeforeTurn` without detail

### Requirement: OpenCode runner reasons, 1 of 5: mcpStartupFailed and unknownModel
The OpenCode runner's reasons, in the order they are tried, SHALL be:
- `mcpStartupFailed`: a WARN line `message="server unavailable" key=orchestrator`, even when the turn completed afterwards: the agent worked without the shim, so no report could reach the daemon; the detail is that line;
- `unknownModel`: an ERROR line (or `error` event message) matching `ProviderModelNotFoundError` or `Model not found`; the detail is the line's `error="..."` value, which names the model;

#### Scenario: Shim unavailable and model not found
- **WHEN** the OpenCode runner reads D4.err with D4.jsonl, or E-badmodel.jsonl with the ERROR line `ProviderModelNotFoundError: Model not found: opencode/gpt-bogus-9`
- **THEN** it returns `mcpStartupFailed` with the `server unavailable` line for the first and `unknownModel` naming `opencode/gpt-bogus-9` for the second

### Requirement: OpenCode runner reasons, 2 of 5: authFailed
The OpenCode runner's reasons, in the order they are tried, SHALL be:
- `authFailed`: an ERROR line (or `error` event message) naming a 401, an unauthorized request, an invalid or missing API key, an expired token, or an authentication failure, error, or requirement; the bare word `authentication` SHALL NOT match. No failed login was observed, so this pattern is carried over from the Codex runner;

#### Scenario: Invalid API key
- **WHEN** the OpenCode runner reads the ERROR line `error="AuthError: 401 Unauthorized: invalid api key"`
- **THEN** it returns `authFailed` with `AuthError: 401 Unauthorized: invalid api key` as detail, while an INFO line `using authentication from auth.json` before a completed turn gives no diagnosis

### Requirement: OpenCode runner reasons, 3 of 5: startupContended
The OpenCode runner's reasons, in the order they are tried, SHALL be:
- `startupContended`: no JSONL event at all and a stderr line `database is locked`: another opencode held the shared database at startup;

#### Scenario: Locked database only before the first event
- **WHEN** the OpenCode runner reads K2.err alone, and then K2.err after the JSONL of C2.jsonl
- **THEN** it returns `startupContended` with `database is locked` as detail for the first and no diagnosis for the second

### Requirement: OpenCode runner reasons, 4 of 5: permissionDenied
The OpenCode runner's reasons, in the order they are tried, SHALL be:
- `permissionDenied`: a `tool_use` part whose `state.error` says `rejected permission`, the detail naming the tool and the command; else a stderr line saying `auto-rejecting`, which is the detail. Only an `ask` gives this, which happens only when an operator overrides the ruleset with one.

#### Scenario: The auto-rejecting stderr line alone
- **WHEN** the OpenCode runner reads F1-ask.err alone
- **THEN** it returns `permissionDenied` with the line `! permission requested: bash (echo marker-7731); auto-rejecting` as detail

### Requirement: OpenCode runner reasons, 5 of 5: turnFailed and exitBeforeTurn
The OpenCode runner's reasons, in the order they are tried, SHALL be:
- `turnFailed`: any other `error` event; the detail is the `error="..."` value of the ERROR line that carries the event's `ref` when there is one, else the event's `error.data.message`;
- `exitBeforeTurn`: no JSONL event and nothing above matched; the detail is the last stderr line that reads as an error (`error`, `fatal`, or `failed`), and there is no detail otherwise.

#### Scenario: Error event with its ERROR line, and an exit before any event
- **WHEN** the OpenCode runner reads E-badmodel.jsonl with the line `level=ERROR run=e1 ref=err_8135f5fd error="SomeProviderError: boom"`, and then a log of only `level=INFO message=init`, `Error: spawn failed` and `bye`
- **THEN** it returns `turnFailed` with `SomeProviderError: boom` as detail for the first and `exitBeforeTurn` with `Error: spawn failed` as detail for the second

### Requirement: OpenCode probe facts: unknown model and unavailable MCP server
The OpenCode runner's reasons SHALL rest on these facts of opencode 1.18.30 (test/fixtures/opencode/events): an unknown model or provider gives only the opaque `error` event `Unexpected server error. Check server logs for details.` with a `ref` and exit 1, and the model is named only on the ERROR line; an MCP server that cannot start gives the WARN line, and the run completes without the tools and exits 0.

#### Scenario: The opaque error event alone
- **WHEN** the OpenCode runner reads E-badmodel.jsonl without the ERROR line, or D4.jsonl without D4.err
- **THEN** it returns `turnFailed` with `Unexpected server error. Check server logs for details.` as detail for the first and no diagnosis for the completed turn of the second

### Requirement: OpenCode probe facts: auto-rejected ask
The OpenCode runner's reasons SHALL rest on these facts of opencode 1.18.30 (test/fixtures/opencode/events): an auto-rejected `ask` gives the stderr line `permission requested: bash (<command>); auto-rejecting` and a `tool_use` part with `state.status: "error"`. The step then ends with `reason: "tool-calls"`, no further step starts, and the run exits 0, so the model never sees the refusal (F1-ask.jsonl, P-ask.jsonl).

#### Scenario: The ask probe ends the run
- **WHEN** the OpenCode runner reads P-ask.jsonl with P-ask.err, whose step ends with reason `tool-calls` and no further step
- **THEN** it returns `permissionDenied` naming `bash (uname -s)`

### Requirement: OpenCode deny refusal is not a diagnosis
A `deny` refusal ("The user has specified a rule which prevents you...") goes back to the model and the run goes on, so it SHALL NOT be a diagnosis. The OpenCode runner's reasons SHALL rest on these facts of opencode 1.18.30 (test/fixtures/opencode/events): A `deny` gives the `tool_use` error, then a further step in which the model goes on (P-deny.jsonl).

#### Scenario: Refusals the model continued past
- **WHEN** the OpenCode runner reads P-deny.jsonl, X-chain-offpattern.jsonl, X-pipe-offpattern.jsonl or X-whole-string.jsonl, each holding the deny error text
- **THEN** it gives no diagnosis for any of them

### Requirement: OpenCode probe facts: startup contention
The OpenCode runner's reasons SHALL rest on these facts of opencode 1.18.30 (test/fixtures/opencode/events): startup contention gives exit 1, no JSONL, and `Error: Unexpected error` then `database is locked` (4 of 23 concurrent starts, never after the first event).

#### Scenario: A contended start in another project
- **WHEN** the OpenCode runner reads SA-proj.err alone, which holds no JSONL event
- **THEN** it returns `startupContended` with `database is locked` as detail

### Requirement: No diagnosis from a completed run
When none of the OpenCode runner's reasons matched, a log with a `step_finish` part whose `reason` is `stop` SHALL give no diagnosis, as SHALL a log with events but no completed turn. A log whose turn completed with none of the Codex or OpenCode runner's reasons, or a missing log, SHALL give no diagnosis. A runner may give no diagnosis at all; the Claude Code runner gives none.

#### Scenario: Completed runs and missing logs
- **WHEN** the Codex runner reads G-events.jsonl, whose turn completed, or finds no log, and the OpenCode runner finds no log
- **THEN** each gives no diagnosis, and a runner without `readFailure` routed through the MultiRunner gives none either

### Requirement: Cancellation: offered verify jobs
Under `verifier.mode: remote`, cancelling a `submitted` task SHALL also drop, in the cancel's transaction, its verify job that is `checking` with an `offer` and holds no stored `result`, whether or not a verifier has claimed it. The daemon's run of that job SHALL then end with nothing recorded, and every verify job route SHALL answer 401 to its token. A job that holds a stored result SHALL NOT be dropped. Under `verifier.mode: local` a cancel SHALL drop only `queued` jobs.

#### Scenario: Claimed job without a result
- **WHEN** the daemon runs with `verifier.mode: remote` and a `submitted` task is cancelled while a verifier holds its offered job and no result is stored
- **THEN** the job is `dropped` and applied, the daemon's wait for it ends with nothing recorded, the verifier's heartbeat and result with the job's token are answered 401, and the integration branch does not move

#### Scenario: Job with a stored result
- **WHEN** the daemon runs with `verifier.mode: remote` and a `submitted` task is cancelled while its offered job holds a stored `verified` result
- **THEN** the job is not dropped, it is published, and its outcome is applied without a transition, so the task stays `cancelled`

#### Scenario: Local mode
- **WHEN** the daemon runs with `verifier.mode: local` and a `submitted` task is cancelled while its verifier job is `checking`
- **THEN** the job is not dropped, and its check runs on
