# Integration Pipeline Specification

## Purpose
Repository layout, one worktree per launch, the serialized verifier job pipeline (rebase, check, squash with trailers), compare-and-swap publication, conflict handling, foreign-commit detection, and milestone tagging, with the rebase replaying only the commits after the merge base of the integration head and the sealed sha and the published outcome recording the files it changed.

## Requirements

### Requirement: Repository layout
The orchestrator SHALL manage one repository per instance. Its primary clone SHALL keep the integration branch checked out and SHALL never be used for work. Each launch SHALL get its own worktree from the shared object store, in a directory named by the launch id, on the branch `task/<id>/l<launches>`. The worktree SHALL be removed after the launch ends and the branch SHALL be retained.

#### Scenario: Agent cannot check out the integration branch
- **WHEN** an agent runs `git checkout main` inside its worktree
- **THEN** git refuses because the branch is checked out in the primary clone

#### Scenario: Worktree removed, branch kept
- **WHEN** a launch ends for any reason
- **THEN** its worktree directory no longer exists and its branch still does

### Requirement: Base selection
A launch SHALL start from the integration head observed at claim time, recorded as `baseSha` in the lease and stated in the brief. Because every dependency is `done` before a task is ready, the base MUST already contain the dependencies' published work.

#### Scenario: Base contains dependencies
- **WHEN** T2 is launched after T1 was published
- **THEN** T2's `baseSha` is at or after T1's published commit

### Requirement: Verifier serialization and job states
The verifier SHALL process `submitted` tasks one at a time in submission order as durable jobs with states `queued`, `checking`, `verified`, `publishing`, `published`, `failed`, and `conflict`.

#### Scenario: Jobs are serialized
- **WHEN** two tasks are submitted within the same tick
- **THEN** the second job does not start until the first reaches a terminal state

### Requirement: Rebase and conflict handling
The verifier SHALL create a temporary worktree at the current integration head and rebase `sealedSha` onto it. On conflict the job SHALL end as `conflict`, `integrationRetries` SHALL increase, and while below the cap (default 3) the task SHALL return to `unstarted` with context naming the conflicting files, the tasks published since `baseSha`, and the previous branch; at the cap the task SHALL become `failed` with reason `integrationCapExceeded`.

#### Scenario: First conflict retries with context
- **WHEN** T2 and T3 both modify `shared.ts`, T3 is published first, and T2's rebase conflicts
- **THEN** T2 is `unstarted` with `integrationRetries` 1 and its next brief names `shared.ts`, T3, and branch `task/T2/l1`

#### Scenario: Cap exhausted
- **WHEN** a task conflicts for the fourth time with the cap at 3
- **THEN** the task is `failed` with reason `integrationCapExceeded`

### Requirement: Check and verified tree
The verifier SHALL run the configured check command with a timeout on the rebased tree and SHALL record the rebased head as `verifiedSha`. A non-zero exit or a timeout SHALL fail the task with the command output attached and SHALL increase `attempts`.

#### Scenario: Red check fails with output
- **WHEN** the check command exits non-zero
- **THEN** the task is `failed` with the captured output and the next brief includes it

#### Scenario: Timeout is a failure
- **WHEN** the check command exceeds its timeout
- **THEN** it is killed and the task is `failed` with reason `checkTimeout`

### Requirement: Squash with trailers
The verifier SHALL squash the rebased range into one commit whose tree is byte-identical to the verified tree and whose message is the report summary followed by the trailers `Orchestrator-Task: <id>` and `Orchestrator-Launch: <launchId>`.

#### Scenario: One commit per task
- **WHEN** a task with three commits on its branch is verified
- **THEN** the integration branch gains exactly one commit, its tree equals `verifiedSha`'s tree, and both trailers are present

### Requirement: Compare-and-swap publication
Publication SHALL update the integration ref with a compare-and-swap that expects the head observed when the job started. If the expected head no longer matches, the job SHALL return to `queued`. `publishedSha` and the task's `done` transition SHALL be recorded in one transaction.

#### Scenario: Head moved during verification
- **WHEN** another publication lands while a job is checking
- **THEN** the compare-and-swap fails and the job is requeued from the rebase step

#### Scenario: Done and published together
- **WHEN** publication succeeds
- **THEN** the same transaction records `publishedSha` and sets the task `done`

### Requirement: Foreign commit detection
A sweep SHALL flag any commit on the integration branch that lacks an `Orchestrator-Launch` trailer and SHALL report it in status.

#### Scenario: Manual commit flagged
- **WHEN** a person commits directly to the integration branch
- **THEN** the next sweep reports that commit as foreign

### Requirement: Milestone tagging
When a gated milestone becomes `submitted`, the orchestrator SHALL tag the pinned `integrationSha` as `milestone/<id>/v<reviewVersion>`. Tag creation SHALL be idempotent.

#### Scenario: Tag at the pinned sha
- **WHEN** MVP is submitted for review version 2
- **THEN** the tag `milestone/MVP/v2` points at MVP's `integrationSha`

#### Scenario: Repeated tagging is harmless
- **WHEN** tagging is retried after a crash
- **THEN** the tag still points at the same sha and no error is raised

### Requirement: Rebase from the merge base
The verifier SHALL rebase onto the integration head only the commits after the merge base of the head and `sealedSha`, and SHALL record on its published outcome the files changed between the expected head and the rebased sha, so that a branch the agent rebased onto a newer head verifies without replaying published commits and the base-moved notice can list what moved.

#### Scenario: Rebased branch verifies
- **WHEN** an agent rebases its launch branch onto the integration head after a `baseMoved` notice, commits one more change, and submits
- **THEN** verification publishes exactly one trailer commit containing only the agent's changes

#### Scenario: Changed files recorded
- **WHEN** a task is published with a commit touching `src/a.ts` and `README.md`
- **THEN** the job records `changedFiles` `["README.md", "src/a.ts"]`
