## ADDED Requirements

### Requirement: Origin lookup before commit lost
With `git.pushIntegration` on, recovery SHALL fetch origin before it decides any unapplied job in `queued`, `checking`, `verified` or `publishing`. A job whose `Orchestrator-Launch` trailer is on origin's integration branch SHALL be recorded `published` at that commit, whatever its status and whether or not its sealed commit is in the clone. Only a job with neither SHALL be `commitLost`. This takes precedence over "Startup on a fresh clone" and "Recovery per boundary".

#### Scenario: Landed while its record lagged
- **WHEN** the daemon starts on a fresh clone with a job stored as `checking`, `verified` or `publishing` whose launch trailer is on origin
- **THEN** the task is `done` at origin's commit, no `verify.commitLost` is recorded, and the task is not launched again

#### Scenario: Neither on origin nor in the clone
- **WHEN** origin answers, it lacks the launch trailer, and the sealed commit is not in the clone
- **THEN** the job is `commitLost` and the task is retried with attempts unchanged

### Requirement: Unreachable origin decides nothing
When origin cannot be fetched at recovery, no undecided job SHALL be published, pushed or dropped: each SHALL be queued, kept from the verifier, and decided by a later pass once origin answers.

#### Scenario: Origin cannot be fetched
- **WHEN** the daemon starts on a fresh clone and origin cannot be fetched
- **THEN** the job is still queued afterwards, is not handed to the verifier, and is decided once origin answers
