## ADDED Requirements

### Requirement: Fetch failures are classified
A failed fetch at the start of a verifier job SHALL be classified from git's output. Origin declining the credentials or the access is a refusal; anything else, a timeout included, is unreachable. A refused fetch SHALL count against `git.pushRefusalLimit`, with a message saying the fetch was refused, and SHALL block the task as `pushRefused` at the limit. An unreachable fetch MUST NOT count.

#### Scenario: An expired credential blocks the task
- **WHEN** every fetch fails with "Authentication failed", and `git.pushRefusalLimit` is 3
- **THEN** the job is requeued twice as a refusal, and the third refusal blocks the task with kind `pushRefused` and a message that says the fetch was refused and holds "Authentication failed", with `attempts` unchanged

#### Scenario: An unreachable origin is retried without a limit
- **WHEN** the fetch cannot reach origin more times than `git.pushRefusalLimit`
- **THEN** each failure requeues the job as unreachable with no refusal counted, and the task stays `submitted` and publishes once origin answers

### Requirement: A slow tag push is confirmed when it completes
A milestone tag push the tick starts and stops waiting for SHALL be kept with its outcome. A later tag call for the same tag and sha SHALL use that push rather than start another. While the push runs, the call SHALL wait on it within the tick's bound. Once it has landed, the call SHALL answer pushed without pushing again, and the tag SHALL be recorded as `tagPushed:<id>:<version>`. Once it has failed, the call SHALL push again.

#### Scenario: Every tag push outlives the tick's wait
- **WHEN** origin takes longer than the tick's wait to accept every tag push
- **THEN** the tag is recorded as pushed after its first push completes, and origin receives that one push only

### Requirement: A failed local tag is retried
With `git.pushIntegration` off, a tag created in the clone for a gated milestone SHALL be recorded as `tagLocal:<id>:<version>`. On every tick, a gated milestone in `submitted` or `done` with no such record and no recorded conflict SHALL have its tag created in the clone again, idempotently. A conflict SHALL still be recorded once and not retried.

#### Scenario: The tag could not be created when the milestone was submitted
- **WHEN** a gated milestone is submitted with pushing off while `git tag` fails in the clone, and the failure later clears
- **THEN** a later tick creates `milestone/<id>/v<version>` at the milestone's `integrationSha` and records it as `tagLocal:<id>:<version>`

### Requirement: Push retry state ends with its job
The push retry state the store keeps for a verifier job (`pushRetry:<jobId>`) SHALL be removed when the job's result is applied, in the same transaction. Whatever the outcome (published, conflict, failed or `pushRefused`), no later read SHALL find retry state for that job. Because the store offers no kv delete, the entry SHALL be emptied, and an empty entry SHALL read as no state.

#### Scenario: A job published after outages
- **WHEN** a job is requeued for an unreachable origin and later publishes
- **THEN** once the job is applied, reading its push retry state finds none
