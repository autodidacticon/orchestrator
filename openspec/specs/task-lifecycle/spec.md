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

### Requirement: Leases
A `running` or `waiting` task SHALL hold a lease recording `launchId`, `token`, `claimedAt`, `spawnedAt`, `expiresAt`, `baseSha`, and `graphRev`. A heartbeat, any API call, and an open long-poll SHALL renew the lease. For a launch whose process the daemon can observe, the daemon SHALL also renew the lease on every tick while the runner reports the process alive, including the first tick after adoption, so that the lease TTL bounds silence only for launches the daemon cannot observe. The orchestrator SHALL treat an expired lease on a `running` task as failure with reason `leaseExpired`. Silence from a live process SHALL NOT fail the task; it is handled by stuck detection.

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

#### Scenario: One automatic retry with context
- **WHEN** a task fails on its first attempt
- **THEN** it is relaunched and the new brief contains the prior failure report

#### Scenario: Exhaustion blocks
- **WHEN** a task fails on its second attempt with `maxAttempts` at 2
- **THEN** it becomes `blocked` and appears in `stallRoots`

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

### Requirement: Cancellation
A human SHALL be able to cancel any node that is not `done` or `cancelled`, supplying a reason and `releasesDependents` (default false). Cancelling a `running` or `waiting` task SHALL cause the orchestrator to reap its process on the next tick, and cancelling a `submitted` task SHALL drop its queued verifier job.

#### Scenario: Cancel a running task
- **WHEN** a human cancels a running task
- **THEN** the task is `cancelled`, its process is terminated within one tick, and its branch is retained

#### Scenario: Release lets dependents proceed
- **WHEN** T1 is cancelled with `releasesDependents: true`
- **THEN** T2 and T3 become ready and their briefs state that T1 was cancelled and why

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

### Requirement: Health failure reasons
A `running` task SHALL become `failed` with reason `stuck` when stuck detection escalates and with reason `timeBudget` when its launch exceeds the launch time budget. Both SHALL use the orchestrator's `running -> failed` transition, SHALL increase `attempts`, and SHALL follow the retry and exhaustion rules like any other failure, so the next brief carries the reason as the prior failure.

A task whose launch's process ended without a report SHALL fail with reason `exitedWithoutReport`. When the runner can say why, its diagnosis SHALL be recorded as runner-provided detail on that reason, not as a new failure reason or state: the message SHALL be `<base message>: <reason>[: <detail>]` and `detail.runnerFailure` SHALL be `{ reason, detail? }`. The next attempt's brief SHALL carry it in the context from previous attempts, naming the reason and the detail. The Codex runner's reasons, in the order they are tried, are:
- `mcpStartupFailed`: a required MCP server that failed to start or initialize, from an error or from stderr; the detail is that line;
- `authFailed`: an error naming a 401, an unauthorized request, a missing login (`not logged in`, `codex login`), an invalid or missing API key, an expired token, or an authentication failure, error, or requirement. The bare word `authentication` SHALL NOT match: Codex prints `Using authentication from CODEX_HOME` on a normal run;
- `unknownModel`: an `error` event, an `error` item, or `turn.failed` saying the model does not exist or its metadata was not found; the detail names the model;
- `mcpApprovalRefused`: a failed `mcp_tool_call` item whose error carries Codex's approval wording (`requires approval`, `approval policy`), as in `MCP tool call requires approval, but approval policy is never`; a tool error such as `EACCES: permission denied` SHALL NOT match. The refusal SHALL be diagnosed even when the turn completed afterwards, which is what Codex does;
- `sandboxDenied`: any failed `command_execution` item whose output says `Operation not permitted` (as for `.git` under `workspace-write`), not only the last one; the detail is that command and the line;
- `turnFailed`: any other `turn.failed` or `error`;
- `sandboxDenied`, from the agent: when nothing above matched, an `agent_message` whose text says `Operation not permitted`, because the probes show Codex omitting the denied `git add` and `git commit` from the JSONL and leaving the error only in the agent's message; the detail is that line;
- `sandboxDenied`, from stderr: a stderr line saying `Operation not permitted` before any turn completed;
- `exitBeforeTurn`: no turn started and nothing above matched; the detail is the last stderr line that reads as an error (`error`, `fatal`, or `failed`), and there is no detail otherwise.

A log whose turn completed with none of these, or a missing log, SHALL give no diagnosis. A runner may give no diagnosis at all; the Claude Code runner gives none.

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

#### Scenario: Runner without a diagnosis
- **WHEN** the launch's runner does not implement `readFailure`
- **THEN** the task fails with reason `exitedWithoutReport` and the message `process exited without a report`, as before

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
