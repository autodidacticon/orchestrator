## MODIFIED Requirements

### Requirement: Access modes
A run SHALL have one access, the file key `runner.access`, `local` or `remote`, default `local`, read at start; it SHALL NOT be a runtime override. `local` means the worker runs on the daemon's machine, reaches the loopback API, and works in the worktree the daemon prepared. `remote` means the worker runs elsewhere and gets no worktree from the daemon (see specs/remote-workspace). Any other value SHALL fail configuration loading with a message naming `runner.access`. The daemon SHALL refuse to start with `runner.access: remote` unless the runner mode in force is `pull`, `git.pushIntegration` is true, and `prepareCommand` is unset, with one message naming each unmet condition; on a remote run `PUT /v1/runner` SHALL refuse any mode other than `pull` with 409. Every launch row SHALL carry the run's access in `access`, set when the row is created and never changed; a row without it is `local`. A claim's `access` SHALL be `local` or `remote` and SHALL default to `local`; any other value SHALL be answered 400. A claim whose `access` differs from the run's SHALL be answered 409 with `reason`, `access` and `runAccess`, and SHALL change no launch.

#### Scenario: Local is the default
- **WHEN** a claim omits `access`
- **THEN** it is treated as `local`

#### Scenario: Remote worker on a local run
- **WHEN** a worker claims with `access: 'remote'` on a run whose `runner.access` is `local`
- **THEN** the response is 409 with `access: 'remote'` and `runAccess: 'local'`, and the claimable launch stays `claimable`

#### Scenario: Local worker on a remote run
- **WHEN** a worker claims with `access: 'local'`, or without `access`, on a run whose `runner.access` is `remote`
- **THEN** the response is 409 with `access: 'local'` and `runAccess: 'remote'`, and the claimable launch stays `claimable` with no worker

#### Scenario: Remote run in spawn mode refused
- **WHEN** the daemon starts with `runner.access: remote`, `runner.mode: spawn`, `git.pushIntegration: false` and `prepareCommand` set
- **THEN** startup fails with a message naming `runner.mode`, `git.pushIntegration` and `prepareCommand`, and no launch is created

#### Scenario: Launch rows carry the access
- **WHEN** a local run admits a task
- **THEN** its launch row has `access: 'local'` and a worktree path
