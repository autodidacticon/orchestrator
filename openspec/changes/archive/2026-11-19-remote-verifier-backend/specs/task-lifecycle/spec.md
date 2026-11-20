## ADDED Requirements

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
