## ADDED Requirements

### Requirement: Origin as source of truth
The configuration block `git` SHALL hold `originUrl` (optional), `pushIntegration` (default `false`) and `fetchIntervalMs` (default 30000).

With `pushIntegration` off, no git command the orchestrator runs SHALL name or contact a remote.

With it on, the following SHALL hold:
- The remote `origin` of the daemon's clone SHALL be the source of truth for the integration branch. When `originUrl` is set, the remote SHALL be added or re-pointed to it before first use. When it is unset and the clone has no `origin`, every operation that needs origin SHALL fail naming the missing setting.
- All fetches and pushes of one daemon SHALL run one at a time. A fetch SHALL update `refs/remotes/origin/<branch>` only, without tags.
- Before a verifier job observes its expected head, the verifier SHALL fetch. A fetch that fails SHALL requeue the job without spending an attempt, and the `verify.requeued` event and the daemon log SHALL carry the reason.
- When the job's `Orchestrator-Launch` trailer is already on origin, the job SHALL be published at that commit without a further push. While a push of a squash is in flight, base selection SHALL NOT use that squash.
- Otherwise the verifier SHALL bring the clone's integration branch to origin's:
  - when the clone is behind, by a fast-forward that also updates the primary worktree;
  - when the clone is ahead or origin has no such branch, by pushing the clone's head with a lease;
  - when the two have diverged, the job SHALL fail with a message naming both shas and the clone SHALL NOT be reset.
- After a successful push, `refs/remotes/origin/<branch>` SHALL point at the pushed commit.

#### Scenario: Default contacts no remote
- **WHEN** a run with `git.pushIntegration` unset publishes a task and tags and accepts a gated milestone, in a clone whose `origin` transport records any contact
- **THEN** no contact is recorded

#### Scenario: Fresh clone matches
- **WHEN** three tasks are published with `git.pushIntegration` on against a bare origin
- **THEN** each task's trailer commit is on origin's integration branch, and a fresh clone of origin has the same first-parent history as the daemon's clone

#### Scenario: Earlier publications are pushed first
- **WHEN** pushing is turned on while the clone holds a published commit origin lacks
- **THEN** the next job pushes that commit before its own, and origin ends with both

#### Scenario: Diverged clone fails loudly
- **WHEN** the clone and origin each hold a commit the other lacks
- **THEN** the job fails naming both heads and the clone's branch is not moved

## MODIFIED Requirements

### Requirement: Repository layout
The orchestrator SHALL manage one repository per instance. Its primary clone SHALL keep the integration branch checked out and SHALL never be used for work. Each launch SHALL get its own worktree from the shared object store, in a directory named by the launch id, on the branch `task/<id>/l<launches>`. The worktree SHALL be removed after the launch ends and the branch SHALL be retained. With `git.pushIntegration` on, the clone SHALL have a remote `origin` whose integration branch is the source of truth (see "Origin as source of truth"); the clone's integration branch SHALL follow it and SHALL never hold a commit origin lacks except between a local compare-and-swap and its push.

#### Scenario: Agent cannot check out the integration branch
- **WHEN** an agent runs `git checkout main` inside its worktree
- **THEN** git refuses because the branch is checked out in the primary clone

#### Scenario: Worktree removed, branch kept
- **WHEN** a launch ends for any reason
- **THEN** its worktree directory no longer exists and its branch still does

### Requirement: Base selection
A launch SHALL start from the integration head observed at claim time, recorded as `baseSha` in the lease and stated in the brief. Because every dependency is `done` before a task is ready, the base MUST already contain the dependencies' published work. With `git.pushIntegration` on, the integration head SHALL be read from `refs/remotes/origin/<branch>`, fetched at most once per `git.fetchIntervalMs`, with a failed fetch keeping the last observed head; while the clone's branch is strictly ahead of origin's, the clone's head SHALL be used instead.

#### Scenario: Base contains dependencies
- **WHEN** T2 is launched after T1 was published
- **THEN** T2's `baseSha` is at or after T1's published commit

#### Scenario: Base follows origin
- **WHEN** a person pushes commit H to origin's integration branch while pushing is on
- **THEN** the next observed integration head is H

### Requirement: Compare-and-swap publication
Publication SHALL update the integration ref with a compare-and-swap that expects the head observed when the job started. If the expected head no longer matches, the job SHALL return to `queued`. With `git.pushIntegration` on, the expected head SHALL be origin's head after the job's fetch, and after the local compare-and-swap the verifier SHALL push the squash commit with `--force-with-lease=refs/heads/<branch>:<expectedHead>`; a push that is rejected or fails SHALL undo the local compare-and-swap and return the job to `queued`, so the next run rebases onto origin's new head. `publishedSha` and the task's `done` transition SHALL be recorded in one transaction.

#### Scenario: Head moved during verification
- **WHEN** another publication lands while a job is checking
- **THEN** the compare-and-swap fails and the job is requeued from the rebase step

#### Scenario: Done and published together
- **WHEN** publication succeeds
- **THEN** the same transaction records `publishedSha` and sets the task `done`

#### Scenario: Origin moved before publication
- **WHEN** a person pushes commit H to origin after T1 is verified and squashed but before it is pushed
- **THEN** the push fails its lease, the job is requeued once, and T1 is then published as a child of H on origin and in the clone, with both commits kept

### Requirement: Foreign commit detection
A sweep SHALL flag any commit on the integration branch that lacks an `Orchestrator-Launch` trailer and SHALL report it in status. With `git.pushIntegration` on, commits that arrive on origin are expected: the sweep SHALL consider only commits on the clone's integration branch that `refs/remotes/origin/<branch>` lacks.

#### Scenario: Manual commit flagged
- **WHEN** a person commits directly to the integration branch
- **THEN** the next sweep reports that commit as foreign

#### Scenario: Human commit on origin is expected
- **WHEN** a person pushes a commit without trailers to origin while pushing is on
- **THEN** the sweep does not report it, and a trailer-less commit made only in the daemon's clone is reported

### Requirement: Milestone tagging
When a gated milestone becomes `submitted`, the orchestrator SHALL tag the pinned `integrationSha` as `milestone/<id>/v<reviewVersion>`. Tag creation SHALL be idempotent. With `git.pushIntegration` on, the tag SHALL also be pushed to origin without force. The push outcome SHALL be returned and never thrown, so neither the tick nor recovery fails on it. The local tag SHALL be recorded as `tagged:<id>:<version>` once it exists, and the push separately as `tagPushed:<id>:<version>`. A push that fails SHALL be retried on every tick for a gated milestone in `submitted` or `done` until it lands. A tag that origin holds at another sha SHALL never be moved: it SHALL be reported once as a `milestone.tagConflict` event and not retried.

#### Scenario: Tag at the pinned sha
- **WHEN** MVP is submitted for review version 2
- **THEN** the tag `milestone/MVP/v2` points at MVP's `integrationSha`

#### Scenario: Repeated tagging is harmless
- **WHEN** tagging is retried after a crash
- **THEN** the tag still points at the same sha and no error is raised

#### Scenario: Accepted milestone tag on origin
- **WHEN** MVP is accepted at review version 1 while pushing is on, including after a tag push that failed while origin was unreachable
- **THEN** origin's `milestone/MVP/v1` points at MVP's reviewed `integrationSha`

#### Scenario: Conflicting tag is never moved
- **WHEN** origin already holds `milestone/MVP/v1` at another sha
- **THEN** that tag is unchanged, one `milestone.tagConflict` event is recorded, and a restart neither fails nor records another
