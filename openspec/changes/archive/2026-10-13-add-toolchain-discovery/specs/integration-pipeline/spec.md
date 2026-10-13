## MODIFIED Requirements

### Requirement: Check and verified tree
The verifier SHALL run the effective check command, read when the job starts checking, with a timeout on the rebased tree and SHALL record the rebased head as `verifiedSha`. A non-zero exit or a timeout SHALL fail the task with the command output attached and SHALL increase `attempts`. While `checkCommand` is unresolved, a `queued` job whose sealed sha differs from its base sha SHALL NOT start checking: it SHALL stay `queued` with its sealed sha, the task SHALL stay `submitted`, `status` and the digest SHALL name `checkCommand` under `needsConfig`, and the job SHALL start on the first tick after a check command is set. A `queued` job whose sealed sha equals its base sha, a declared no-op, SHALL NOT be held: the verifier never reaches the check step for it, so it SHALL verify and publish at once. A job already `checking` when the command changes SHALL finish with the command it started with. The check command SHALL apply in every runner mode.

#### Scenario: Red check fails with output
- **WHEN** the check command exits non-zero
- **THEN** the task is `failed` with the captured output and the next brief includes it

#### Scenario: Timeout is a failure
- **WHEN** the check command exceeds its timeout
- **THEN** it is killed and the task is `failed` with reason `checkTimeout`

#### Scenario: Unresolved command holds the job
- **WHEN** T1 is submitted while `checkCommand` is unresolved
- **THEN** T1's job stays `queued`, T1 stays `submitted`, no attempt is spent, and `needsConfig` names `checkCommand`

#### Scenario: Held job runs once the command is set
- **WHEN** the operator sets `checkCommand` to `npm test` while T1's job is held
- **THEN** the next tick runs `npm test` on T1's rebased tree and, when it passes, publishes T1's sealed work

#### Scenario: Declared no-op needs no command
- **WHEN** T1 is submitted with `noChanges` and no commits ahead of `baseSha` while `checkCommand` is unresolved
- **THEN** T1's job runs at once, publishes no commit, and T1 is `done` without any command being run
