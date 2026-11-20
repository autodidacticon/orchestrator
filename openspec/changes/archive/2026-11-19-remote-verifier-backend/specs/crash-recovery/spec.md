## MODIFIED Requirements

### Requirement: Recovery of verifier jobs before publishing
In recovery on start:
- a verifier job in `queued`, `checking`, or `verified` SHALL have any temporary worktree removed and SHALL restart from `queued`, without `offer`, `verifier`, `token` and `result`, except the job that "Recovery of verifier jobs before publishing: offered job kept" keeps.

#### Scenario: Checking job restarts
- **WHEN** the daemon under `verifier.mode: local` restarts while a verifier job is `checking`
- **THEN** recovery removes the verifier's temporary worktrees and sets the job to `queued`

## ADDED Requirements

### Requirement: Recovery of verifier jobs before publishing: offered job kept
Under `verifier.mode: remote`, recovery SHALL leave unchanged an unapplied `checking` job that has an `offer` and either a stored `result` or a `verifier` whose lease runs past the recovery's clock. Every other `checking` or `verified` job SHALL go back to `queued` without `offer`, `verifier`, `token` and `result`. Under `verifier.mode: local` no job SHALL be kept.

#### Scenario: Live lease
- **WHEN** the daemon under `verifier.mode: remote` restarts while an offered job is claimed by a verifier whose lease has not run out
- **THEN** the job is still `checking` with its `offer`, `verifier` and `token`

#### Scenario: Stored result with an expired lease
- **WHEN** the daemon under `verifier.mode: remote` restarts while an offered job holds a stored result and its verifier's lease has run out
- **THEN** the job is still `checking` with its `result`

#### Scenario: Expired lease without a result
- **WHEN** the daemon under `verifier.mode: remote` restarts while an offered job's verifier lease has run out and no result is stored
- **THEN** the job is `queued` without `offer`, `verifier`, `token` and `result`

#### Scenario: Local mode
- **WHEN** the daemon under `verifier.mode: local` restarts while an offered job is claimed with a live lease
- **THEN** the job is `queued` without `offer`, `verifier`, `token` and `result`
