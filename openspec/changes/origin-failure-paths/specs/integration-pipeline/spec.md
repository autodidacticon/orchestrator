## ADDED Requirements

### Requirement: Remote commands are bounded
With `git.pushIntegration` on, every git command that talks to origin (fetch, push, `ls-remote`) SHALL run in its own process group. When it has not finished within `git.remoteTimeoutMs` (default 120000; 0 disables the bound), the whole group SHALL be killed. A killed command SHALL be reported as a failure that names the timeout, and SHALL count as an unreachable origin.

#### Scenario: A stalled push is killed
- **WHEN** origin accepts a push connection and never answers, and `git.remoteTimeoutMs` is 2000
- **THEN** after 2000 ms the push and the process origin started for it are killed, and the job is requeued with a reason that says the push timed out

#### Scenario: A stalled fetch fails
- **WHEN** a fetch does not answer within `git.remoteTimeoutMs`
- **THEN** it is killed and reported as a failed fetch, and origin's queue is free again

### Requirement: The tick never waits for origin
While a remote command is queued or running, the tick MUST NOT wait for it: base selection SHALL keep the last fetched head, and a milestone tag push SHALL be left for a later tick. A fetch or tag push the tick starts itself SHALL be awaited at most a short bound (1 s); it runs on, bounded by `git.remoteTimeoutMs`. Startup recovery SHALL await its fetch in full.

#### Scenario: The tick keeps running during a stalled push
- **WHEN** the verifier's push is stalled
- **THEN** a tick returns without waiting for it, and base selection reads the last fetched head

#### Scenario: The tick's own fetch stalls
- **WHEN** origin stops answering fetches and nothing else is talking to it
- **THEN** base selection returns within the short bound with the last fetched head, and the fetch is killed at `git.remoteTimeoutMs`

### Requirement: Push failures are classified
A failed push of the integration branch SHALL be classified from git's output (`LC_ALL=C`). A lost lease is a `stale info` rejection. A refusal is origin declining the push: a rejected ref, a hook, failed authentication, or missing permission. Anything else, a timeout included, is an unreachable origin. Every failed push SHALL undo the clone's local swap. A lost lease SHALL requeue the job at once, with no backoff and no refusal counted.

#### Scenario: A lost lease is not a refusal
- **WHEN** origin moved between the job's fetch and its push
- **THEN** the job is requeued at once, with no backoff and no refusal counted

#### Scenario: A hook rejection is a refusal
- **WHEN** origin's pre-receive hook declines the push
- **THEN** the push is classified as a refusal, and the clone's branch is back at the job's expected head

### Requirement: Push retry backoff
A refused push, an unreachable origin, and a failed fetch at the start of a job SHALL requeue the job after a backoff. The backoff is `git.pushRetryBackoffMs` (default 30000), doubled for each earlier retry of the job, and at most 32 times the base. The job MUST NOT be started again before its backoff ends. The counts and the next retry time SHALL be kept per verifier job in the store's key-value table.

#### Scenario: An outage never blocks
- **WHEN** origin cannot be reached for many retries
- **THEN** each retry waits a longer backoff, up to 32 times the base, and the task stays `submitted`

### Requirement: Push refusal limit
Refusals SHALL be counted per verifier job. When a job's refusals reach `git.pushRefusalLimit` (default 5), the job SHALL fail with kind `pushRefused`. Its task SHALL then go from `submitted` to `blocked` with blocked kind `pushRefused` and the refusal's text as the message, and no attempt is spent. An unreachable origin MUST NOT count toward the limit.

#### Scenario: A protected branch blocks the task
- **WHEN** origin's pre-receive hook rejects every push with "Protected branch update failed", and `git.pushRefusalLimit` is 3
- **THEN** the job is requeued twice, each time after a longer backoff, and the third refusal blocks the task with kind `pushRefused` and a message holding origin's text, with `attempts` unchanged

### Requirement: Catch-up push publishes publications only
When the clone's integration branch is ahead of origin's at the start of a job, the verifier SHALL push it only if every commit origin lacks (first-parent, after the baseline) carries an `Orchestrator-Launch` trailer. A commit without one MUST NOT be pushed. It stays reported as foreign, and the job counts a refusal whose message names the commits.

#### Scenario: A commit made by hand in the clone is not pushed
- **WHEN** a trailer-less commit is made in the daemon's clone after the baseline, and a job starts
- **THEN** origin does not receive it, the commit is listed in `foreignCommits`, and the task is blocked as `pushRefused` once the refusal limit is reached

#### Scenario: Publications from before pushing was on are pushed
- **WHEN** the clone holds commits from before the baseline that origin lacks
- **THEN** the catch-up push sends them and the job verifies on top of them

### Requirement: Catch-up of the job's own squash
If the job's own launch trailer is on the clone's tip when the clone is ahead of origin, the catch-up push SHALL publish that commit as the job's publication. The job's sealed branch MUST NOT be rebased onto its own squash.

#### Scenario: The job's own squash at the tip
- **WHEN** the clone's tip is the job's own squash and origin is at the squash's parent
- **THEN** the catch-up push publishes the squash and the job is `published` at it, without a rebase

### Requirement: Milestone tag conflicts never throw
Tagging a milestone MUST NOT throw. When the clone already holds `milestone/<id>/v<n>` at another sha, for example a tag that `git clone` brought from origin, the tag SHALL NOT be moved or pushed, and the outcome SHALL be a conflict found in the clone. A conflict on origin SHALL be reported the same way, as found on origin. This applies with `git.pushIntegration` on or off.

#### Scenario: A tag in the clone at another sha
- **WHEN** a gated milestone is submitted and the clone holds its tag at another sha
- **THEN** the tick completes, and the tag still points at its old sha in the clone and on origin

### Requirement: Tag conflicts are recorded once
The tick, the milestone tag push and recovery SHALL record a tag outcome through one path. A conflict SHALL append one `milestone.tagConflict` event (with `sha`, `remoteSha` and `where`) and set `tagPushed:<id>:<n>` to `conflict:<sha>`. A recorded conflict MUST NOT be recorded again or retried.

#### Scenario: Recovery meets the conflict
- **WHEN** the daemon is killed after tagging a submitted milestone and before recording it, and the clone holds the tag at another sha
- **THEN** recovery completes and records one conflict with `where: clone`, and later ticks and restarts record no second conflict
